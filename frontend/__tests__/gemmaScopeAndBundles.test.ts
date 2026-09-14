import {
  buildScope, createRequestEpoch, localCalendarDay,
  ScopeUnavailableError, type ScopePorts,
} from '../src/accountingV2/gemma/scopeContext';
import {
  BUNDLES, bundle, bundleMenu, selectBundleTools, assertBundlesWellFormed,
} from '../src/accountingV2/gemma/toolBundles';
import {
  MAX_TOOLS_PER_RUN, type ReadTool, type Scope, type ToolContext,
} from '../src/accountingV2/gemma/agentCore';
import { CORE_READ_TOOL_NAMES } from '../src/accountingV2/gemma/coreReadTools';

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

function goodPorts(over: Partial<ScopePorts> = {}): ScopePorts {
  return {
    isUnlocked: async () => true,
    activeBookId: async () => 'book-a',
    activeLocationId: async () => null,
    actor: async () => ({ id: 'local-owner', permissionEpoch: 'p1' }),
    featureEpoch: async () => 'f1',
    dataRevision: async () => 'r1',
    bookConfig: async () => ({ currency: 'INR', basis: 'accrual' }),
    localDate: async () => ({ today: '2026-09-08', timeZone: 'Asia/Calcutta' }),
    ...over,
  };
}

async function scopeCode(ports: ScopePorts): Promise<string> {
  try { await buildScope(ports); } catch (error) {
    if (error instanceof ScopeUnavailableError) return error.code;
    return `UNEXPECTED:${String(error)}`;
  }
  return 'NO_ERROR';
}

test('a complete configuration produces the trusted scope', async () => {
  const scope = await buildScope(goodPorts());
  expect(scope).toEqual({
    bookId: 'book-a', locationId: null, actorId: 'local-owner', permissionEpoch: 'p1',
    featureEpoch: 'f1', revision: 'r1', currency: 'INR', basis: 'accrual',
    today: '2026-09-08', timeZone: 'Asia/Calcutta',
  });
});

test('every missing input fails closed instead of defaulting', async () => {
  // Each of these has an attractive-looking default. A hard-coded USD, an
  // assumed accrual basis or an all-locations fallback answers about the wrong
  // money rather than admitting it does not know.
  expect(await scopeCode(goodPorts({ isUnlocked: async () => false }))).toBe('APP_LOCKED');
  expect(await scopeCode(goodPorts({ activeBookId: async () => null }))).toBe('NO_ACTIVE_BOOK');
  expect(await scopeCode(goodPorts({ actor: async () => null }))).toBe('NO_ACTOR');
  expect(await scopeCode(goodPorts({ actor: async () => ({ id: 'u1', permissionEpoch: '' }) })))
    .toBe('NO_PERMISSION_EPOCH');
  expect(await scopeCode(goodPorts({ featureEpoch: async () => null }))).toBe('NO_FEATURE_EPOCH');
  expect(await scopeCode(goodPorts({ dataRevision: async () => null }))).toBe('NO_DATA_REVISION');
  expect(await scopeCode(goodPorts({ bookConfig: async () => null }))).toBe('NO_BOOK_CONFIG');
  expect(await scopeCode(goodPorts({ localDate: async () => null }))).toBe('NO_LOCAL_DATE');
});

test('currency, basis and date are validated, not merely present', async () => {
  for (const currency of ['usd', '$', 'RUPEE', '', 'INR ']) {
    expect(await scopeCode(goodPorts({ bookConfig: async () => ({ currency, basis: 'cash' }) })))
      .toBe('INVALID_CURRENCY');
  }
  expect(await scopeCode(goodPorts({
    bookConfig: async () => ({ currency: 'INR', basis: 'hybrid' as unknown as 'cash' }),
  }))).toBe('INVALID_BASIS');
  expect(await scopeCode(goodPorts({
    localDate: async () => ({ today: '08-09-2026', timeZone: 'Asia/Calcutta' }),
  }))).toBe('INVALID_LOCAL_DATE');
  expect(await scopeCode(goodPorts({
    localDate: async () => ({ today: '2026-09-08', timeZone: '' }),
  }))).toBe('NO_TIME_ZONE');
});

test('a selected location is carried through, and null stays null', async () => {
  const scoped = await buildScope(goodPorts({ activeLocationId: async () => 'loc-2' }));
  expect(scoped.locationId).toBe('loc-2');
  // null means "nothing selected", and must not be widened to company-wide
  // here -- that decision belongs to the actor's real location grants.
  expect((await buildScope(goodPorts())).locationId).toBeNull();
});

test('the cash basis is preserved rather than normalised to accrual', async () => {
  const cash = await buildScope(goodPorts({
    bookConfig: async () => ({ currency: 'INR', basis: 'cash' }),
  }));
  expect(cash.basis).toBe('cash');
});

test('the request epoch abandons a turn whose context moved on', () => {
  const epoch = createRequestEpoch();
  const held = epoch.current();
  expect(() => epoch.assert(held)).not.toThrow();
  epoch.bump();
  // A late result from before a book switch or a model switch cannot be used.
  expect(() => epoch.assert(held)).toThrow(ScopeUnavailableError);
  expect(() => epoch.assert(epoch.current())).not.toThrow();
});

test('the local calendar day is the user\'s day, not UTC', () => {
  // 19:00 UTC is already the next day in Kolkata (+05:30).
  const evening = new Date('2026-09-08T19:00:00Z');
  expect(localCalendarDay(evening, 'Asia/Calcutta')).toBe('2026-09-09');
  expect(localCalendarDay(evening, 'UTC')).toBe('2026-09-08');
  expect(localCalendarDay(new Date('2026-01-01T00:30:00Z'), 'America/New_York')).toBe('2025-12-31');
});

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

function fakeTool(name: string, allowed = true): ReadTool {
  return {
    name, description: `Read ${name}.`, feature: 'reports', access: 'read',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    authorize: async () => allowed,
    read: async (_args, context) => ({
      source: name, scope: context.scope, asOf: '2026-09-08T00:00:00Z',
      data: {}, truncated: false, nextCursor: null,
    }),
  };
}

const scope: Scope = {
  bookId: 'book-a', locationId: null, actorId: 'local-owner', permissionEpoch: 'p1',
  featureEpoch: 'f1', revision: 'r1', currency: 'INR', basis: 'accrual',
  today: '2026-09-08', timeZone: 'Asia/Calcutta',
};
const context: ToolContext = {
  scope, signal: new AbortController().signal, assertCurrent: async () => undefined,
};

test('every bundle is well formed and fits the per-turn ceiling', () => {
  // A bundle naming a tool nobody registers should fail here, not become an
  // empty tool list on a phone.
  expect(() => assertBundlesWellFormed()).not.toThrow();
  for (const entry of BUNDLES) {
    expect(entry.tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_RUN);
    expect(entry.purpose.length).toBeGreaterThan(10);
  }
  expect(bundleMenu().split('\n')).toHaveLength(BUNDLES.length);
});

test('every registered read tool appears in at least one bundle', () => {
  const covered = new Set(BUNDLES.flatMap((entry) => [...entry.tools]));
  for (const name of CORE_READ_TOOL_NAMES) {
    // A tool nothing can select is dead weight in the registry.
    expect(covered.has(name)).toBe(true);
  }
});

test('a bundle resolves to real tools and reports what it could not find', async () => {
  const registry = BUNDLES.flatMap((entry) => entry.tools)
    .filter((name, index, all) => all.indexOf(name) === index)
    .map((name) => fakeTool(name));
  const resolved = await selectBundleTools('reports', registry, context);
  expect(resolved.bundle.id).toBe('reports');
  expect(resolved.tools.map((t) => t.name)).toEqual([...bundle('reports').tools]);
  expect(resolved.dropped).toEqual([]);
});

test('an unauthorized tool is dropped from the bundle, not silently included', async () => {
  const registry = [...bundle('reports').tools].map((name) =>
    fakeTool(name, name !== 'read_trial_balance'));
  const resolved = await selectBundleTools('reports', registry, context);
  expect(resolved.tools.map((t) => t.name)).not.toContain('read_trial_balance');
  expect(resolved.dropped).toContain('read_trial_balance');
});

test('a tool the build does not register is reported as a build mismatch', async () => {
  const resolved = await selectBundleTools('reports', [fakeTool('read_profit_and_loss')], context);
  expect(resolved.tools.map((t) => t.name)).toEqual(['read_profit_and_loss']);
  expect(resolved.dropped).toEqual(['read_balance_sheet', 'read_trial_balance', 'describe_capabilities']);
});

test('an unknown or model-invented bundle falls back to reading nothing from the book', async () => {
  const registry = [fakeTool('describe_capabilities'), fakeTool('read_profit_and_loss')];
  for (const requested of ['read_all_payroll', 'factory_reset', '', '../reports', 'REPORTS']) {
    const resolved = await selectBundleTools(requested, registry, context);
    // Falling back to capabilities-only is the safe default: it answers what
    // the app can do without touching a single ledger figure.
    expect(resolved.bundle.id).toBe('capabilities');
    expect(resolved.tools.map((t) => t.name)).toEqual(['describe_capabilities']);
  }
});

test('a bundle cannot smuggle in a proposal tool', async () => {
  // Bundles are read-only by construction: every name is checked against the
  // read registry by assertBundlesWellFormed.
  const readNames = new Set<string>(CORE_READ_TOOL_NAMES);
  for (const entry of BUNDLES) {
    for (const name of entry.tools) expect(readNames.has(name)).toBe(true);
  }
});
