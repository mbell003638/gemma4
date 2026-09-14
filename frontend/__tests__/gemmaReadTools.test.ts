import {
  createCoreReadTools, createCursorStore, resolveLocationScope, describeLocation,
  requiredNumber, optionalNumber, requiredText, optionalText, validDate,
  profitAndLossTool, trialBalanceTool, balanceSheetTool, partySearchTool,
  unpaidInvoicesTool, describeCapabilitiesTool,
  ToolUnavailableError, PAGE_LIMIT, CORE_READ_TOOL_NAMES,
  type CoreReadPorts, type PermissionPorts, type LocationScope,
  type PnlNumbers, type TrialBalanceNumbers, type BalanceSheetNumbers,
  type PartySummary, type UnpaidInvoice, type CapabilityReport,
} from '../src/accountingV2/gemma/coreReadTools';
import type { Obj, ReadTool, Scope, ToolContext } from '../src/accountingV2/gemma/agentCore';

const scope: Scope = {
  bookId: 'book-a', locationId: null, actorId: 'local-owner', permissionEpoch: 'p1',
  featureEpoch: 'f1', revision: 'r1', currency: 'INR', basis: 'accrual',
  today: '2026-09-08', timeZone: 'Asia/Calcutta',
};

function ctx(over: Partial<Scope> = {}): ToolContext {
  const merged = { ...scope, ...over };
  return { scope: merged, signal: new AbortController().signal, assertCurrent: async () => undefined };
}

const openPermissions: PermissionPorts = {
  canRead: async () => true,
  authorizedLocations: async () => 'all',
};

async function run(tool: ReadTool, args: Obj, context: ToolContext = ctx()) {
  return tool.read(args, context);
}

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try { await work(); } catch (error) {
    if (error instanceof ToolUnavailableError) return error.code;
    return error instanceof Error ? error.message : String(error);
  }
  return 'NO_ERROR';
}

const goodPnl: PnlNumbers = { revenue: 1000, cogs: 400, grossProfit: 600, expenses: 550, netProfit: 450 };

test('balance sheet refuses a balanced claim contradicted by its own assets', async () => {
  const tool = balanceSheetTool({ permissions: openPermissions, read: async () => ({
    assets: 120, liabilities: 40, equity: 60, currentEarnings: 0,
    liabilitiesAndEquity: 100, difference: 0, balanced: true,
  }) });
  expect(await codeOf(() => run(tool, { asOf: '2026-09-08' }))).not.toBe('NO_ERROR');
});

/** A complete, valid set of ports. Only `cashMovements` and `inventory` are
 *  non-nullable: the rest use null to mean "no such entity", which is a
 *  different answer from "an entity with nothing in it". */
function allPorts(): CoreReadPorts {
  return {
    permissions: openPermissions,
    cursors: createCursorStore(),
    profitAndLoss: async () => goodPnl,
    trialBalance: async () => ({ accounts: [], totals: { debit: 0, credit: 0, difference: 0 }, balanced: true }),
    balanceSheet: async () => ({
      assets: 0, liabilities: 0, equity: 0, currentEarnings: 0,
      liabilitiesAndEquity: 0, difference: 0, balanced: true,
    }),
    parties: async () => ({ rows: [], nextAnchor: null }),
    partyStatement: async () => null,
    entries: async () => ({ rows: [], nextAnchor: null }),
    entry: async () => null,
    unpaidInvoices: async () => ({ rows: [], nextAnchor: null }),
    cashMovements: async () => ({
      openingBalance: 0, closingBalance: 0, totalIn: 0, totalOut: 0,
      movements: { rows: [], nextAnchor: null },
    }),
    inventory: async () => ({ valuation: null, products: null }),
    businessAccounts: async () => null,
    capabilities: async () => ({ enabledFeatures: [], coverage: [], navigationTargets: [] }),
  };
}

// ---------------------------------------------------------------------------
// Missing data is missing, not zero (the core audit finding)
// ---------------------------------------------------------------------------

test('required numbers refuse the coercions that produced silent zeroes', () => {
  // Every one of these renders as "0.00" under `Number(value || 0)`, which is
  // what the old helper did.
  for (const bad of [undefined, null, {}, [], NaN, Infinity, -Infinity, '125', '', true]) {
    expect(() => requiredNumber(bad, 'field')).toThrow(ToolUnavailableError);
  }
  expect(requiredNumber(0, 'field')).toBe(0);
  expect(requiredNumber(-12.5, 'field')).toBe(-12.5);
  expect(optionalNumber(undefined, 'f')).toBeNull();
  expect(optionalNumber(null, 'f')).toBeNull();
  expect(() => optionalNumber({}, 'f')).toThrow(ToolUnavailableError);
  expect(optionalNumber(7, 'f')).toBe(7);
});

test('required text refuses blanks and caps runaway labels', () => {
  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    expect(() => requiredText(bad, 'field')).toThrow(ToolUnavailableError);
  }
  expect(requiredText('  Amit  ', 'name')).toBe('Amit');
  expect(requiredText('x'.repeat(500), 'name', 80)).toHaveLength(80);
  expect(optionalText(null)).toBeNull();
  expect(optionalText('  ')).toBeNull();
  expect(optionalText('kg')).toBe('kg');
});

test('B2 regression: a balance sheet whose assets arrive as an object is unavailable, not zero', async () => {
  // api.balanceSheet() really does return assets as an object. The old helper
  // rendered that as "assets 0.00"; this must refuse instead.
  const tool = balanceSheetTool({
    permissions: openPermissions,
    read: async () => ({
      assets: { cash: 100, total: 100 }, liabilities: 0, equity: 100,
      currentEarnings: 0, liabilitiesAndEquity: 100, difference: 0, balanced: true,
    } as unknown as BalanceSheetNumbers),
  });
  expect(await codeOf(() => run(tool, { asOf: '2026-09-08' }))).toBe('MISSING_REPORT_FIELD');
});

test('B2 regression: a trial balance missing its totals is unavailable, not "OUT OF BALANCE"', async () => {
  // api.trialBalance() returns {debits:[],credits:[]} with no totals at all.
  // The old helper reported a balanced book as out of balance.
  const tool = trialBalanceTool({
    permissions: openPermissions, cursors: createCursorStore(),
    read: async () => ({ debits: [], credits: [] } as unknown as TrialBalanceNumbers),
  });
  expect(await codeOf(() => run(tool, { asOf: '2026-09-08' }))).not.toBe('NO_ERROR');
});

test('B2: a real trial balance reports actual accounts and totals', async () => {
  const numbers: TrialBalanceNumbers = {
    accounts: [
      { id: 'a1', code: '1000', name: 'Cash', type: 'asset', debit: 500, credit: 0, normalBalance: 500 },
      { id: 'a2', code: '4000', name: 'Sales', type: 'revenue', debit: 0, credit: 500, normalBalance: 500 },
    ],
    totals: { debit: 500, credit: 500, difference: 0 },
    balanced: true,
  };
  const tool = trialBalanceTool({
    permissions: openPermissions, cursors: createCursorStore(), read: async () => numbers,
  });
  const observation = await run(tool, { asOf: '2026-09-08' });
  const data = observation.data as Record<string, unknown>;
  expect(data.balanced).toBe(true);
  expect(data.totals).toEqual({ debit: 500, credit: 500, difference: 0 });
  expect(observation.source).toBe('v2-reports.trialBalance');
});

test('a trial balance whose totals do not reconcile is refused rather than reported', async () => {
  const tool = trialBalanceTool({
    permissions: openPermissions, cursors: createCursorStore(),
    read: async () => ({
      accounts: [],
      totals: { debit: 500, credit: 499, difference: 0 },
      balanced: true,
    }),
  });
  // `balanced: true` alongside a real difference is contradictory input; the
  // model must not be handed it as evidence.
  expect(await codeOf(() => run(tool, { asOf: '2026-09-08' }))).toBe('INCONSISTENT_REPORT_DATA');
});

// ---------------------------------------------------------------------------
// B1 / B3: report semantics and labelling
// ---------------------------------------------------------------------------

test('B1: profit and loss reports the exact domain numbers with basis and range stated', async () => {
  const tool = profitAndLossTool({ permissions: openPermissions, read: async () => goodPnl });
  const observation = await run(tool, { from: '2026-04-01', to: '2026-09-08' });
  const data = observation.data as Record<string, unknown>;
  expect(data.revenue).toBe(1000);
  expect(data.netProfit).toBe(450);
  // Basis, range and currency travel with the figures: the same revenue means
  // different things on cash and accrual.
  expect(data.basis).toBe('accrual');
  expect(data.currency).toBe('INR');
  expect(data.from).toBe('2026-04-01');
  expect(data.to).toBe('2026-09-08');
  expect(observation.scope.bookId).toBe('book-a');
});

test('B1: the reported range is the one asked for, not one silently ignored', async () => {
  const seen: string[] = [];
  const tool = profitAndLossTool({
    permissions: openPermissions,
    read: async (range) => { seen.push(`${range.from}..${range.to}`); return goodPnl; },
  });
  await run(tool, { from: '2026-04-01', to: '2026-06-30' });
  // The old helper accepted dates and then queried the dashboard regardless.
  expect(seen).toEqual(['2026-04-01..2026-06-30']);
});

test('B3: an as-of report is not given a period range, and a period report is not given an as-of', async () => {
  const pnl = profitAndLossTool({ permissions: openPermissions, read: async () => goodPnl });
  expect(await codeOf(() => run(pnl, { asOf: '2026-09-08' }))).toBe('INVALID_ARGUMENTS');
  const sheet = balanceSheetTool({
    permissions: openPermissions,
    read: async () => ({
      assets: 100, liabilities: 40, equity: 60, currentEarnings: 0,
      liabilitiesAndEquity: 100, difference: 0, balanced: true,
    }),
  });
  expect(await codeOf(() => run(sheet, { from: '2026-01-01', to: '2026-09-08' }))).toBe('INVALID_ARGUMENTS');
  const observation = await run(sheet, { asOf: '2026-09-08' });
  // Labelled as cumulative, so it can never read as a month's movement.
  expect(JSON.stringify(observation.data)).toContain('asOf');
});

test('dates are validated, not just pattern-matched', () => {
  expect(validDate('2026-09-08')).toBe(true);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-9-8', '26-09-08', '1999-12-31', '2100-01-01', '', 'today']) {
    expect(validDate(bad)).toBe(false);
  }
  const tool = profitAndLossTool({ permissions: openPermissions, read: async () => goodPnl });
  return (async () => {
    expect(await codeOf(() => run(tool, { from: '2026-02-30', to: '2026-09-08' }))).toBe('INVALID_ARGUMENTS');
    // A backwards range is a mistake, not an empty period.
    expect(await codeOf(() => run(tool, { from: '2026-09-08', to: '2026-04-01' }))).toBe('INVALID_ARGUMENTS');
  })();
});

// ---------------------------------------------------------------------------
// A4 / A5: parties and invented identifiers
// ---------------------------------------------------------------------------

const parties: PartySummary[] = [
  { id: 'p1', name: 'Amit Traders', roles: ['customer'], receivable: 500, payable: 0 },
  { id: 'p2', name: 'Amit Supplies', roles: ['supplier'], receivable: 0, payable: 750 },
];

test('A4: a name matching both a customer and a supplier stays two rows with distinct roles', async () => {
  const tool = partySearchTool({
    permissions: openPermissions, cursors: createCursorStore(),
    search: async () => ({ rows: parties, nextAnchor: null }),
  });
  const data = (await run(tool, { query: 'Amit', role: 'any' })).data as Record<string, unknown>;
  const rows = data.matches as Record<string, unknown>[];
  expect(rows).toHaveLength(2);
  // Ambiguity is stated, not resolved by the tool.
  expect(data.ambiguous).toBe(true);
  // Picking the "closest" name is how a payment lands on the wrong ledger.
  expect(rows.map((r) => r.id).sort()).toEqual(['p1', 'p2']);
  expect(rows.find((r) => r.id === 'p1')!.roles).toEqual(['customer']);
  expect(rows.find((r) => r.id === 'p2')!.roles).toEqual(['supplier']);
});

test('A4: the role filter is an enum, not free text', async () => {
  const tool = partySearchTool({
    permissions: openPermissions, cursors: createCursorStore(),
    search: async () => ({ rows: parties, nextAnchor: null }),
  });
  expect(await codeOf(() => run(tool, { query: 'Amit', role: 'owner' }))).toBe('INVALID_ARGUMENTS');
  expect(await codeOf(() => run(tool, { query: 'Amit', role: 'any', extra: 1 }))).not.toBe('NO_ERROR');
});

test('A5: an invented party id yields an explicit not-found, never an empty success', async () => {
  const tool = unpaidInvoicesTool({
    permissions: openPermissions, cursors: createCursorStore(),
    // The adapter returns null for a party that does not exist, as distinct
    // from a real party with nothing outstanding.
    read: async (query) => (query.partyId === 'p1' ? { rows: [], nextAnchor: null } : null),
  });
  expect(await codeOf(() => run(tool, { partyId: 'p9-invented' }))).toBe('PARTY_NOT_FOUND');
  const real = await run(tool, { partyId: 'p1' });
  expect((real.data as Record<string, unknown>).rowCount).toBe(0);
});

test('A5: identifiers and revisions come from the domain, and are required', async () => {
  const invoice: UnpaidInvoice = {
    id: 'inv-1', partyId: 'p1', partyName: 'Amit Traders', date: '2026-08-01',
    dueDate: '2026-08-31', total: 500, allocated: 200, outstanding: 300,
    status: 'partly-paid', revision: 'rev-9',
  };
  const tool = unpaidInvoicesTool({
    permissions: openPermissions, cursors: createCursorStore(),
    read: async () => ({ rows: [invoice], nextAnchor: null }),
  });
  const rows = ((await run(tool, { partyId: 'p1' })).data as Record<string, unknown>).invoices as Record<string, unknown>[];
  expect(rows[0].id).toBe('inv-1');
  expect(rows[0].revision).toBe('rev-9');
  expect(rows[0].outstanding).toBe(300);

  // A row without a revision cannot support a later staleness check.
  const noRevision = unpaidInvoicesTool({
    permissions: openPermissions, cursors: createCursorStore(),
    read: async () => ({ rows: [{ ...invoice, revision: '' }], nextAnchor: null }),
  });
  expect(await codeOf(() => run(noRevision, { partyId: 'p1' }))).toBe('MISSING_REPORT_FIELD');
});

// ---------------------------------------------------------------------------
// A8 / A9: authorization and minimum disclosure
// ---------------------------------------------------------------------------

test('A8: an unauthorized feature is neither advertised nor readable', async () => {
  const denied: PermissionPorts = { canRead: async () => false, authorizedLocations: async () => 'all' };
  const tool = profitAndLossTool({ permissions: denied, read: async () => goodPnl });
  expect(await tool.authorize(ctx())).toBe(false);
  // Independently denied even if something advertised it anyway.
  expect(await codeOf(() => run(tool, { from: '2026-04-01', to: '2026-09-08' }))).toBe('FORBIDDEN');
});

test('A9: a location-restricted actor does not get the company when no location is selected', async () => {
  const restricted: PermissionPorts = {
    canRead: async () => true,
    authorizedLocations: async () => ['loc-2'],
  };
  // locationId null means "nothing selected", which for this actor is an
  // aggregate over their own locations -- not company-wide access.
  const resolved = await resolveLocationScope(restricted, scope);
  expect(resolved).toEqual({ kind: 'locations', ids: ['loc-2'] });
  expect(describeLocation(resolved)).toEqual({ coverage: 'authorized-locations', locationIds: ['loc-2'] });

  // Asking for a location they do not hold is forbidden, not silently widened.
  expect(await codeOf(() => resolveLocationScope(restricted, { ...scope, locationId: 'loc-1' }))).toBe('FORBIDDEN');

  // An actor with no readable location gets an honest unavailable.
  const none: PermissionPorts = { canRead: async () => true, authorizedLocations: async () => [] };
  expect(await codeOf(() => resolveLocationScope(none, scope))).toBe('NO_AUTHORIZED_LOCATION');
});

test('A9: an unrestricted actor gets company coverage, and it is stated', async () => {
  expect(await resolveLocationScope(openPermissions, scope)).toEqual({ kind: 'company' });
  expect(describeLocation({ kind: 'company' })).toEqual({ coverage: 'company', locationIds: null });
  const tool = profitAndLossTool({ permissions: openPermissions, read: async () => goodPnl });
  const data = (await run(tool, { from: '2026-04-01', to: '2026-09-08' })).data as Record<string, unknown>;
  // Coverage travels with the figure so a partial total is visibly partial.
  expect(JSON.stringify(data)).toContain('coverage');
});

test('A9: the location scope actually reaches the adapter', async () => {
  const restricted: PermissionPorts = {
    canRead: async () => true, authorizedLocations: async () => ['loc-2', 'loc-3'],
  };
  const seen: LocationScope[] = [];
  const tool = profitAndLossTool({
    permissions: restricted,
    read: async (_range, location) => { seen.push(location); return goodPnl; },
  });
  await run(tool, { from: '2026-04-01', to: '2026-09-08' });
  // Never "fetch everything and redact after": by then the model has seen it.
  expect(seen).toEqual([{ kind: 'locations', ids: ['loc-2', 'loc-3'] }]);
});

test('A9: capability reporting exposes coverage, not settings secrets', async () => {
  const report: CapabilityReport = {
    enabledFeatures: ['reports', 'expenses'],
    coverage: [
      { feature: 'reports', mode: 'read', tools: ['read_profit_and_loss'] },
      { feature: 'sync', mode: 'guided-screen', tools: [], route: 'settings/sync' },
      { feature: 'book-reset', mode: 'blocked', tools: [], reason: 'Owner-controlled screen only' },
    ],
    navigationTargets: [{ screenId: 'reports', label: 'Reports' }],
  };
  const tool = describeCapabilitiesTool({ permissions: openPermissions, read: async () => report });
  const serialized = JSON.stringify((await run(tool, {})).data);
  expect(serialized).toContain('read_profit_and_loss');
  expect(serialized).toContain('blocked');
  // Scan for credential-bearing KEYS rather than the word "secret", which the
  // report itself uses to declare that none are included.
  for (const key of ['"token"', '"apikey"', '"api_key"', '"password"', '"credential"', '"syncpassword"']) {
    expect(serialized.toLowerCase()).not.toContain(key);
  }
  expect(serialized.toLowerCase()).toContain('"secretsincluded":false');
});

// ---------------------------------------------------------------------------
// A10: a failing tool is unavailable, never a fabricated figure
// ---------------------------------------------------------------------------

test('A10: an adapter failure surfaces as unavailable, not as a zero or a profit', async () => {
  const tool = profitAndLossTool({
    permissions: openPermissions,
    read: async () => { throw new Error('SQLITE_BUSY: database is locked'); },
  });
  const message = await codeOf(() => run(tool, { from: '2026-04-01', to: '2026-09-08' }));
  expect(message).not.toBe('NO_ERROR');
  // And nothing numeric was invented on the way out.
  expect(message).not.toContain('0.00');
});

test('A10: a partial report is refused when a single field is missing', async () => {
  const tool = profitAndLossTool({
    permissions: openPermissions,
    read: async () => ({ ...goodPnl, netProfit: undefined } as unknown as PnlNumbers),
  });
  expect(await codeOf(() => run(tool, { from: '2026-04-01', to: '2026-09-08' }))).toBe('MISSING_REPORT_FIELD');
});

// ---------------------------------------------------------------------------
// A6: paging and cursors
// ---------------------------------------------------------------------------

test('A6: cursors are opaque, query-bound and invalidated by a data change', async () => {
  const store = createCursorStore();
  const token = store.issue('search_parties', scope, 'amit|any', 'p2');
  expect(token).not.toContain('p2');
  expect(token).not.toContain('amit');
  expect(store.resolve(token, 'search_parties', scope, 'amit|any')).toBe('p2');

  // Replaying it against another query would walk a party the question never named.
  expect(() => store.resolve(token, 'search_parties', scope, 'bob|any')).toThrow(ToolUnavailableError);
  expect(() => store.resolve(token, 'search_entries', scope, 'amit|any')).toThrow(ToolUnavailableError);
  // A different book, or a changed revision, must not continue the old page.
  expect(() => store.resolve(token, 'search_parties', { ...scope, bookId: 'book-b' }, 'amit|any')).toThrow();
  expect(() => store.resolve(token, 'search_parties', { ...scope, revision: 'r2' }, 'amit|any')).toThrow();
  expect(() => store.resolve('not-a-cursor', 'search_parties', scope, 'amit|any')).toThrow(ToolUnavailableError);
});

test('A6: a truncated page says so and hands back a continuation', async () => {
  const rows = Array.from({ length: PAGE_LIMIT }, (_, i) => ({
    id: `p${i}`, name: `Party ${i}`, roles: ['customer'], receivable: i, payable: 0,
  }));
  const tool = partySearchTool({
    permissions: openPermissions, cursors: createCursorStore(),
    search: async () => ({ rows, nextAnchor: 'p24' }),
  });
  const observation = await run(tool, { query: 'party', role: 'customer' });
  expect(observation.truncated).toBe(true);
  expect(observation.nextCursor).toBeTruthy();
  expect(observation.nextCursor).not.toContain('p24');
});

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

test('the registry builds every declared tool exactly once, all read-only', () => {
  const tools = createCoreReadTools(allPorts());
  expect(tools.map((t) => t.name).sort()).toEqual([...CORE_READ_TOOL_NAMES].sort());
  expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  for (const tool of tools) {
    // Nothing in this registry may ever be a write path.
    expect(tool.access).toBe('read');
    expect(tool.description.length).toBeLessThan(400);
    expect(tool.parameters.type).toBe('object');
    expect(tool.feature).toBeTruthy();
  }
});

test('every tool schema is closed to unknown fields', () => {
  for (const tool of createCoreReadTools(allPorts())) {
    if (tool.parameters.type === 'object') {
      // A tool that shrugs off an extra key makes an invented argument look accepted.
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  }
});
