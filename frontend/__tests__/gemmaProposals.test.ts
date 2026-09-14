import { ProposalStore, proposalDigest, PROPOSAL_TTL_MS } from '../src/accountingV2/gemma/proposalStore';
import { createProposalExecutor, cancelProposal, type ExecutorPorts } from '../src/accountingV2/gemma/proposalExecutor';
import {
  PROPOSAL_DESCRIPTORS, descriptor, createProposalTools, proposalTool, type PreparePorts,
} from '../src/accountingV2/gemma/proposalRegistry';
import { ASSISTANT_PROPOSAL_TYPES, MAX_AI_AMOUNT } from '../src/accountingV2/aiActions';
import { createAgent, validate, type Draft, type Engine, type Frame, type Obj, type Scope, type ToolContext } from '../src/accountingV2/gemma/agentCore';
import { schemaSql } from '../src/db/schema';
import { makeNodeRunner } from './helpers/nodeRunner';

const scope: Scope = {
  bookId: 'book-a', locationId: null, actorId: 'local-owner', permissionEpoch: 'p1',
  featureEpoch: 'f1', revision: 'r1', currency: 'INR', basis: 'accrual',
  today: '2026-09-08', timeZone: 'Asia/Calcutta',
};

/**
 * A real SQLite database running the app's actual schema, via the same
 * node:sqlite adapter the other suites use. The proposal table, its CHECK
 * constraint and its UNIQUE index are therefore the ones that ship.
 */
async function freshStore(now: () => Date = () => new Date('2026-09-08T10:00:00Z')) {
  const { runner: db } = makeNodeRunner();
  await db.exec(schemaSql());
  return { db, store: new ProposalStore(db, now) };
}

const draftInput = (over: Partial<Parameters<ProposalStore['create']>[0]> = {}) => ({
  id: 'prop-1',
  requestId: 'request-1',
  operation: 'add_expense',
  normalized: { amount: 125, date: '2026-09-08' } as Obj,
  scope,
  entityVersions: {},
  ...over,
});

test('simultaneous confirmations across stores sharing a connection post once', async () => {
  const { db, store } = await freshStore();
  await store.create(draftInput());
  const apply = jest.fn(async (_operation, _normalized, _scope, transactionDb) => {
    expect(transactionDb).toBe(db);
    await Promise.resolve();
    return { id: 'expense-once' };
  });
  const secondStore = new ProposalStore(db, () => new Date('2026-09-08T10:00:00Z'));
  const a = createProposalExecutor(store, ports({ apply }));
  const b = createProposalExecutor(secondStore, ports({ apply }));
  const results = await Promise.all([a('prop-1'), b('prop-1'), a('prop-1')]);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(results).toEqual([
    { kind: 'applied', result: { id: 'expense-once' }, replayed: false },
    { kind: 'applied', result: { id: 'expense-once' }, replayed: true },
    { kind: 'applied', result: { id: 'expense-once' }, replayed: true },
  ]);
});

test('an applied result cannot be replayed into another book or actor', async () => {
  const { store } = await freshStore();
  await store.create(draftInput());
  await createProposalExecutor(store, ports())('prop-1');
  for (const changed of [{ ...scope, bookId: 'other' }, { ...scope, actorId: 'other' }]) {
    const apply = jest.fn();
    expect(await createProposalExecutor(store, ports({ currentScope: async () => changed, apply }))('prop-1'))
      .toEqual({ kind: 'rejected', code: 'STALE_SCOPE' });
    expect(apply).not.toHaveBeenCalled();
  }
});

test('expiry during asynchronous permission checks prevents a domain write', async () => {
  let clock = new Date('2026-09-08T10:00:00Z');
  const { store } = await freshStore(() => clock);
  await store.create(draftInput({ ttlMs: 1000 }));
  const apply = jest.fn();
  const confirm = createProposalExecutor(store, ports({
    isPeriodOpen: async () => { clock = new Date('2026-09-08T10:00:02Z'); return true; }, apply,
  }));
  expect(await confirm('prop-1')).toEqual({ kind: 'rejected', code: 'PROPOSAL_EXPIRED' });
  expect(apply).not.toHaveBeenCalled();
});

function ports(over: Partial<ExecutorPorts> = {}): ExecutorPorts {
  return {
    currentScope: async () => scope,
    entityRevisions: async (ids) => Object.fromEntries(ids.map((id) => [id, 'rev-1'])),
    isPeriodOpen: async () => true,
    canApply: async () => true,
    apply: async () => ({ id: 'expense-1', journalId: 'j-1' }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

test('the shipped schema creates the proposal table with its constraints', async () => {
  const { db, store } = await freshStore();
  await store.create(draftInput());
  // The CHECK constraint is real, not decorative.
  await expect(db.run(
    `INSERT INTO assistant_proposals (id, book_id, actor_id, request_id, operation,
      normalized_json, scope_json, entity_versions_json, digest, expires_at, state, created_at)
     VALUES ('x','book-a','a','r2','add_expense','{}','{}','{}','d','2026-09-08T11:00:00Z','posted','2026-09-08T10:00:00Z')`,
  )).rejects.toThrow();
});

test('one turn cannot leave two confirmable drafts behind', async () => {
  const { store } = await freshStore();
  await store.create(draftInput());
  // UNIQUE(book_id, request_id): a model that emitted two writes gets one draft.
  await expect(store.create(draftInput({ id: 'prop-2' }))).rejects.toThrow();
});

test('a stored proposal round-trips without losing its scope or payload', async () => {
  const { store } = await freshStore();
  const created = await store.create(draftInput({ entityVersions: { 'inv-1': 'rev-9' } }));
  const found = await store.find('prop-1');
  expect(found).toEqual(created);
  expect(found!.scope).toEqual(scope);
  expect(found!.normalized).toEqual({ amount: 125, date: '2026-09-08' });
  expect(found!.entityVersions).toEqual({ 'inv-1': 'rev-9' });
  expect(found!.state).toBe('pending');
  expect(found!.result).toBeNull();
});

test('the digest is stable across key order and changes with content', () => {
  const base = { operation: 'add_expense', normalized: { amount: 125, date: '2026-09-08' } as Obj, scope, entityVersions: {} };
  const reordered = { operation: 'add_expense', normalized: { date: '2026-09-08', amount: 125 } as Obj, scope, entityVersions: {} };
  expect(proposalDigest(base)).toBe(proposalDigest(reordered));
  expect(proposalDigest({ ...base, normalized: { amount: 126, date: '2026-09-08' } })).not.toBe(proposalDigest(base));
  expect(proposalDigest({ ...base, operation: 'add_sale' })).not.toBe(proposalDigest(base));
  expect(proposalDigest({ ...base, scope: { ...scope, bookId: 'book-b' } })).not.toBe(proposalDigest(base));
  expect(proposalDigest({ ...base, entityVersions: { 'inv-1': 'rev-2' } })).not.toBe(proposalDigest(base));
});

// ---------------------------------------------------------------------------
// B5: no confirmation, no writes
// ---------------------------------------------------------------------------

test('B5: preparing a proposal performs no domain write, party create or outbox entry', async () => {
  const { db, store } = await freshStore();
  const apply = jest.fn();
  const prepared: Draft = {
    operation: 'add_expense', normalized: { amount: 125 }, preview: 'Expense INR 125.00',
    destructive: false, entityVersions: {},
  };
  const preparePorts: PreparePorts = {
    canPrepare: async () => true,
    prepare: async () => prepared,
  };
  const context: ToolContext = {
    scope, signal: new AbortController().signal, assertCurrent: async () => undefined,
  };
  const tool = proposalTool(descriptor('add_expense'), preparePorts);
  const draft = await tool.prepare({ amount: 125 }, context);
  expect(draft.preview).toContain('125');

  // Integration-level proof rather than a disconnected mock: nothing reached
  // the ledger tables, no party appeared, and the sync outbox is untouched.
  createProposalExecutor(store, ports({ apply }));
  expect(apply).not.toHaveBeenCalled();
  for (const table of ['v2_journal_entries', 'v2_journal_lines', 'v2_sources', 'v2_parties', 'sync_outbox', 'expenses']) {
    const rows = await db.all(`SELECT * FROM ${table}`);
    expect(rows).toHaveLength(0);
  }
  // And no draft was stored either: preparing does not persist by itself.
  expect(await db.all('SELECT * FROM assistant_proposals')).toHaveLength(0);
});

test('B5: storing a draft is not an accounting change', async () => {
  const { db, store } = await freshStore();
  await store.create(draftInput());
  for (const table of ['v2_journal_entries', 'v2_journal_lines', 'v2_parties', 'sync_outbox']) {
    expect(await db.all(`SELECT * FROM ${table}`)).toHaveLength(0);
  }
});

// ---------------------------------------------------------------------------
// B6: exactly once
// ---------------------------------------------------------------------------

test('B6: a confirmed proposal posts once and repeat confirmations replay the result', async () => {
  const { store } = await freshStore();
  await store.create(draftInput());
  const apply = jest.fn(async () => ({ id: 'expense-1' }));
  const confirm = createProposalExecutor(store, ports({ apply }));

  const first = await confirm('prop-1');
  expect(first).toEqual({ kind: 'applied', result: { id: 'expense-1' }, replayed: false });

  // A double tap, a retry after an unknown outcome, a process restart.
  const second = await confirm('prop-1');
  const third = await confirm('prop-1');
  expect(second).toEqual({ kind: 'applied', result: { id: 'expense-1' }, replayed: true });
  expect(third.kind).toBe('applied');
  expect(apply).toHaveBeenCalledTimes(1);
});

test('B6: a confirmation is only ever addressed by id', async () => {
  const { store } = await freshStore();
  await store.create(draftInput());
  const confirm = createProposalExecutor(store, ports());
  // The signature takes one string. If it accepted replacement params the
  // reviewed preview and the posted action could differ.
  expect(confirm.length).toBe(1);
  expect((await confirm('prop-1')).kind).toBe('applied');
});

test('B6: an unknown or malformed id is rejected, never guessed', async () => {
  const { store } = await freshStore();
  const confirm = createProposalExecutor(store, ports());
  expect(await confirm('')).toEqual({ kind: 'rejected', code: 'INVALID_PROPOSAL_ID' });
  expect(await confirm('prop-missing')).toEqual({ kind: 'rejected', code: 'PROPOSAL_NOT_FOUND' });
});

// ---------------------------------------------------------------------------
// B7: rollback
// ---------------------------------------------------------------------------

test('B7: a failed post rolls back the state change with it', async () => {
  const { store } = await freshStore();
  await store.create(draftInput());
  const confirm = createProposalExecutor(store, ports({
    apply: async () => { throw new Error('posting failed after the party was created'); },
  }));
  expect(await confirm('prop-1')).toEqual({ kind: 'rejected', code: 'COMMIT_FAILED' });
  // Still pending, never applied: nothing may claim to have been recorded.
  const after = await store.find('prop-1');
  expect(after!.state).toBe('pending');
  expect(after!.result).toBeNull();
});

test('B7: a party materialized during a failed apply is rolled back', async () => {
  const { db, store } = await freshStore();
  await store.create(draftInput());
  const confirm = createProposalExecutor(store, ports({
    apply: async () => {
      // The existing pre-confirm-handler pattern materializes a party first.
      await db.run(
        `INSERT INTO v2_parties (id, book_id, name, roles, created_at)
         VALUES ('party-orphan','book-a','Amit Traders','["supplier"]','2026-09-08T10:00:00Z')`,
      );
      throw new Error('journal posting failed');
    },
  }));
  expect((await confirm('prop-1')).kind).toBe('rejected');
  // The orphan party is the specific failure this savepoint exists to prevent.
  expect(await db.all("SELECT * FROM v2_parties WHERE id = 'party-orphan'")).toHaveLength(0);
});

test('B7: a domain result with no identifier is refused rather than reported as recorded', async () => {
  const { store } = await freshStore();
  await store.create(draftInput());
  const confirm = createProposalExecutor(store, ports({ apply: async () => ({}) }));
  expect(await confirm('prop-1')).toEqual({ kind: 'rejected', code: 'DOMAIN_RETURNED_NO_RESULT' });
  expect((await store.find('prop-1'))!.state).toBe('pending');
});

// ---------------------------------------------------------------------------
// B8 / A11: staleness
// ---------------------------------------------------------------------------

test('B8: an expired proposal cannot be confirmed', async () => {
  let now = new Date('2026-09-08T10:00:00Z');
  const { store } = await freshStore(() => now);
  await store.create(draftInput());
  now = new Date(now.getTime() + PROPOSAL_TTL_MS + 1000);
  const confirm = createProposalExecutor(store, ports());
  expect(await confirm('prop-1')).toEqual({ kind: 'rejected', code: 'PROPOSAL_EXPIRED' });
  expect((await store.find('prop-1'))!.state).toBe('expired');
});

test('B8: a cancelled proposal cannot be confirmed', async () => {
  const { store } = await freshStore();
  await store.create(draftInput());
  await cancelProposal(store, 'prop-1');
  const confirm = createProposalExecutor(store, ports());
  expect(await confirm('prop-1')).toEqual({ kind: 'rejected', code: 'PROPOSAL_CANCELLED' });
});

test('B8: a tampered stored row is refused by the digest check', async () => {
  const { db, store } = await freshStore();
  await store.create(draftInput());
  // Someone edited the amount in the row after the user reviewed the preview.
  await db.run("UPDATE assistant_proposals SET normalized_json = ? WHERE id = 'prop-1'", ['{"amount":99999}']);
  const apply = jest.fn();
  const confirm = createProposalExecutor(store, ports({ apply }));
  expect(await confirm('prop-1')).toEqual({ kind: 'rejected', code: 'PROPOSAL_TAMPERED' });
  expect(apply).not.toHaveBeenCalled();
});

test('A3/B8: a book switch, actor change or role change invalidates a pending proposal', async () => {
  const apply = jest.fn();
  for (const [field, value, code] of [
    ['bookId', 'book-b', 'STALE_SCOPE'],
    ['actorId', 'someone-else', 'STALE_SCOPE'],
    ['permissionEpoch', 'p2', 'STALE_SCOPE'],
    ['revision', 'r2', 'STALE_SCOPE'],
    ['locationId', 'loc-9', 'STALE_SCOPE'],
  ] as const) {
    const { store } = await freshStore();
    await store.create(draftInput());
    const confirm = createProposalExecutor(store, ports({
      apply, currentScope: async () => ({ ...scope, [field]: value }),
    }));
    expect(await confirm('prop-1')).toEqual({ kind: 'rejected', code });
  }
  expect(apply).not.toHaveBeenCalled();
});

test('A11: a record changed by sync since the preview invalidates the proposal', async () => {
  const { store } = await freshStore();
  await store.create(draftInput({ entityVersions: { 'inv-1': 'rev-1' } }));
  const apply = jest.fn();
  const confirm = createProposalExecutor(store, ports({
    apply, entityRevisions: async () => ({ 'inv-1': 'rev-2' }),
  }));
  expect(await confirm('prop-1')).toEqual({ kind: 'rejected', code: 'ENTITY_CHANGED' });
  expect(apply).not.toHaveBeenCalled();
});

test('A11: an entity deleted since the preview invalidates the proposal', async () => {
  const { store } = await freshStore();
  await store.create(draftInput({ entityVersions: { 'inv-1': 'rev-1' } }));
  const confirm = createProposalExecutor(store, ports({ entityRevisions: async () => ({ 'inv-1': null }) }));
  expect(await confirm('prop-1')).toEqual({ kind: 'rejected', code: 'ENTITY_GONE' });
});

test('B9: a closed period and a revoked permission both block the commit', async () => {
  const apply = jest.fn();
  const closed = await freshStore();
  await closed.store.create(draftInput());
  expect(await createProposalExecutor(closed.store, ports({ apply, isPeriodOpen: async () => false }))('prop-1'))
    .toEqual({ kind: 'rejected', code: 'PERIOD_CLOSED' });

  const denied = await freshStore();
  await denied.store.create(draftInput());
  expect(await createProposalExecutor(denied.store, ports({ apply, canApply: async () => false }))('prop-1'))
    .toEqual({ kind: 'rejected', code: 'FORBIDDEN' });
  expect(apply).not.toHaveBeenCalled();
});

test('a book switch cancels every pending draft for that book', async () => {
  const { store } = await freshStore();
  await store.create(draftInput());
  await store.create(draftInput({ id: 'prop-2', requestId: 'request-2' }));
  expect(await store.cancelPendingForBook('book-a')).toBe(2);
  const confirm = createProposalExecutor(store, ports());
  expect((await confirm('prop-1')).kind).toBe('rejected');
  expect((await confirm('prop-2')).kind).toBe('rejected');
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test('every existing assistant proposal type has a descriptor, and no extras', () => {
  const described = PROPOSAL_DESCRIPTORS.map((entry) => entry.operation).sort();
  expect(described).toEqual([...ASSISTANT_PROPOSAL_TYPES].sort());
  expect(new Set(described).size).toBe(described.length);
});

test('every descriptor schema is closed and bounded', () => {
  for (const entry of PROPOSAL_DESCRIPTORS) {
    expect(entry.schema.type).toBe('object');
    if (entry.schema.type !== 'object') continue;
    // An operation that shrugs off an extra key makes an invented argument
    // look accepted.
    expect(entry.schema.additionalProperties).toBe(false);
    expect(entry.description.length).toBeGreaterThan(20);
    expect(entry.feature).toBeTruthy();
    for (const [, field] of Object.entries(entry.schema.properties)) {
      if (field.type === 'number') {
        expect(field.maximum).toBeLessThanOrEqual(MAX_AI_AMOUNT);
        expect(field.minimum).toBeGreaterThanOrEqual(0);
      }
      if (field.type === 'string') expect(field.maxLength).toBeLessThanOrEqual(500);
    }
  }
});

test('A1: amount strings, NaN, Infinity and negatives are rejected before the validator sees them', () => {
  const expense = descriptor('add_expense').schema;
  // The existing validator would coerce "1,250"; a tool schema must not, because
  // "1.250" is one and a quarter in some locales and twelve fifty in others.
  for (const bad of ['125', '1,250', '', null, true, {}, [], NaN, Infinity, -Infinity, 0, -5, MAX_AI_AMOUNT + 1]) {
    expect(validate(expense, { amount: bad as never })).not.toHaveLength(0);
  }
  expect(validate(expense, { amount: 125 })).toHaveLength(0);
  expect(validate(expense, { amount: 0.01 })).toHaveLength(0);
  // A stock count of zero is meaningful, unlike a zero-value expense.
  expect(validate(descriptor('record_inventory').schema, { amount: 0 })).toHaveLength(0);
});

test('A1: required fields and enums match what the existing validator reads', () => {
  expect(validate(descriptor('add_bill').schema, { amount: 100 })).not.toHaveLength(0);
  expect(validate(descriptor('add_bill').schema, { supplierName: 'Amit', amount: 100 })).toHaveLength(0);
  expect(validate(descriptor('create_invoice').schema, { clientName: 'Ravi', amount: 100 })).toHaveLength(0);
  expect(validate(descriptor('add_capital').schema, { partnerName: 'Sita', amount: 100 })).toHaveLength(0);
  expect(validate(descriptor('add_debtor').schema, { name: 'Ravi' })).toHaveLength(0);
  // Methods and modes are the app's own enums.
  expect(validate(descriptor('add_expense').schema, { amount: 1, method: 'upi' })).not.toHaveLength(0);
  expect(validate(descriptor('add_expense').schema, { amount: 1, method: 'mobile' })).toHaveLength(0);
  expect(validate(descriptor('create_receipt').schema, { amount: 1, mode: 'against_invoice' })).toHaveLength(0);
  expect(validate(descriptor('create_receipt').schema, { amount: 1, mode: 'refund' })).not.toHaveLength(0);
  expect(validate(descriptor('delete_entry').schema, { entity: 'expense', id: 'e1' })).toHaveLength(0);
  expect(validate(descriptor('delete_entry').schema, { entity: 'expense' })).not.toHaveLength(0);
});

test('a reversal is flagged destructive and nothing else is', () => {
  const destructive = PROPOSAL_DESCRIPTORS.filter((entry) => entry.destructive).map((entry) => entry.operation);
  expect(destructive).toEqual(['delete_entry']);
});

test('a draft claiming a different operation or flag than requested is refused', async () => {
  const context: ToolContext = {
    scope, signal: new AbortController().signal, assertCurrent: async () => undefined,
  };
  const wrongOperation = proposalTool(descriptor('add_expense'), {
    canPrepare: async () => true,
    prepare: async () => ({
      operation: 'add_sale', normalized: {}, preview: 'Sale', destructive: false, entityVersions: {},
    }),
  });
  await expect(wrongOperation.prepare({ amount: 1 }, context)).rejects.toThrow('OPERATION_MISMATCH');

  const noPreview = proposalTool(descriptor('add_expense'), {
    canPrepare: async () => true,
    prepare: async () => ({
      operation: 'add_expense', normalized: {}, preview: '   ', destructive: false, entityVersions: {},
    }),
  });
  await expect(noPreview.prepare({ amount: 1 }, context)).rejects.toThrow('DRAFT_WITHOUT_PREVIEW');
});

test('an unauthorized actor cannot prepare, even if the tool was somehow offered', async () => {
  const context: ToolContext = {
    scope, signal: new AbortController().signal, assertCurrent: async () => undefined,
  };
  const prepare = jest.fn();
  const tool = proposalTool(descriptor('add_expense'), { canPrepare: async () => false, prepare });
  expect(await tool.authorize(context)).toBe(false);
  await expect(tool.prepare({ amount: 1 }, context)).rejects.toThrow('FORBIDDEN');
  expect(prepare).not.toHaveBeenCalled();
});

test('the registry never exposes a reset, credential or membership operation', () => {
  const names = createProposalTools({ canPrepare: async () => true, prepare: async () => ({
    operation: 'add_expense', normalized: {}, preview: 'x', destructive: false, entityVersions: {},
  }) }).map((tool) => tool.name);
  for (const forbidden of ['reset_book', 'delete_book', 'factory_reset', 'set_setting', 'export_credentials', 'add_member_role', 'run_sql']) {
    expect(names).not.toContain(forbidden);
  }
  expect(names).toHaveLength(ASSISTANT_PROPOSAL_TYPES.length);
});

// ---------------------------------------------------------------------------
// A2 / A12: the read-only boundary
// ---------------------------------------------------------------------------

test('A2: a write proposed during a read-only turn never reaches prepare', async () => {
  const prepare = jest.fn();
  const tool = proposalTool(descriptor('add_expense'), { canPrepare: async () => true, prepare });
  const frame = (calls: Frame['calls']): Frame => ({ requestId: 'request-1', calls, text: '' });
  const engine: Engine = {
    begin: jest.fn(async () => frame([{ id: '1', name: 'add_expense', arguments: { amount: 125 } }])),
    resume: jest.fn(async () => frame([])),
    cancel: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
  const result = await createAgent(engine)({
    requestId: 'request-1', modelId: 'gemma4-e2b', question: 'How much did I spend?',
    glossary: 'A bookkeeping app.', tools: [tool], canPropose: false,
    currentScope: async () => scope,
  });
  expect(result).toEqual({ kind: 'stopped', code: 'UNADVERTISED_TOOL' });
  expect(prepare).not.toHaveBeenCalled();
});

test('A12: a proposal alongside reads produces no partial action', async () => {
  const prepare = jest.fn(async () => ({
    operation: 'add_expense' as const, normalized: {}, preview: 'x', destructive: false, entityVersions: {},
  }));
  const tool = proposalTool(descriptor('add_expense'), { canPrepare: async () => true, prepare });
  const read = {
    name: 'read_total', description: 'Read a total.', feature: 'reports', access: 'read' as const,
    parameters: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const },
    authorize: async () => true,
    read: jest.fn(async () => ({
      source: 'fixture', scope, asOf: '2026-09-08T10:00:00Z', data: {}, truncated: false, nextCursor: null,
    })),
  };
  const engine: Engine = {
    begin: jest.fn(async (): Promise<Frame> => ({
      requestId: 'request-1', text: '', calls: [
        { id: '1', name: 'read_total', arguments: {} },
        { id: '2', name: 'add_expense', arguments: { amount: 125 } },
      ],
    })),
    resume: jest.fn(async (): Promise<Frame> => ({ requestId: 'request-1', text: 'done', calls: [] })),
    cancel: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
  const result = await createAgent(engine)({
    requestId: 'request-1', modelId: 'gemma4-e2b', question: 'Log 125 and tell me the total',
    glossary: 'A bookkeeping app.', tools: [read, tool], canPropose: true,
    currentScope: async () => scope,
  });
  expect(result.kind).toBe('clarification');
  expect(prepare).not.toHaveBeenCalled();
  expect(read.read).not.toHaveBeenCalled();
});
