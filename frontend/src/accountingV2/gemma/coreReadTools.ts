/**
 * Typed READ adapters for the Gemma agent (stage P4).
 *
 * Everything here is expressed as PORTS — plain injected functions — so this
 * file never imports `api.ts`. That is not stylistic: `api.ts` already imports
 * the accounting module, so importing it back would close a cycle, and it would
 * also make every tool untestable without storage, settings and a live book.
 * The branch composition root (`branchPorts.ts`) is the only layer allowed to
 * know about `api.*`.
 *
 * Why these adapters exist at all: `onDeviceReadTools.ts` reads convenience UI
 * facades (`api.dashboard()`, `api.balanceSheet()`, `api.trialBalance()`) whose
 * shapes it guesses wrong, and then renders `Number(undefined || 0).toFixed(2)`
 * — so a book with real sales answers "sales 0.00" and an unbalanced book
 * answers "debits 0.00, credits 0.00". A wrong number stated confidently is
 * worse than no number, so every adapter below:
 *
 *   - reads the reconciled V2 report/domain path, never a dashboard summary;
 *   - refuses to coerce a missing or non-finite field to 0 (it raises
 *     ToolUnavailableError instead — "unavailable" is an honest answer, "0.00"
 *     is a fabricated one);
 *   - labels the accounting semantics it actually has (period movement vs
 *     cumulative as-of, posted account movements vs a classified cash flow
 *     statement);
 *   - re-builds every returned DTO key by key, so a port that hands back
 *     payroll, credentials or sync fields cannot leak them into a prompt;
 *   - pages through an opaque, scope-bound cursor rather than an offset that
 *     silently skips rows when the book changes underneath it.
 *
 * See docs/plans/gemma4-litertlm/03-agent-and-tools.md §4 and
 * docs/plans/gemma4-litertlm/01-architecture.md §3.
 */

import { validate } from './agentCore';
import type { Obj, Observation, ReadTool, Schema, Scope, ToolContext } from './agentCore';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when a tool cannot answer truthfully.
 *
 * Deliberately distinct from the reportable control codes in agentCore: those
 * describe a boundary the core enforced, this one describes data the app does
 * not have. Either way the turn stops — what must never happen is a zero, a
 * profit or a "balanced" claim invented to fill the gap.
 */
export class ToolUnavailableError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'ToolUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Schemas and argument validation
// ---------------------------------------------------------------------------

const ISO_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

const dateSchema: Schema = { type: 'string', pattern: ISO_DATE_PATTERN, maxLength: 10 };
const cursorSchema: Schema = { type: 'string', maxLength: 128 };
const querySchema: Schema = { type: 'string', maxLength: 80 };
const idSchema: Schema = { type: 'string', maxLength: 120 };

export const noArgsSchema: Schema = {
  type: 'object', properties: {}, required: [], additionalProperties: false,
};

export const rangeSchema: Schema = {
  type: 'object', additionalProperties: false,
  properties: { from: dateSchema, to: dateSchema }, required: ['from', 'to'],
};

export const asOfSchema: Schema = {
  type: 'object', additionalProperties: false,
  properties: { asOf: dateSchema }, required: ['asOf'],
};

/**
 * A real calendar date, not merely ten digits shaped like one.
 *
 * `new Date('2026-02-31')` rolls over to 3 March, so a pattern match alone lets
 * a model ask for a day that does not exist and receive a report for a
 * different one. Round-tripping through ISO catches that.
 */
export function validDate(value: string): boolean {
  if (!new RegExp(ISO_DATE_PATTERN).test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value
    && value >= '2000-01-01' && value <= '2099-12-31';
}

export type DateRange = { from: string; to: string };

/** Reads and checks an inclusive local-date range from validated model arguments. */
export function readRange(args: Obj): DateRange {
  const from = String(args.from ?? '');
  const to = String(args.to ?? '');
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('INVALID_ARGUMENTS');
  return { from, to };
}

/** Reads a single as-of date from validated model arguments. */
export function readAsOf(args: Obj): string {
  const asOf = String(args.asOf ?? '');
  if (!validDate(asOf)) throw new Error('INVALID_ARGUMENTS');
  return asOf;
}

function optionalString(args: Obj, key: string): string | null {
  const raw = args[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error('INVALID_ARGUMENTS');
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Missing data is missing, not zero
// ---------------------------------------------------------------------------

/**
 * A required money/number field from the domain.
 *
 * `Number(value || 0)` is exactly the defect this project exists to stop: an
 * object, an undefined field or a NaN all render as `0.00` and read to the user
 * as a real balance.
 */
export function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolUnavailableError(
      'MISSING_REPORT_FIELD',
      `${field} was not a finite number from the accounting domain`,
    );
  }
  return value;
}

/** A genuinely optional number: absent stays `null`, present must be finite. */
export function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return requiredNumber(value, field);
}

/** A required identifier/label. Trimmed and capped so one row cannot flood the prompt. */
export function requiredText(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolUnavailableError('MISSING_REPORT_FIELD', `${field} was missing from the accounting domain`);
  }
  return value.trim().slice(0, max);
}

/** An optional label. Absent stays `null` rather than becoming an empty string. */
export function optionalText(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

const CENT_TOLERANCE = 0.005;

/** Two derived totals must agree to the cent, or the report is not reportable. */
function assertReconciles(left: number, right: number, explanation: string): void {
  if (Math.abs(left - right) > CENT_TOLERANCE) {
    throw new ToolUnavailableError('INCONSISTENT_REPORT_DATA', explanation);
  }
}

// ---------------------------------------------------------------------------
// Permissions and location scope
// ---------------------------------------------------------------------------

export type PermissionPorts = {
  /**
   * Real permission for a feature, not UI visibility. A hidden button and an
   * unauthorized read are different things; only the second one belongs here.
   */
  canRead(feature: string, scope: Scope): Promise<boolean>;
  /**
   * `'all'` for an actor who may read the whole book, otherwise the exact
   * locations this actor may read. Must never widen on error — an adapter that
   * returns `'all'` from a catch block hands the model the company.
   */
  authorizedLocations(scope: Scope): Promise<'all' | readonly string[]>;
};

export type LocationScope =
  | { kind: 'company' }
  | { kind: 'locations'; ids: readonly string[] };

/**
 * Turns `scope.locationId` plus the actor's real grants into the location set a
 * query may cover.
 *
 * `locationId: null` means "no single location selected". For an unrestricted
 * actor that is the whole company; for a location-restricted actor it must NOT
 * become company-wide access, so it resolves to an aggregate over exactly the
 * authorized locations. Fetching everything and redacting afterwards is not an
 * option: by then the model has already seen it.
 */
export async function resolveLocationScope(
  permissions: PermissionPorts,
  scope: Scope,
): Promise<LocationScope> {
  const authorized = await permissions.authorizedLocations(scope);
  if (authorized === 'all') {
    return scope.locationId === null ? { kind: 'company' } : { kind: 'locations', ids: [scope.locationId] };
  }
  const ids = [...authorized];
  if (!ids.length) {
    throw new ToolUnavailableError('NO_AUTHORIZED_LOCATION', 'This user has no readable location in the active book');
  }
  if (scope.locationId === null) return { kind: 'locations', ids };
  if (!ids.includes(scope.locationId)) throw new Error('FORBIDDEN');
  return { kind: 'locations', ids: [scope.locationId] };
}

/** The location coverage stated alongside every figure, so a partial total is visibly partial. */
export function describeLocation(location: LocationScope): Obj {
  return location.kind === 'company'
    ? { coverage: 'company', locationIds: null }
    : { coverage: 'authorized-locations', locationIds: [...location.ids] };
}

/** True when the actor may read the feature AND has a resolvable location scope. */
async function permitted(permissions: PermissionPorts, feature: string, scope: Scope): Promise<boolean> {
  if (!await permissions.canRead(feature, scope)) return false;
  try {
    await resolveLocationScope(permissions, scope);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Opaque, scope-bound cursors
// ---------------------------------------------------------------------------

export const PAGE_LIMIT = 25;

export type CursorStore = {
  /** Mints a token for "continue this exact query, after this anchor". */
  issue(tool: string, scope: Scope, query: string, anchor: string): string;
  /** Returns the stored anchor, or throws if the token is invented, stale or reused elsewhere. */
  resolve(token: string, tool: string, scope: Scope, query: string): string;
};

/**
 * The scope facts a page is bound to. `revision` is included on purpose: once
 * the ledger changes, resuming a page means resuming over data that no longer
 * matches page one, so the cursor must die rather than silently skip rows.
 */
function fingerprint(scope: Scope): string {
  return [scope.bookId, scope.locationId ?? '*', scope.actorId,
    scope.permissionEpoch, scope.featureEpoch, scope.revision].join('|');
}

/**
 * Cursors are opaque handles into a small in-process table, not encoded
 * offsets. A model cannot construct one, cannot edit one to page into another
 * book, and cannot resurrect one after the book moved on.
 */
export function createCursorStore(limit = 32): CursorStore {
  const entries = new Map<string, { tool: string; fingerprint: string; query: string; anchor: string }>();
  let counter = 0;
  return {
    issue(tool, scope, query, anchor) {
      counter += 1;
      const token = `c${counter}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
      entries.set(token, { tool, fingerprint: fingerprint(scope), query, anchor });
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return token;
    },
    resolve(token, tool, scope, query) {
      const found = entries.get(token);
      if (!found) throw new ToolUnavailableError('INVALID_CURSOR', 'That page reference is not one this app issued');
      if (found.tool !== tool || found.query !== query) {
        throw new ToolUnavailableError('INVALID_CURSOR', 'That page reference belongs to a different query');
      }
      if (found.fingerprint !== fingerprint(scope)) {
        throw new ToolUnavailableError('STALE_CURSOR', 'The book changed since that page; start the list again');
      }
      return found.anchor;
    },
  };
}

export type Page<T> = { rows: readonly T[]; nextAnchor: string | null };
export type PageRequest = { after: string | null; limit: number };

export type PagingPorts = { permissions: PermissionPorts; cursors: CursorStore };

/**
 * Resolves an incoming cursor argument to a page request.
 *
 * The signature binds the token to the rest of the arguments, so a cursor from
 * "unpaid invoices for Alice" cannot be replayed against "unpaid invoices for
 * Bob" to walk a party the question never named.
 */
function pageRequest(store: CursorStore, tool: string, scope: Scope, query: string, args: Obj): PageRequest {
  const token = optionalString(args, 'cursor');
  return { after: token ? store.resolve(token, tool, scope, query) : null, limit: PAGE_LIMIT };
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * Builds the structured observation handed back to the model.
 *
 * `asOf` is the wall-clock read time (evidence freshness). An accounting as-of
 * or period boundary is a different thing and always travels inside `data`,
 * labelled, so a cumulative balance can never be mistaken for a month's
 * movement.
 */
function observe(source: string, context: ToolContext, data: Obj, nextCursor: string | null = null): Observation {
  return {
    source,
    scope: context.scope,
    asOf: new Date().toISOString(),
    data,
    truncated: nextCursor !== null,
    nextCursor,
  };
}

/**
 * Re-checks authorisation inside the tool itself.
 *
 * The agent core already calls `authorize` before advertising a tool and again
 * before each call, so in the normal path this is the third check. It is here
 * anyway because a tool that trusts its caller to have asked is one refactor,
 * one new call site or one direct unit test away from being reachable without
 * the question ever being put -- and the thing on the other side is payroll and
 * party balances. Test A8 requires execution to be denied independently of
 * whether the tool was advertised.
 */
function readOnly(tool: ReadTool): ReadTool {
  return {
    ...tool,
    read: async (args, context) => {
      // The schema is re-applied here for the same reason as the permission
      // check: the core validates every call, but a tool that only rejects a
      // fabricated argument because someone else checked first is not actually
      // closed to one.
      if (validate(tool.parameters, args).length) throw new Error('INVALID_ARGUMENTS');
      if (!await tool.authorize(context)) throw new Error('FORBIDDEN');
      return tool.read(args, context);
    },
  };
}

// ---------------------------------------------------------------------------
// read_profit_and_loss
// ---------------------------------------------------------------------------

/**
 * The `profitAndLoss` block of `V2Reports`, unmodified.
 *
 * Note what `expenses` means, because getting it wrong is test B10: in
 * `reports.ts` accrual `expenses` is TOTAL expenses INCLUDING cost of goods
 * sold (COGS is an expense-type account), while cash-basis `expenses` is
 * disjoint from `cogs`. `api.pnl()` additionally maps `cogs = totalPurchases`,
 * which is purchases-as-COGS — never source this tool from there.
 */
export type PnlNumbers = {
  revenue: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
};

export type PnlPorts = {
  permissions: PermissionPorts;
  /** Must be `buildPersistentV2Reports(...).profitAndLoss` for the range, not a dashboard. */
  read(range: DateRange, location: LocationScope, scope: Scope): Promise<PnlNumbers>;
};

export function profitAndLossTool(ports: PnlPorts): ReadTool {
  return readOnly({
    name: 'read_profit_and_loss',
    access: 'read',
    feature: 'reports',
    description: 'Read the reconciled profit and loss MOVEMENT for an inclusive local-date range in the current book.',
    parameters: rangeSchema,
    authorize: (context) => permitted(ports.permissions, 'reports', context.scope),
    read: async (args, context) => {
      const range = readRange(args);
      await context.assertCurrent();
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const raw = await ports.read(range, location, context.scope);
      await context.assertCurrent();

      const revenue = requiredNumber(raw.revenue, 'profitAndLoss.revenue');
      const cogs = requiredNumber(raw.cogs, 'profitAndLoss.cogs');
      const grossProfit = requiredNumber(raw.grossProfit, 'profitAndLoss.grossProfit');
      const expenses = requiredNumber(raw.expenses, 'profitAndLoss.expenses');
      const netProfit = requiredNumber(raw.netProfit, 'profitAndLoss.netProfit');

      // Basis decides whether total expenses already contain COGS (see reports.ts).
      const expensesIncludeCogs = context.scope.basis === 'accrual';
      assertReconciles(grossProfit, revenue - cogs, 'grossProfit does not equal revenue minus cost of goods sold');
      assertReconciles(
        netProfit,
        expensesIncludeCogs ? revenue - expenses : grossProfit - expenses,
        'netProfit does not reconcile with the reported revenue and expenses',
      );

      return observe('v2-reports.profitAndLoss', context, {
        reportType: 'profit_and_loss',
        semantics: 'period_movement',
        from: range.from,
        to: range.to,
        currency: context.scope.currency,
        basis: context.scope.basis,
        location: describeLocation(location),
        revenue,
        costOfGoodsSold: cogs,
        grossProfit,
        totalExpenses: expenses,
        totalExpensesIncludeCostOfGoodsSold: expensesIncludeCogs,
        netProfit,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// read_trial_balance
// ---------------------------------------------------------------------------

export type TrialBalanceAccount = {
  id: string; code: string; name: string; type: string;
  debit: number; credit: number; normalBalance: number;
};

export type TrialBalanceNumbers = {
  accounts: readonly TrialBalanceAccount[];
  totals: { debit: number; credit: number; difference: number };
  balanced: boolean;
};

export type TrialBalancePorts = PagingPorts & {
  /** Must be `buildPersistentV2Reports({ to: asOf }).trialBalance`. */
  read(asOf: string, location: LocationScope, scope: Scope): Promise<TrialBalanceNumbers>;
};

export function trialBalanceTool(ports: TrialBalancePorts): ReadTool {
  const name = 'read_trial_balance';
  return readOnly({
    name,
    access: 'read',
    feature: 'reports',
    description: 'Read the trial balance accumulated up to and including a date: accounts, totals and whether it balances.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { asOf: dateSchema, cursor: cursorSchema }, required: ['asOf'],
    },
    authorize: (context) => permitted(ports.permissions, 'reports', context.scope),
    read: async (args, context) => {
      const asOf = readAsOf(args);
      const query = `asOf=${asOf}`;
      const after = pageRequest(ports.cursors, name, context.scope, query, args).after;
      await context.assertCurrent();
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const raw = await ports.read(asOf, location, context.scope);
      await context.assertCurrent();

      if (!Array.isArray(raw.accounts)) {
        throw new ToolUnavailableError('MISSING_REPORT_FIELD', 'trialBalance.accounts was not returned');
      }
      if (typeof raw.balanced !== 'boolean') {
        // "balanced" must be the report's own verdict. Deriving it here from a
        // rounded difference is how "OUT OF BALANCE" gets reported for a book
        // that balances perfectly.
        throw new ToolUnavailableError('MISSING_REPORT_FIELD', 'trialBalance.balanced was not returned');
      }
      const totals = {
        debit: requiredNumber(raw.totals?.debit, 'trialBalance.totals.debit'),
        credit: requiredNumber(raw.totals?.credit, 'trialBalance.totals.credit'),
        difference: requiredNumber(raw.totals?.difference, 'trialBalance.totals.difference'),
      };
      // A payload claiming a zero difference while its own debit and credit
      // totals disagree is contradictory, and whichever half is wrong the model
      // must not be handed it as evidence.
      assertReconciles(
        totals.difference,
        totals.debit - totals.credit,
        'the reported trial-balance difference does not equal debit minus credit',
      );
      if (raw.balanced !== (Math.abs(totals.difference) <= CENT_TOLERANCE)) {
        throw new ToolUnavailableError(
          'INCONSISTENT_REPORT_DATA',
          'the trial balance reports a balanced verdict that its own totals contradict',
        );
      }

      // The chart of accounts is a bounded list, so the page is taken here after
      // the totals are computed: an account page is never the whole answer, and
      // the totals below always cover every account, not just this page.
      const ordered = raw.accounts.map((account) => ({
        id: requiredText(account.id, 'account.id'),
        code: requiredText(account.code, 'account.code', 16),
        name: requiredText(account.name, 'account.name', 60),
        type: requiredText(account.type, 'account.type', 16),
        debit: requiredNumber(account.debit, `account ${account.code} debit`),
        credit: requiredNumber(account.credit, `account ${account.code} credit`),
        normalBalance: requiredNumber(account.normalBalance, `account ${account.code} normalBalance`),
      })).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      const start = after ? ordered.findIndex((account) => account.code > after) : 0;
      const page = start < 0 ? [] : ordered.slice(start, start + PAGE_LIMIT);
      const remaining = start >= 0 && start + PAGE_LIMIT < ordered.length;
      const nextCursor = remaining && page.length
        ? ports.cursors.issue(name, context.scope, query, page[page.length - 1].code)
        : null;

      return observe('v2-reports.trialBalance', context, {
        reportType: 'trial_balance',
        semantics: 'cumulative_as_of',
        asOf,
        currency: context.scope.currency,
        measurement: 'accrual-journal',
        location: describeLocation(location),
        accountCount: ordered.length,
        accounts: page,
        totals,
        balanced: raw.balanced,
      }, nextCursor);
    },
  });
}

// ---------------------------------------------------------------------------
// read_balance_sheet
// ---------------------------------------------------------------------------

export type BalanceSheetNumbers = {
  assets: number;
  liabilities: number;
  equity: number;
  currentEarnings: number;
  liabilitiesAndEquity: number;
  difference: number;
  balanced: boolean;
};

export type BalanceSheetPorts = {
  permissions: PermissionPorts;
  /** Must be `buildPersistentV2Reports({ to: asOf }).balanceSheet`. */
  read(asOf: string, location: LocationScope, scope: Scope): Promise<BalanceSheetNumbers>;
};

export function balanceSheetTool(ports: BalanceSheetPorts): ReadTool {
  return readOnly({
    name: 'read_balance_sheet',
    access: 'read',
    feature: 'reports',
    description: 'Read the cumulative balance sheet as at a date: assets, liabilities, equity and whether it balances.',
    parameters: asOfSchema,
    authorize: (context) => permitted(ports.permissions, 'reports', context.scope),
    read: async (args, context) => {
      const asOf = readAsOf(args);
      await context.assertCurrent();
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const raw = await ports.read(asOf, location, context.scope);
      await context.assertCurrent();

      if (typeof raw.balanced !== 'boolean') {
        throw new ToolUnavailableError('MISSING_REPORT_FIELD', 'balanceSheet.balanced was not returned');
      }
      // Each of these is a single number in V2Reports. `api.balanceSheet()`
      // returns `assets` as a nested object instead, which is why the old helper
      // rendered NaN as "0.00" — requiredNumber refuses that shape outright.
      const assets = requiredNumber(raw.assets, 'balanceSheet.assets');
      const liabilities = requiredNumber(raw.liabilities, 'balanceSheet.liabilities');
      const equity = requiredNumber(raw.equity, 'balanceSheet.equity');
      const currentEarnings = requiredNumber(raw.currentEarnings, 'balanceSheet.currentEarnings');
      const liabilitiesAndEquity = requiredNumber(raw.liabilitiesAndEquity, 'balanceSheet.liabilitiesAndEquity');
      const difference = requiredNumber(raw.difference, 'balanceSheet.difference');
      assertReconciles(liabilitiesAndEquity, liabilities + equity + currentEarnings,
        'liabilities and equity do not sum to the reported total');
      assertReconciles(difference, assets - liabilitiesAndEquity,
        'balance sheet difference does not match assets minus liabilities and equity');
      if (raw.balanced !== (Math.abs(difference) <= CENT_TOLERANCE)) {
        throw new ToolUnavailableError('INCONSISTENT_REPORT', 'balance sheet reconciliation contradicts its totals');
      }

      return observe('v2-reports.balanceSheet', context, {
        reportType: 'balance_sheet',
        semantics: 'cumulative_as_of',
        asOf,
        currency: context.scope.currency,
        // The V2 balance sheet is always journal/accrual-derived; only P&L
        // recognition follows the book's basis (reports.ts).
        measurement: 'accrual-journal',
        location: describeLocation(location),
        assets,
        liabilities,
        equity,
        currentEarnings,
        liabilitiesAndEquity,
        difference,
        balanced: raw.balanced,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// search_parties
// ---------------------------------------------------------------------------

export type PartyRoleFilter = 'customer' | 'supplier' | 'any';

export type PartySummary = {
  id: string;
  name: string;
  roles: readonly string[];
  /** Owed BY this customer. */
  receivable: number;
  /** Owed TO this supplier. */
  payable: number;
};

export type PartySearchPorts = PagingPorts & {
  search(
    query: { text: string | null; role: PartyRoleFilter },
    location: LocationScope,
    scope: Scope,
    page: PageRequest,
  ): Promise<Page<PartySummary>>;
};

const PARTY_ROLES: readonly string[] = ['customer', 'supplier', 'any'];

export function partySearchTool(ports: PartySearchPorts): ReadTool {
  const name = 'search_parties';
  return readOnly({
    name,
    access: 'read',
    feature: 'parties',
    description: 'Find customers and suppliers by name. Returns every match with its role and balances; it never picks one.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: querySchema, role: { type: 'string', enum: PARTY_ROLES, maxLength: 10 }, cursor: cursorSchema },
      required: [],
    },
    authorize: (context) => permitted(ports.permissions, 'parties', context.scope),
    read: async (args, context) => {
      const text = optionalString(args, 'query');
      const roleArg = optionalString(args, 'role') ?? 'any';
      if (!PARTY_ROLES.includes(roleArg)) throw new Error('INVALID_ARGUMENTS');
      const role = roleArg as PartyRoleFilter;
      const query = `q=${text ?? ''}&role=${role}`;
      const request = pageRequest(ports.cursors, name, context.scope, query, args);

      await context.assertCurrent();
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const found = await ports.search({ text, role }, location, context.scope, request);
      await context.assertCurrent();

      // Two people really can be called "Amit Traders", and one of them can be a
      // customer while the other is a supplier. Every match is returned with its
      // own id and role so the model has to ask which one, instead of paying the
      // nearest name.
      const matches = found.rows.map((party) => ({
        id: requiredText(party.id, 'party.id'),
        name: requiredText(party.name, 'party.name', 80),
        roles: Array.isArray(party.roles) ? party.roles.map((entry) => requiredText(entry, 'party.role', 16)) : [],
        receivable: requiredNumber(party.receivable, `party ${party.id} receivable`),
        payable: requiredNumber(party.payable, `party ${party.id} payable`),
      }));
      const nextCursor = found.nextAnchor
        ? ports.cursors.issue(name, context.scope, query, found.nextAnchor)
        : null;

      return observe('v2-parties.search', context, {
        query: text,
        role,
        currency: context.scope.currency,
        location: describeLocation(location),
        matchCount: matches.length,
        matches,
        ambiguous: matches.length > 1,
      }, nextCursor);
    },
  });
}

// ---------------------------------------------------------------------------
// read_party_statement
// ---------------------------------------------------------------------------

export type PartyMovement = {
  id: string;
  kind: string;
  date: string;
  reference: string | null;
  debit: number;
  credit: number;
  /** Running balance after this movement. */
  balance: number;
};

export type PartyStatement = {
  id: string;
  name: string;
  roles: readonly string[];
  /** Balance carried into `from`, i.e. movements strictly before it. */
  openingBalance: number;
  /** Balance after the last movement on or before `to`. */
  closingBalance: number;
  movements: Page<PartyMovement>;
};

export type PartyStatementPorts = PagingPorts & {
  /** Returns null when the id is not a party of that role in the active book. */
  read(
    query: { partyId: string; role: 'customer' | 'supplier'; range: DateRange },
    location: LocationScope,
    scope: Scope,
    page: PageRequest,
  ): Promise<PartyStatement | null>;
};

export function partyStatementTool(ports: PartyStatementPorts): ReadTool {
  const name = 'read_party_statement';
  return readOnly({
    name,
    access: 'read',
    feature: 'parties',
    description: 'Read one known party id as a statement: opening balance, movements in the range, closing balance.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        partyId: idSchema, role: { type: 'string', enum: ['customer', 'supplier'], maxLength: 10 },
        from: dateSchema, to: dateSchema, cursor: cursorSchema,
      },
      required: ['partyId', 'role', 'from', 'to'],
    },
    authorize: (context) => permitted(ports.permissions, 'parties', context.scope),
    read: async (args, context) => {
      const range = readRange(args);
      const partyId = String(args.partyId ?? '');
      const roleArg = String(args.role ?? '');
      if (!partyId || (roleArg !== 'customer' && roleArg !== 'supplier')) throw new Error('INVALID_ARGUMENTS');
      const role = roleArg;
      const query = `party=${partyId}&role=${role}&from=${range.from}&to=${range.to}`;
      const request = pageRequest(ports.cursors, name, context.scope, query, args);

      await context.assertCurrent();
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const statement = await ports.read({ partyId, role, range }, location, context.scope, request);
      await context.assertCurrent();

      // An id the model produced from memory or from a document is not a party.
      // Ownership and role are proved by lookup, and a miss is an explicit
      // "not found", never an empty statement that reads as "owes nothing".
      if (!statement) {
        throw new ToolUnavailableError('PARTY_NOT_FOUND', `No ${role} with id ${partyId} exists in the active book`);
      }

      const movements = statement.movements.rows.map((movement) => ({
        id: requiredText(movement.id, 'movement.id'),
        kind: requiredText(movement.kind, 'movement.kind', 32),
        date: requiredText(movement.date, 'movement.date', 10),
        reference: optionalText(movement.reference, 40),
        debit: requiredNumber(movement.debit, `movement ${movement.id} debit`),
        credit: requiredNumber(movement.credit, `movement ${movement.id} credit`),
        balance: requiredNumber(movement.balance, `movement ${movement.id} balance`),
      }));
      const nextCursor = statement.movements.nextAnchor
        ? ports.cursors.issue(name, context.scope, query, statement.movements.nextAnchor)
        : null;

      return observe('v2-parties.statement', context, {
        partyId: requiredText(statement.id, 'party.id'),
        name: requiredText(statement.name, 'party.name', 80),
        roles: statement.roles.map((entry) => requiredText(entry, 'party.role', 16)),
        role,
        from: range.from,
        to: range.to,
        currency: context.scope.currency,
        location: describeLocation(location),
        // Labelled apart on purpose: an opening balance is cumulative history,
        // the movements are the period, and only their sum is the closing
        // balance. Reporting one as the other is defect B3.
        openingBalance: requiredNumber(statement.openingBalance, 'statement.openingBalance'),
        openingBalanceSemantics: 'cumulative_before_from',
        movements,
        movementSemantics: 'period_movement',
        closingBalance: requiredNumber(statement.closingBalance, 'statement.closingBalance'),
        closingBalanceSemantics: 'cumulative_as_of_to',
        balanceDirection: role === 'customer' ? 'positive_means_customer_owes_you' : 'positive_means_you_owe_supplier',
      }, nextCursor);
    },
  });
}

// ---------------------------------------------------------------------------
// search_entries / read_entry
// ---------------------------------------------------------------------------

/** The `v2_sources.type` values this branch actually posts. */
export const ENTRY_ENTITIES = [
  'cash_sale', 'invoice', 'receipt', 'cash_purchase', 'credit_purchase', 'supplier_payment', 'expense',
] as const;
export type EntryEntity = (typeof ENTRY_ENTITIES)[number];

/**
 * Each entity is gated by the feature that owns it, so turning Invoices off in
 * Customize Features removes invoices from search rather than only from the
 * menu.
 */
export const ENTRY_ENTITY_FEATURE: Readonly<Record<EntryEntity, string>> = {
  cash_sale: 'sales',
  invoice: 'invoices',
  receipt: 'receipts',
  cash_purchase: 'bills',
  credit_purchase: 'bills',
  supplier_payment: 'payments',
  expense: 'expenses',
};

export type EntrySummary = {
  id: string;
  entity: EntryEntity;
  date: string;
  amount: number;
  reference: string | null;
  partyId: string | null;
  partyName: string | null;
  /** Host-computed entity revision; used later to invalidate a stale proposal. */
  revision: string;
};

export type EntryAllocation = { invoiceId: string; amount: number };

export type EntryDetail = EntrySummary & {
  subtotal: number | null;
  tax: number | null;
  status: string | null;
  allocations: readonly EntryAllocation[];
  reversed: boolean;
  deleted: boolean;
  editable: boolean;
};

export type EntrySearchPorts = PagingPorts & {
  search(
    query: { entity: EntryEntity; range: DateRange; text: string | null },
    location: LocationScope,
    scope: Scope,
    page: PageRequest,
  ): Promise<Page<EntrySummary>>;
};

function entrySummaryDto(entry: EntrySummary): Obj {
  return {
    id: requiredText(entry.id, 'entry.id'),
    entity: requiredText(entry.entity, 'entry.entity', 32),
    date: requiredText(entry.date, 'entry.date', 10),
    amount: requiredNumber(entry.amount, `entry ${entry.id} amount`),
    reference: optionalText(entry.reference, 40),
    partyId: entry.partyId === null ? null : requiredText(entry.partyId, 'entry.partyId'),
    partyName: optionalText(entry.partyName, 80),
    revision: requiredText(entry.revision, 'entry.revision', 64),
  };
}

function readEntity(args: Obj): EntryEntity {
  const entity = String(args.entity ?? '');
  if (!(ENTRY_ENTITIES as readonly string[]).includes(entity)) throw new Error('INVALID_ARGUMENTS');
  return entity as EntryEntity;
}

async function assertEntityReadable(
  permissions: PermissionPorts, entity: EntryEntity, scope: Scope,
): Promise<void> {
  if (!await permissions.canRead(ENTRY_ENTITY_FEATURE[entity], scope)) throw new Error('FORBIDDEN');
}

export function entrySearchTool(ports: EntrySearchPorts): ReadTool {
  const name = 'search_entries';
  return readOnly({
    name,
    access: 'read',
    feature: 'entries',
    description: 'List posted entries of one kind in a date range, with their ids, dates and amounts.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        entity: { type: 'string', enum: ENTRY_ENTITIES, maxLength: 20 },
        from: dateSchema, to: dateSchema, query: querySchema, cursor: cursorSchema,
      },
      required: ['entity', 'from', 'to'],
    },
    authorize: (context) => permitted(ports.permissions, 'entries', context.scope),
    read: async (args, context) => {
      const entity = readEntity(args);
      const range = readRange(args);
      const text = optionalString(args, 'query');
      const query = `entity=${entity}&from=${range.from}&to=${range.to}&q=${text ?? ''}`;
      const request = pageRequest(ports.cursors, name, context.scope, query, args);

      await context.assertCurrent();
      await assertEntityReadable(ports.permissions, entity, context.scope);
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const found = await ports.search({ entity, range, text }, location, context.scope, request);
      await context.assertCurrent();

      const rows = found.rows.map(entrySummaryDto);
      const nextCursor = found.nextAnchor
        ? ports.cursors.issue(name, context.scope, query, found.nextAnchor)
        : null;

      return observe('v2-sources.search', context, {
        entity,
        from: range.from,
        to: range.to,
        query: text,
        currency: context.scope.currency,
        location: describeLocation(location),
        // Deliberately a row count for this page only: the model must page
        // rather than treat a first page as a period total.
        rowCount: rows.length,
        entries: rows,
      }, nextCursor);
    },
  });
}

export type EntryReadPorts = {
  permissions: PermissionPorts;
  /** Returns null when the id is not that entity in the active book and scope. */
  read(entity: EntryEntity, id: string, location: LocationScope, scope: Scope): Promise<EntryDetail | null>;
};

export function entryReadTool(ports: EntryReadPorts): ReadTool {
  return readOnly({
    name: 'read_entry',
    access: 'read',
    feature: 'entries',
    description: 'Read one known posted entry by id: amounts, party, allocations, revision and whether it can still be edited.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { entity: { type: 'string', enum: ENTRY_ENTITIES, maxLength: 20 }, id: idSchema },
      required: ['entity', 'id'],
    },
    authorize: (context) => permitted(ports.permissions, 'entries', context.scope),
    read: async (args, context) => {
      const entity = readEntity(args);
      const id = String(args.id ?? '');
      if (!id) throw new Error('INVALID_ARGUMENTS');

      await context.assertCurrent();
      await assertEntityReadable(ports.permissions, entity, context.scope);
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const entry = await ports.read(entity, id, location, context.scope);
      await context.assertCurrent();
      if (!entry) {
        throw new ToolUnavailableError('ENTRY_NOT_FOUND', `No ${entity} with id ${id} exists in the active book`);
      }

      // Built key by key rather than spread: whatever else a branch's source
      // metadata carries — payroll figures, sync tokens, encrypted payloads —
      // has no path from here into a prompt.
      return observe('v2-sources.entry', context, {
        ...entrySummaryDto(entry),
        currency: context.scope.currency,
        location: describeLocation(location),
        subtotal: optionalNumber(entry.subtotal, `entry ${id} subtotal`),
        tax: optionalNumber(entry.tax, `entry ${id} tax`),
        status: optionalText(entry.status, 24),
        allocations: entry.allocations.map((allocation) => ({
          invoiceId: requiredText(allocation.invoiceId, 'allocation.invoiceId'),
          amount: requiredNumber(allocation.amount, `allocation on ${id}`),
        })),
        reversed: Boolean(entry.reversed),
        deleted: Boolean(entry.deleted),
        editable: Boolean(entry.editable),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// read_unpaid_invoices
// ---------------------------------------------------------------------------

export type UnpaidInvoice = {
  id: string;
  partyId: string;
  partyName: string | null;
  date: string;
  dueDate: string | null;
  total: number;
  allocated: number;
  outstanding: number;
  status: string;
  revision: string;
};

export type UnpaidInvoicePorts = PagingPorts & {
  /** `partyId` null means every authorized customer. Returns null when a named party does not exist. */
  read(
    query: { partyId: string | null },
    location: LocationScope,
    scope: Scope,
    page: PageRequest,
  ): Promise<Page<UnpaidInvoice> | null>;
};

export function unpaidInvoicesTool(ports: UnpaidInvoicePorts): ReadTool {
  const name = 'read_unpaid_invoices';
  return readOnly({
    name,
    access: 'read',
    feature: 'invoices',
    description: 'List invoices with money still outstanding, with the maximum amount a receipt may allocate to each.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { partyId: idSchema, cursor: cursorSchema }, required: [],
    },
    authorize: (context) => permitted(ports.permissions, 'invoices', context.scope),
    read: async (args, context) => {
      const partyId = optionalString(args, 'partyId');
      const query = `party=${partyId ?? '*'}`;
      const request = pageRequest(ports.cursors, name, context.scope, query, args);

      await context.assertCurrent();
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const found = await ports.read({ partyId }, location, context.scope, request);
      await context.assertCurrent();
      if (!found) {
        throw new ToolUnavailableError('PARTY_NOT_FOUND', `No customer with id ${partyId} exists in the active book`);
      }

      const invoices = found.rows.map((invoice) => {
        const total = requiredNumber(invoice.total, `invoice ${invoice.id} total`);
        const allocated = requiredNumber(invoice.allocated, `invoice ${invoice.id} allocated`);
        const outstanding = requiredNumber(invoice.outstanding, `invoice ${invoice.id} outstanding`);
        return {
          id: requiredText(invoice.id, 'invoice.id'),
          partyId: requiredText(invoice.partyId, 'invoice.partyId'),
          partyName: optionalText(invoice.partyName, 80),
          date: requiredText(invoice.date, 'invoice.date', 10),
          dueDate: optionalText(invoice.dueDate, 10),
          total,
          allocatedToDate: allocated,
          outstanding,
          // Stated as a constraint, not a hint: a receipt may never allocate
          // more than this to this invoice.
          maximumFurtherAllocation: outstanding,
          status: requiredText(invoice.status, 'invoice.status', 24),
          revision: requiredText(invoice.revision, 'invoice.revision', 64),
        };
      });
      const nextCursor = found.nextAnchor
        ? ports.cursors.issue(name, context.scope, query, found.nextAnchor)
        : null;

      return observe('v2-invoices.unpaid', context, {
        partyId,
        currency: context.scope.currency,
        location: describeLocation(location),
        rowCount: invoices.length,
        invoices,
      }, nextCursor);
    },
  });
}

// ---------------------------------------------------------------------------
// read_cash_movements
// ---------------------------------------------------------------------------

export type CashMovement = {
  id: string;
  date: string;
  direction: 'in' | 'out';
  amount: number;
  sourceId: string | null;
  sourceType: string | null;
};

export type CashMovementReport = {
  openingBalance: number;
  closingBalance: number;
  totalIn: number;
  totalOut: number;
  movements: Page<CashMovement>;
};

export type CashMovementPorts = PagingPorts & {
  read(
    range: DateRange,
    location: LocationScope,
    scope: Scope,
    page: PageRequest,
  ): Promise<CashMovementReport>;
};

export function cashMovementsTool(ports: CashMovementPorts): ReadTool {
  const name = 'read_cash_movements';
  return readOnly({
    name,
    access: 'read',
    feature: 'cashbook',
    description: 'Read posted cash and bank account movements for a date range, with opening and closing balances.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { from: dateSchema, to: dateSchema, cursor: cursorSchema }, required: ['from', 'to'],
    },
    authorize: (context) => permitted(ports.permissions, 'cashbook', context.scope),
    read: async (args, context) => {
      const range = readRange(args);
      const query = `from=${range.from}&to=${range.to}`;
      const request = pageRequest(ports.cursors, name, context.scope, query, args);

      await context.assertCurrent();
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const report = await ports.read(range, location, context.scope, request);
      await context.assertCurrent();

      const openingBalance = requiredNumber(report.openingBalance, 'cash.openingBalance');
      const closingBalance = requiredNumber(report.closingBalance, 'cash.closingBalance');
      const totalIn = requiredNumber(report.totalIn, 'cash.totalIn');
      const totalOut = requiredNumber(report.totalOut, 'cash.totalOut');
      assertReconciles(closingBalance, openingBalance + totalIn - totalOut,
        'cash movements do not reconcile opening to closing balance');

      const movements = report.movements.rows.map((movement) => {
        if (movement.direction !== 'in' && movement.direction !== 'out') {
          throw new ToolUnavailableError('MISSING_REPORT_FIELD', `movement ${movement.id} has no direction`);
        }
        return {
          id: requiredText(movement.id, 'movement.id'),
          date: requiredText(movement.date, 'movement.date', 10),
          direction: movement.direction,
          amount: requiredNumber(movement.amount, `movement ${movement.id} amount`),
          sourceId: movement.sourceId === null ? null : requiredText(movement.sourceId, 'movement.sourceId'),
          sourceType: optionalText(movement.sourceType, 32),
        };
      });
      const nextCursor = report.movements.nextAnchor
        ? ports.cursors.issue(name, context.scope, query, report.movements.nextAnchor)
        : null;

      return observe('v2-cash.movements', context, {
        // Named for what it is. These are posted movements on the cash/bank
        // accounts; they are NOT classified into operating, investing and
        // financing, so calling this a cash flow statement would be a lie —
        // which is precisely what the old `report_query` 'cash_flow' branch did
        // by relabelling a dashboard summary.
        reportType: 'posted_cash_and_bank_movements',
        isFormalCashFlowStatement: false,
        semantics: 'period_movement_with_opening_and_closing',
        from: range.from,
        to: range.to,
        currency: context.scope.currency,
        location: describeLocation(location),
        openingBalance,
        totalIn,
        totalOut,
        closingBalance,
        rowCount: movements.length,
        movements,
      }, nextCursor);
    },
  });
}

// ---------------------------------------------------------------------------
// read_inventory
// ---------------------------------------------------------------------------

export type InventoryValuation = {
  /** Journal-derived inventory account balance at the period end. */
  expectedValue: number;
  openingValue: number;
  lastCountedValue: number | null;
  lastCountDate: string | null;
  purchasesSince: number;
  salesSince: number;
  periodStart: string;
  periodEnd: string;
  /** True when this period's cost of sales is still an estimate, not posted. */
  costOfGoodsSoldProvisional: boolean;
};

export type InventoryProduct = {
  id: string;
  name: string;
  unit: string | null;
  quantity: number;
  locationId: string | null;
};

export type InventoryReport = {
  /** Null when there is no active period to value stock against. */
  valuation: InventoryValuation | null;
  /** Null when perpetual product tracking is not enabled for this book. */
  products: Page<InventoryProduct> | null;
};

export type InventoryPorts = PagingPorts & {
  read(
    query: { productQuery: string | null },
    location: LocationScope,
    scope: Scope,
    page: PageRequest,
  ): Promise<InventoryReport>;
};

export function inventoryTool(ports: InventoryPorts): ReadTool {
  const name = 'read_inventory';
  return readOnly({
    name,
    access: 'read',
    feature: 'inventory',
    description: 'Read stock valuation for the current period and, where product tracking is on, product quantities.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: querySchema, cursor: cursorSchema }, required: [],
    },
    authorize: (context) => permitted(ports.permissions, 'inventory', context.scope),
    read: async (args, context) => {
      const productQuery = optionalString(args, 'query');
      const query = `q=${productQuery ?? ''}`;
      const request = pageRequest(ports.cursors, name, context.scope, query, args);

      await context.assertCurrent();
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const report = await ports.read({ productQuery }, location, context.scope, request);
      await context.assertCurrent();

      // "Not valued yet" and "valued at zero" are different answers, so the
      // absent case carries a reason and no numbers at all.
      const valuation: Obj = report.valuation === null
        ? { available: false, reason: 'NO_ACTIVE_PERIOD_TO_VALUE_STOCK' }
        : {
          available: true,
          mode: 'periodic-count',
          unit: 'currency-value',
          periodStart: requiredText(report.valuation.periodStart, 'inventory.periodStart', 10),
          periodEnd: requiredText(report.valuation.periodEnd, 'inventory.periodEnd', 10),
          openingValue: requiredNumber(report.valuation.openingValue, 'inventory.openingValue'),
          expectedValue: requiredNumber(report.valuation.expectedValue, 'inventory.expectedValue'),
          lastCountedValue: optionalNumber(report.valuation.lastCountedValue, 'inventory.lastCountedValue'),
          lastCountDate: optionalText(report.valuation.lastCountDate, 10),
          purchasesSince: requiredNumber(report.valuation.purchasesSince, 'inventory.purchasesSince'),
          salesSince: requiredNumber(report.valuation.salesSince, 'inventory.salesSince'),
          costOfGoodsSoldProvisional: Boolean(report.valuation.costOfGoodsSoldProvisional),
        };

      const products: Obj = report.products === null
        ? { available: false, reason: 'PERPETUAL_PRODUCT_TRACKING_NOT_ENABLED' }
        : {
          available: true,
          unit: 'quantity',
          rowCount: report.products.rows.length,
          rows: report.products.rows.map((product) => ({
            id: requiredText(product.id, 'product.id'),
            name: requiredText(product.name, 'product.name', 80),
            unit: optionalText(product.unit, 16),
            quantity: requiredNumber(product.quantity, `product ${product.id} quantity`),
            locationId: product.locationId === null ? null : requiredText(product.locationId, 'product.locationId'),
          })),
        };

      const nextCursor = report.products?.nextAnchor
        ? ports.cursors.issue(name, context.scope, query, report.products.nextAnchor)
        : null;

      return observe('v2-inventory.overview', context, {
        query: productQuery,
        currency: context.scope.currency,
        location: describeLocation(location),
        valuation,
        products,
        // Stated so the model cannot reach for the shortcut the old helper took:
        // purchases are not cost of goods sold. COGS comes from the P&L report.
        costOfGoodsSoldSource: 'not_included_here_read_profit_and_loss',
      }, nextCursor);
    },
  });
}

// ---------------------------------------------------------------------------
// read_business_accounts
// ---------------------------------------------------------------------------

export type BusinessAccountMember = {
  id: string;
  name: string;
  profitSharePct: number;
  openingCapital: number;
  injected: number;
  drawings: number;
  currentCapital: number;
  revision: string;
};

export type BusinessAccountsReport = {
  periodStart: string;
  periodEnd: string;
  /** Profit available to allocate for the stated period, or null when not computed. */
  allocatableProfit: number | null;
  members: Page<BusinessAccountMember>;
};

export type BusinessAccountPorts = PagingPorts & {
  /** Returns null when a named member id does not exist in the active book. */
  read(
    query: { memberId: string | null },
    location: LocationScope,
    scope: Scope,
    page: PageRequest,
  ): Promise<BusinessAccountsReport | null>;
};

export function businessAccountsTool(ports: BusinessAccountPorts): ReadTool {
  const name = 'read_business_accounts';
  return readOnly({
    name,
    access: 'read',
    feature: 'business_accounts',
    description: 'Read Business Accounts: each member\'s capital, injections, drawings and share for the current period.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { memberId: idSchema, cursor: cursorSchema }, required: [],
    },
    authorize: (context) => permitted(ports.permissions, 'business_accounts', context.scope),
    read: async (args, context) => {
      const memberId = optionalString(args, 'memberId');
      const query = `member=${memberId ?? '*'}`;
      const request = pageRequest(ports.cursors, name, context.scope, query, args);

      await context.assertCurrent();
      const location = await resolveLocationScope(ports.permissions, context.scope);
      const report = await ports.read({ memberId }, location, context.scope, request);
      await context.assertCurrent();
      if (!report) {
        throw new ToolUnavailableError('MEMBER_NOT_FOUND', `No Business Account member with id ${memberId} exists`);
      }

      const members = report.members.rows.map((member) => ({
        id: requiredText(member.id, 'member.id'),
        name: requiredText(member.name, 'member.name', 80),
        profitSharePct: requiredNumber(member.profitSharePct, `member ${member.id} profitSharePct`),
        openingCapital: requiredNumber(member.openingCapital, `member ${member.id} openingCapital`),
        injected: requiredNumber(member.injected, `member ${member.id} injected`),
        drawings: requiredNumber(member.drawings, `member ${member.id} drawings`),
        currentCapital: requiredNumber(member.currentCapital, `member ${member.id} currentCapital`),
        revision: requiredText(member.revision, 'member.revision', 64),
      }));
      const nextCursor = report.members.nextAnchor
        ? ports.cursors.issue(name, context.scope, query, report.members.nextAnchor)
        : null;

      return observe('v2-business-accounts', context, {
        memberId,
        currency: context.scope.currency,
        location: describeLocation(location),
        periodStart: requiredText(report.periodStart, 'businessAccounts.periodStart', 10),
        periodEnd: requiredText(report.periodEnd, 'businessAccounts.periodEnd', 10),
        allocatableProfit: optionalNumber(report.allocatableProfit, 'businessAccounts.allocatableProfit'),
        rowCount: members.length,
        members,
      }, nextCursor);
    },
  });
}

// ---------------------------------------------------------------------------
// describe_capabilities
// ---------------------------------------------------------------------------

export type CoverageMode = 'read' | 'proposal' | 'guided-screen' | 'blocked';

export type CoverageRow = {
  feature: string;
  mode: CoverageMode;
  tools: readonly string[];
  /** Compiled allowlisted route, never a model-generated URL. */
  route?: string;
  reason?: string;
};

export type CapabilityReport = {
  enabledFeatures: readonly string[];
  coverage: readonly CoverageRow[];
  navigationTargets: readonly { screenId: string; label: string }[];
};

export type CapabilityPorts = {
  permissions: PermissionPorts;
  read(scope: Scope): Promise<CapabilityReport>;
};

const COVERAGE_MODES: readonly CoverageMode[] = ['read', 'proposal', 'guided-screen', 'blocked'];

export function describeCapabilitiesTool(ports: CapabilityPorts): ReadTool {
  return readOnly({
    name: 'describe_capabilities',
    access: 'read',
    feature: 'core',
    description: 'List what this book has turned on and which of those the assistant can read, propose or only guide you to.',
    parameters: noArgsSchema,
    authorize: (context) => ports.permissions.canRead('core', context.scope),
    read: async (_args, context) => {
      await context.assertCurrent();
      const report = await ports.read(context.scope);
      await context.assertCurrent();

      // Settings hold API keys, sync tokens and passphrases. This tool answers
      // from the feature/coverage register only, and rebuilds each row from a
      // fixed set of keys so nothing else can ride along.
      const coverage = report.coverage.slice(0, 40).map((row) => {
        if (!COVERAGE_MODES.includes(row.mode)) {
          throw new ToolUnavailableError('INVALID_COVERAGE_ROW', `Unknown coverage mode for ${row.feature}`);
        }
        return {
          feature: requiredText(row.feature, 'coverage.feature', 40),
          mode: row.mode,
          tools: row.tools.slice(0, 12).map((tool) => requiredText(tool, 'coverage.tool', 40)),
          route: optionalText(row.route, 60),
          reason: optionalText(row.reason, 120),
        };
      });

      return observe('app-capability-register', context, {
        bookId: context.scope.bookId,
        currency: context.scope.currency,
        basis: context.scope.basis,
        today: context.scope.today,
        timeZone: context.scope.timeZone,
        enabledFeatures: report.enabledFeatures.slice(0, 40).map((feature) => requiredText(feature, 'feature', 40)),
        coverage,
        navigationTargets: report.navigationTargets.slice(0, 20).map((target) => ({
          screenId: requiredText(target.screenId, 'navigation.screenId', 40),
          label: requiredText(target.label, 'navigation.label', 60),
        })),
        secretsIncluded: false,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type CoreReadPorts = {
  permissions: PermissionPorts;
  cursors: CursorStore;
  profitAndLoss: PnlPorts['read'];
  trialBalance: TrialBalancePorts['read'];
  balanceSheet: BalanceSheetPorts['read'];
  parties: PartySearchPorts['search'];
  partyStatement: PartyStatementPorts['read'];
  entries: EntrySearchPorts['search'];
  entry: EntryReadPorts['read'];
  unpaidInvoices: UnpaidInvoicePorts['read'];
  cashMovements: CashMovementPorts['read'];
  inventory: InventoryPorts['read'];
  businessAccounts: BusinessAccountPorts['read'];
  capabilities: CapabilityPorts['read'];
};

/**
 * Builds every read tool from one set of branch ports.
 *
 * The registry is the full menu; a single turn is served a bundle of at most
 * eight (see toolBundles.ts). Advertising all of them at once would blow the
 * 4,096-token context before the question is even read.
 */
export function createCoreReadTools(ports: CoreReadPorts): ReadTool[] {
  const { permissions, cursors } = ports;
  return [
    profitAndLossTool({ permissions, read: ports.profitAndLoss }),
    trialBalanceTool({ permissions, cursors, read: ports.trialBalance }),
    balanceSheetTool({ permissions, read: ports.balanceSheet }),
    partySearchTool({ permissions, cursors, search: ports.parties }),
    partyStatementTool({ permissions, cursors, read: ports.partyStatement }),
    entrySearchTool({ permissions, cursors, search: ports.entries }),
    entryReadTool({ permissions, read: ports.entry }),
    unpaidInvoicesTool({ permissions, cursors, read: ports.unpaidInvoices }),
    cashMovementsTool({ permissions, cursors, read: ports.cashMovements }),
    inventoryTool({ permissions, cursors, read: ports.inventory }),
    businessAccountsTool({ permissions, cursors, read: ports.businessAccounts }),
    describeCapabilitiesTool({ permissions, read: ports.capabilities }),
  ];
}

export const CORE_READ_TOOL_NAMES = [
  'read_profit_and_loss', 'read_trial_balance', 'read_balance_sheet',
  'search_parties', 'read_party_statement', 'search_entries', 'read_entry',
  'read_unpaid_invoices', 'read_cash_movements', 'read_inventory',
  'read_business_accounts', 'describe_capabilities',
] as const;
export type CoreReadToolName = (typeof CORE_READ_TOOL_NAMES)[number];
