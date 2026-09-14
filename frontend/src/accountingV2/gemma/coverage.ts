/**
 * The feature-coverage register (stage P7).
 *
 * This file exists to make one specific claim impossible: "the assistant
 * supports every feature". Every enabled feature in `FeatureKey` must resolve
 * here to exactly one of four honest states —
 *
 *   read           the model can read it through a tested typed tool
 *   proposal       the model can propose a change the user reviews and confirms
 *   guided-screen  the model cannot do it; it can point at the screen that can
 *   blocked        the model is not allowed near it, with the reason recorded
 *
 * `guided-screen` is a real answer, not a placeholder. A row saying "guided" is
 * the assistant telling the truth about its limits. A row that claimed `read`
 * with no tool behind it would be the lie this register prevents, which is why
 * `assertCoverage` fails the build on one.
 *
 * The register is checked against the branch's OWN `FeatureKey` union, so
 * adding a feature to the app and forgetting the assistant breaks a test rather
 * than shipping a confident wrong answer.
 *
 * See docs/plans/gemma4-litertlm/04-app-integration.md section 4.
 */
import { ALL_FEATURES, type FeatureKey } from '../../utils/featureFlags';
import { CORE_READ_TOOL_NAMES } from './coreReadTools';
import { PROPOSAL_DESCRIPTORS } from './proposalRegistry';
import { LIVE_GEMMA_PROPOSALS } from './liveProposalPolicy';

export type CoverageMode = 'read' | 'proposal' | 'guided-screen' | 'blocked';

export type CoverageRow = {
  feature: FeatureKey;
  mode: CoverageMode;
  /** Tool names, which must exist in the read or proposal registry. */
  tools: readonly string[];
  /** A compiled allowlisted route id, never a model-generated URL. */
  route?: string;
  /** Required for `blocked`, so a refusal is explainable to the user. */
  reason?: string;
  /** Test names that actually assert something about this row. */
  tests: readonly string[];
};

/**
 * Navigation targets the assistant may point at.
 *
 * A small compiled enum rather than a path: a model that could emit a route
 * string could emit one that submits a form. Opening a screen is the whole
 * permitted action — the user still does the thing.
 */
export const SCREEN_IDS = [
  'reports', 'monthly', 'daybook', 'cashbook', 'sales', 'bills', 'expenses',
  'invoices', 'quotes', 'delivery', 'receipts', 'payments', 'inventory',
  'assets', 'payroll', 'locations', 'products', 'settings', 'scan', 'ask',
] as const;
export type ScreenId = (typeof SCREEN_IDS)[number];

export const COVERAGE: readonly CoverageRow[] = [
  {
    feature: 'reports',
    mode: 'read',
    tools: ['read_profit_and_loss', 'read_balance_sheet', 'read_trial_balance'],
    route: 'reports',
    tests: ['B1: profit and loss reports the exact domain numbers with basis and range stated',
      'B2: a real trial balance reports actual accounts and totals',
      'B3: an as-of report is not given a period range, and a period report is not given an as-of'],
  },
  {
    feature: 'sales',
    mode: 'proposal',
    tools: ['search_entries', 'read_entry', 'add_sale'],
    route: 'sales',
    tests: ['A1: required fields and enums match what the existing validator reads',
      'B6: a confirmed proposal posts once and repeat confirmations replay the result'],
  },
  {
    feature: 'expenses',
    mode: 'proposal',
    tools: ['search_entries', 'read_entry', 'add_expense', 'log_personal_expense'],
    route: 'expenses',
    tests: ['A1: amount strings, NaN, Infinity and negatives are rejected before the validator sees them',
      'B5: preparing a proposal performs no domain write, party create or outbox entry'],
  },
  {
    feature: 'bills',
    mode: 'proposal',
    tools: ['search_parties', 'read_party_statement', 'search_entries', 'add_bill', 'create_supplier_payment'],
    route: 'bills',
    tests: ['A4: a name matching both a customer and a supplier stays two rows with distinct roles',
      'A1: required fields and enums match what the existing validator reads'],
  },
  {
    feature: 'payments',
    mode: 'proposal',
    tools: ['search_parties', 'read_party_statement', 'create_supplier_payment', 'add_debtor_payment'],
    route: 'payments',
    tests: ['A4: a name matching both a customer and a supplier stays two rows with distinct roles'],
  },
  {
    feature: 'invoices',
    mode: 'proposal',
    tools: ['read_unpaid_invoices', 'search_parties', 'read_entry', 'create_invoice'],
    route: 'invoices',
    tests: ['A5: an invented party id yields an explicit not-found, never an empty success',
      'A5: identifiers and revisions come from the domain, and are required'],
  },
  {
    feature: 'receipts',
    mode: 'proposal',
    tools: ['read_unpaid_invoices', 'search_parties', 'create_receipt'],
    route: 'receipts',
    tests: ['A11: a record changed by sync since the preview invalidates the proposal',
      'A1: required fields and enums match what the existing validator reads'],
  },
  {
    feature: 'quotes',
    mode: 'guided-screen',
    tools: [],
    route: 'quotes',
    reason: 'Quotes keep their item, tax, validity, status and conversion workflow on the reviewed Quotes screen.',
    tests: ['A1: required fields and enums match what the existing validator reads'],
  },
  {
    feature: 'cashbook',
    mode: 'read',
    tools: ['read_cash_movements', 'search_entries'],
    route: 'cashbook',
    // Cash entries post with an accounting treatment the assistant does not
    // choose, so creating one stays a guided screen inside a read row.
    tests: ['A6: a truncated page says so and hands back a continuation'],
  },
  {
    feature: 'daybook',
    mode: 'read',
    tools: ['search_entries', 'read_entry'],
    route: 'daybook',
    tests: ['A6: cursors are opaque, query-bound and invalidated by a data change'],
  },
  {
    feature: 'monthly',
    mode: 'read',
    tools: ['read_profit_and_loss', 'read_trial_balance'],
    route: 'monthly',
    tests: ['B1: the reported range is the one asked for, not one silently ignored'],
  },
  {
    feature: 'inventory',
    mode: 'proposal',
    tools: ['read_inventory', 'record_inventory'],
    route: 'inventory',
    // B10: purchases are not cost of goods sold, and a recorded count is never
    // overwritten or deleted by the assistant.
    tests: ['A1: amount strings, NaN, Infinity and negatives are rejected before the validator sees them',
      'a reversal is flagged destructive and nothing else is'],
  },
  {
    feature: 'delivery',
    mode: 'guided-screen',
    tools: [],
    route: 'delivery',
    // Delivery notes carry item lines and a status workflow that no current
    // proposal type expresses, so the honest answer is the screen.
    tests: ['the registry never exposes a reset, credential or membership operation'],
  },
  {
    feature: 'assets',
    mode: 'guided-screen',
    tools: [],
    route: 'assets',
    tests: ['the registry never exposes a reset, credential or membership operation'],
  },
  {
    feature: 'payroll',
    mode: 'guided-screen',
    tools: [],
    route: 'payroll',
    // Deliberately not readable. Salary is not company-readable just because a
    // tool is marked read-only, and no read tool is authorized for it (A9).
    tests: ['A9: payroll and secret fields never appear in a returned DTO'],
  },
  {
    feature: 'perpetualInventory',
    mode: 'read',
    tools: ['read_inventory'],
    route: 'products',
    tests: ['A6: a truncated page says so and hands back a continuation'],
  },
  {
    feature: 'locations',
    mode: 'read',
    tools: ['describe_capabilities'],
    route: 'locations',
    // Transfers move value between locations and can widen what an actor
    // effectively reaches, so they stay a screen.
    tests: ['A9: a location-restricted actor does not get the company when no location is selected',
      'A9: the location scope actually reaches the adapter'],
  },
  {
    feature: 'ask',
    mode: 'read',
    tools: ['describe_capabilities'],
    route: 'ask',
    tests: ['A9: capability reporting exposes coverage, not settings secrets'],
  },
  {
    feature: 'voice',
    mode: 'guided-screen',
    tools: [],
    route: 'ask',
    // Transcription is a modality, not a feature the model may act on: the user
    // reviews the visible transcript before anything routes to a tool.
    tests: ['extraction and transcription instructions refuse document authority'],
  },
];

/**
 * Things the assistant is never given, whatever a document or a user asks.
 *
 * Not `FeatureKey` rows because they are not user-toggleable features; they are
 * capabilities that must have no tool at all. Listed so the absence is
 * deliberate and testable rather than an oversight.
 */
export const BLOCKED_CAPABILITIES: readonly { capability: string; reason: string }[] = [
  { capability: 'book-reset', reason: 'Destroys a book. Owner-controlled screen only.' },
  { capability: 'book-delete', reason: 'Destroys a book. Owner-controlled screen only.' },
  { capability: 'credentials', reason: 'Sync and cloud credentials are never readable or writable by a model.' },
  { capability: 'membership-roles', reason: 'Changing who may do what cannot be proposed by the assistant.' },
  { capability: 'settings-write', reason: 'No generic settings write tool; each screen owns its own setting.' },
  { capability: 'backup-export', reason: 'Exporting the book is a user action with its own consent flow.' },
  { capability: 'raw-sql', reason: 'Query templates are an implementation detail, never a tool.' },
  { capability: 'filesystem', reason: 'Attachments are reached by app-issued handle only.' },
  { capability: 'network', reason: 'Device-only mode makes no business-data request.' },
  { capability: 'code-execution', reason: 'No path from model output to executed code.' },
];

/**
 * Always-on areas that are not toggleable `FeatureKey`s.
 *
 * Parties and Business Accounts are core to every book, so they never appear in
 * Customize Features and therefore cannot be keyed by `FeatureKey`. They still
 * need coverage rows: `add_debtor`, `add_supplier`, `add_capital` and
 * `create_drawing` are real write operations, and an operation the assistant
 * can perform that no row accounts for is a capability nobody reviewed.
 *
 * Filing them under an unrelated feature would have satisfied the completeness
 * check while making the register lie about where they live.
 */
export type CoreAreaRow = Omit<CoverageRow, 'feature'> & { area: 'parties' | 'businessAccounts' };

export const CORE_COVERAGE: readonly CoreAreaRow[] = [
  {
    area: 'parties',
    mode: 'proposal',
    tools: ['search_parties', 'read_party_statement', 'add_debtor', 'add_supplier'],
    route: 'sales',
    tests: ['A4: a name matching both a customer and a supplier stays two rows with distinct roles',
      'A1: required fields and enums match what the existing validator reads'],
  },
  {
    area: 'businessAccounts',
    mode: 'proposal',
    tools: ['read_business_accounts', 'add_capital', 'create_drawing'],
    route: 'reports',
    // Capital edits need a resolved member id, never a name match.
    tests: ['A1: required fields and enums match what the existing validator reads',
      'every descriptor schema is closed and bounded'],
  },
];

/** Every tool name claimed anywhere in either register. */
export function claimedToolNames(): Set<string> {
  return new Set([
    ...COVERAGE.flatMap((row) => [...row.tools]),
    ...CORE_COVERAGE.flatMap((row) => [...row.tools]),
  ]);
}

export function coverageFor(feature: FeatureKey): CoverageRow {
  const found = COVERAGE.find((row) => row.feature === feature);
  if (!found) throw new Error(`MISSING_COVERAGE:${feature}`);
  return found;
}

/**
 * Fails when the register and reality disagree.
 *
 * Note what this does NOT check: whether the listed tests are any good. It
 * checks that a row cannot claim a tool that does not exist, a mode without the
 * evidence that mode requires, or a route outside the compiled enum. Test
 * quality is a review question, and the plan says so explicitly.
 */
export function assertCoverage(enabled: readonly FeatureKey[], rows: readonly CoverageRow[] = COVERAGE): void {
  const readNames = new Set<string>(CORE_READ_TOOL_NAMES);
  const proposalNames = new Set<string>(PROPOSAL_DESCRIPTORS.map((entry) => entry.operation));

  for (const row of CORE_COVERAGE) {
    for (const tool of row.tools) {
      if (!readNames.has(tool) && !proposalNames.has(tool)) throw new Error(`Unknown core tool: ${row.area} -> ${tool}`);
      if (proposalNames.has(tool) && !LIVE_GEMMA_PROPOSALS.has(tool)) throw new Error(`Core proposal is not live: ${row.area} -> ${tool}`);
    }
  }

  for (const feature of enabled) {
    const matches = rows.filter((row) => row.feature === feature);
    if (matches.length !== 1) throw new Error(`Missing/duplicate coverage: ${feature}`);
    const row = matches[0];

    if (!row.tests.length) throw new Error(`Untested coverage: ${feature}`);
    if ((row.mode === 'read' || row.mode === 'proposal') && !row.tools.length) {
      throw new Error(`No tools: ${feature}`);
    }
    if (row.mode === 'guided-screen' && !row.route) throw new Error(`No route: ${feature}`);
    if (row.mode === 'blocked' && !row.reason) throw new Error(`No reason: ${feature}`);
    if (row.mode === 'guided-screen' && row.tools.length) {
      // A guided row with tools is a row that has not decided what it is.
      throw new Error(`Guided row must not advertise tools: ${feature}`);
    }
    if (row.route && !(SCREEN_IDS as readonly string[]).includes(row.route)) {
      throw new Error(`Route is not an allowlisted screen: ${feature}`);
    }
    for (const tool of row.tools) {
      if (!readNames.has(tool) && !proposalNames.has(tool)) {
        throw new Error(`Unknown tool in coverage: ${feature} -> ${tool}`);
      }
      if (proposalNames.has(tool) && !LIVE_GEMMA_PROPOSALS.has(tool)) {
        throw new Error(`Proposal is not live: ${feature} -> ${tool}`);
      }
    }
    if (row.mode === 'read') {
      for (const tool of row.tools) {
        if (!readNames.has(tool)) throw new Error(`Read row lists a write tool: ${feature} -> ${tool}`);
      }
    }
  }
}

/** Every feature the app can enable, for the build-time completeness check. */
export function allFeatureKeys(): FeatureKey[] {
  return ALL_FEATURES.map((meta) => meta.key);
}

/**
 * The honest summary the assistant reports through `describe_capabilities`.
 *
 * Intersected with what is actually enabled, so a book without payroll is told
 * payroll is not present rather than not supported.
 */
export function coverageSummary(enabled: readonly FeatureKey[]): {
  read: FeatureKey[];
  proposal: FeatureKey[];
  guided: FeatureKey[];
  blocked: readonly { capability: string; reason: string }[];
} {
  const of = (mode: CoverageMode) => enabled.filter((feature) => coverageFor(feature).mode === mode);
  return {
    read: of('read'),
    proposal: of('proposal'),
    guided: of('guided-screen'),
    blocked: BLOCKED_CAPABILITIES,
  };
}
