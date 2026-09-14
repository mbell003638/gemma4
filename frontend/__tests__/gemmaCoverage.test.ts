import {
  COVERAGE, BLOCKED_CAPABILITIES, SCREEN_IDS, assertCoverage, coverageFor,
  allFeatureKeys, coverageSummary, CORE_COVERAGE, claimedToolNames, type CoverageRow,
} from '../src/accountingV2/gemma/coverage';
import { ALL_FEATURES, OPTIONAL_FEATURE_KEYS, type FeatureKey } from '../src/utils/featureFlags';
import { CORE_READ_TOOL_NAMES } from '../src/accountingV2/gemma/coreReadTools';
import { PROPOSAL_DESCRIPTORS } from '../src/accountingV2/gemma/proposalRegistry';
import { LIVE_GEMMA_PROPOSALS } from '../src/accountingV2/gemma/liveProposalPolicy';

test('every feature the app can enable has exactly one coverage row', () => {
  const features = allFeatureKeys();
  expect(features.length).toBe(ALL_FEATURES.length);
  // Adding a feature to the app and forgetting the assistant must break here,
  // not ship a confident wrong answer.
  expect(() => assertCoverage(features)).not.toThrow();
  for (const feature of features) expect(coverageFor(feature).feature).toBe(feature);
  expect(COVERAGE).toHaveLength(features.length);
});

test('the register covers no feature the app does not have', () => {
  const known = new Set<string>(allFeatureKeys());
  for (const row of COVERAGE) expect(known.has(row.feature)).toBe(true);
  expect(new Set(COVERAGE.map((row) => row.feature)).size).toBe(COVERAGE.length);
});

test('a row cannot claim a tool that does not exist', () => {
  const bogus: CoverageRow[] = COVERAGE.map((row) =>
    row.feature === 'reports' ? { ...row, tools: ['read_everything'] } : row);
  expect(() => assertCoverage(['reports'], bogus)).toThrow('Unknown tool in coverage');
});

test('a read row cannot list a write tool', () => {
  const bogus: CoverageRow[] = [{
    feature: 'reports', mode: 'read', tools: ['add_expense'], tests: ['t'],
  }];
  // Otherwise "read-only" coverage could quietly include a posting path.
  expect(() => assertCoverage(['reports'], bogus)).toThrow('Read row lists a write tool');
});

test('a mode without its required evidence fails the check', () => {
  expect(() => assertCoverage(['reports'], [{ feature: 'reports', mode: 'read', tools: [], tests: ['t'] }]))
    .toThrow('No tools');
  expect(() => assertCoverage(['reports'], [{ feature: 'reports', mode: 'read', tools: ['read_profit_and_loss'], tests: [] }]))
    .toThrow('Untested coverage');
  expect(() => assertCoverage(['delivery'], [{ feature: 'delivery', mode: 'guided-screen', tools: [], tests: ['t'] }]))
    .toThrow('No route');
  expect(() => assertCoverage(['payroll'], [{ feature: 'payroll', mode: 'blocked', tools: [], tests: ['t'] }]))
    .toThrow('No reason');
  // A guided row that also advertises tools has not decided what it is.
  expect(() => assertCoverage(['delivery'], [{
    feature: 'delivery', mode: 'guided-screen', tools: ['read_entry'], route: 'delivery', tests: ['t'],
  }])).toThrow('Guided row must not advertise tools');
});

test('a missing or duplicated row fails the check', () => {
  expect(() => assertCoverage(['reports'], [])).toThrow('Missing/duplicate coverage');
  const duplicated = [coverageFor('reports'), coverageFor('reports')];
  expect(() => assertCoverage(['reports'], duplicated)).toThrow('Missing/duplicate coverage');
});

test('routes are compiled screen ids, never model-generated paths', () => {
  for (const row of COVERAGE) {
    if (row.route) expect(SCREEN_IDS).toContain(row.route);
  }
  const bogus: CoverageRow[] = [{
    feature: 'reports', mode: 'guided-screen', tools: [], route: '/settings?reset=1', tests: ['t'],
  }];
  expect(() => assertCoverage(['reports'], bogus)).toThrow('Route is not an allowlisted screen');
});

test('payroll is not readable, and is honest about why', () => {
  const payroll = coverageFor('payroll');
  // Salary is not company-readable just because a tool is marked read-only.
  expect(payroll.mode).toBe('guided-screen');
  expect(payroll.tools).toEqual([]);
});

test('the destructive and privileged capabilities are blocked with reasons', () => {
  const capabilities = BLOCKED_CAPABILITIES.map((entry) => entry.capability);
  for (const required of [
    'book-reset', 'book-delete', 'credentials', 'membership-roles',
    'settings-write', 'raw-sql', 'filesystem', 'network', 'code-execution',
  ]) {
    expect(capabilities).toContain(required);
  }
  for (const entry of BLOCKED_CAPABILITIES) {
    expect(entry.reason.length).toBeGreaterThan(15);
  }
  // And none of them is a registered tool under any name.
  const registered = new Set<string>([...CORE_READ_TOOL_NAMES, ...PROPOSAL_DESCRIPTORS.map((d) => d.operation)]);
  for (const capability of capabilities) expect(registered.has(capability)).toBe(false);
});

test('the summary reports only what this book actually has enabled', () => {
  const enabled: FeatureKey[] = ['reports', 'expenses', 'delivery'];
  const summary = coverageSummary(enabled);
  expect(summary.read).toEqual(['reports']);
  expect(summary.proposal).toEqual(['expenses']);
  expect(summary.guided).toEqual(['delivery']);
  // A book without payroll is told payroll is not present, not unsupported --
  // it simply does not appear.
  expect([...summary.read, ...summary.proposal, ...summary.guided]).not.toContain('payroll');
  expect(summary.blocked).toBe(BLOCKED_CAPABILITIES);
});

test('optional features are covered even though they are off by default', () => {
  // Off-by-default is not a reason to leave a row out: the user can turn these
  // on, and the assistant must already know what it can do with them.
  for (const key of OPTIONAL_FEATURE_KEYS) {
    expect(() => coverageFor(key)).not.toThrow();
    expect(coverageFor(key).tests.length).toBeGreaterThan(0);
  }
});

test('no coverage row promises more than the registries can deliver', () => {
  const readNames = new Set<string>(CORE_READ_TOOL_NAMES);
  const proposalNames = new Set<string>(PROPOSAL_DESCRIPTORS.map((entry) => entry.operation));
  for (const row of COVERAGE) {
    for (const tool of row.tools) {
      expect(readNames.has(tool) || proposalNames.has(tool)).toBe(true);
    }
    if (row.mode === 'proposal') {
      // A proposal row must actually contain at least one write operation.
      expect(row.tools.some((tool) => proposalNames.has(tool))).toBe(true);
    }
  }
});

test('every live proposal operation appears in some coverage row', () => {
  const claimed = claimedToolNames();
  for (const operation of LIVE_GEMMA_PROPOSALS) {
    // A write the assistant can perform but that no row accounts for is a
    // capability nobody reviewed.
    expect(claimed.has(operation)).toBe(true);
  }
});

test('every registered read tool appears in some coverage row', () => {
  const claimed = claimedToolNames();
  for (const name of CORE_READ_TOOL_NAMES) expect(claimed.has(name)).toBe(true);
});

test('the always-on core areas are covered with the same rigour as features', () => {
  const readNames = new Set<string>(CORE_READ_TOOL_NAMES);
  const proposalNames = new Set<string>(PROPOSAL_DESCRIPTORS.map((entry) => entry.operation));
  expect(CORE_COVERAGE.map((row) => row.area).sort()).toEqual(['businessAccounts', 'parties']);
  for (const row of CORE_COVERAGE) {
    expect(row.tests.length).toBeGreaterThan(0);
    expect(row.tools.length).toBeGreaterThan(0);
    if (row.route) expect(SCREEN_IDS).toContain(row.route);
    for (const tool of row.tools) {
      expect(readNames.has(tool) || proposalNames.has(tool)).toBe(true);
    }
    // Parties and Business Accounts are not toggleable features, so they must
    // not collide with the FeatureKey register.
    expect(allFeatureKeys()).not.toContain(row.area as never);
  }
});
