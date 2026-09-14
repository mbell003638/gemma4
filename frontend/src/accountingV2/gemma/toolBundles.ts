/**
 * Per-feature tool bundles.
 *
 * The registry in `coreReadTools.ts` is the full menu; a single turn is served
 * a small subset of it. That is not tidiness — E2B runs with a 4,096-token
 * context, and twelve tool schemas plus a system prompt plus a question plus
 * room to answer does not fit. Advertising everything would spend the budget
 * before the model read the question.
 *
 * Selection is by UI context (Reports, invoice detail, scan review) or by a
 * read-only planner. It is never influenced by a name that appeared in a
 * retrieved document or in model output: a bundle is chosen from this compiled
 * table, and then intersected with what is enabled and authorized.
 *
 * See docs/plans/gemma4-litertlm/03-agent-and-tools.md section 7.
 */
import { MAX_TOOLS_PER_RUN, type Tool, type ToolContext } from './agentCore';
import { CORE_READ_TOOL_NAMES, type CoreReadToolName } from './coreReadTools';

export type BundleId =
  | 'reports'
  | 'parties'
  | 'receivables'
  | 'entries'
  | 'cash'
  | 'inventory'
  | 'businessAccounts'
  | 'capabilities';

export type Bundle = {
  id: BundleId;
  label: string;
  /** Why a turn would want this bundle. Used by the planner, not shown to users. */
  purpose: string;
  tools: readonly CoreReadToolName[];
};

/**
 * `describe_capabilities` is in almost every bundle on purpose: the most common
 * wrong answer a local model gives is confidently describing a feature this
 * book does not have turned on.
 */
export const BUNDLES: readonly Bundle[] = [
  {
    id: 'reports',
    label: 'Reports',
    purpose: 'Profit, balances and trial balance for a period or an as-of date.',
    tools: ['read_profit_and_loss', 'read_balance_sheet', 'read_trial_balance', 'describe_capabilities'],
  },
  {
    id: 'parties',
    label: 'Customers and suppliers',
    purpose: 'Who a party is, what they owe or are owed, and their movements.',
    tools: ['search_parties', 'read_party_statement', 'read_unpaid_invoices', 'describe_capabilities'],
  },
  {
    id: 'receivables',
    label: 'Invoices and receipts',
    purpose: 'Outstanding invoices and how much a receipt may allocate.',
    tools: ['search_parties', 'read_unpaid_invoices', 'read_entry', 'describe_capabilities'],
  },
  {
    id: 'entries',
    label: 'Entries',
    purpose: 'Finding and reading individual posted records.',
    tools: ['search_entries', 'read_entry', 'search_parties', 'describe_capabilities'],
  },
  {
    id: 'cash',
    label: 'Cash and bank',
    purpose: 'Posted cash movements with opening and closing reconciliation.',
    tools: ['read_cash_movements', 'search_entries', 'describe_capabilities'],
  },
  {
    id: 'inventory',
    label: 'Stock',
    purpose: 'Stock valuation and quantities, with their provisional caveats.',
    tools: ['read_inventory', 'read_profit_and_loss', 'describe_capabilities'],
  },
  {
    id: 'businessAccounts',
    label: 'Business Accounts',
    purpose: 'Member capital, drawings and allocations.',
    tools: ['read_business_accounts', 'describe_capabilities'],
  },
  {
    id: 'capabilities',
    label: 'What this app can do',
    purpose: 'Answering what is available, without reading the book at all.',
    tools: ['describe_capabilities'],
  },
];

export function bundle(id: BundleId): Bundle {
  const found = BUNDLES.find((entry) => entry.id === id);
  if (!found) throw new Error('UNKNOWN_BUNDLE');
  return found;
}

/**
 * A one-line menu for a read-only planner turn.
 *
 * Deliberately just ids and purposes: the planner picks a bundle, it does not
 * get to invent a tool list.
 */
export function bundleMenu(): string {
  return BUNDLES.map((entry) => `${entry.id}: ${entry.purpose}`).join('\n');
}

/**
 * Resolves a planner's or the UI's bundle choice to real, authorized tools.
 *
 * Two filters, in this order:
 *   1. the bundle table, which is compiled in;
 *   2. `authorize`, which is the actor's real permission for that feature.
 *
 * Anything the planner named that is not in the table is dropped rather than
 * looked up, so a document that says "use read_all_payroll" cannot widen the
 * turn. An unknown bundle id falls back to capabilities-only, which reads
 * nothing from the book.
 */
export async function selectBundleTools(
  requested: string,
  registry: readonly Tool[],
  context: ToolContext,
): Promise<{ bundle: Bundle; tools: Tool[]; dropped: string[] }> {
  const chosen = BUNDLES.find((entry) => entry.id === requested) ?? bundle('capabilities');
  const byName = new Map(registry.map((tool) => [tool.name, tool]));
  const tools: Tool[] = [];
  const dropped: string[] = [];

  for (const name of chosen.tools) {
    const tool = byName.get(name);
    if (!tool) {
      // A bundle naming a tool this build does not register is a build
      // mismatch, and reported rather than silently tolerated.
      dropped.push(name);
      continue;
    }
    if (!await tool.authorize(context)) {
      dropped.push(name);
      continue;
    }
    tools.push(tool);
  }

  if (tools.length > MAX_TOOLS_PER_RUN) throw new Error('BUNDLE_TOO_LARGE');
  return { bundle: chosen, tools, dropped };
}

/**
 * Build-time guard.
 *
 * Called from tests: a bundle that names a tool nobody registers, or that
 * exceeds the per-turn ceiling, is a mistake that should fail in CI rather
 * than become an empty tool list on a user's phone.
 */
export function assertBundlesWellFormed(): void {
  const known = new Set<string>(CORE_READ_TOOL_NAMES);
  const seen = new Set<string>();
  for (const entry of BUNDLES) {
    if (seen.has(entry.id)) throw new Error(`DUPLICATE_BUNDLE:${entry.id}`);
    seen.add(entry.id);
    if (!entry.tools.length) throw new Error(`EMPTY_BUNDLE:${entry.id}`);
    if (entry.tools.length > MAX_TOOLS_PER_RUN) throw new Error(`BUNDLE_TOO_LARGE:${entry.id}`);
    if (new Set(entry.tools).size !== entry.tools.length) throw new Error(`DUPLICATE_TOOL:${entry.id}`);
    for (const name of entry.tools) {
      if (!known.has(name)) throw new Error(`UNKNOWN_TOOL:${entry.id}:${name}`);
    }
  }
}
