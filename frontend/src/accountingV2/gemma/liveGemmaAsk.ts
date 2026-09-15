import { activeSqlRunner } from '../../db/backend';
import { installedGemmaRuntime, type InstalledGemmaRuntime } from '../../utils/gemmaNative';
import { createAgent, type AgentResult, type Obj, type Tool } from './agentCore';
import { createAccountingReportPorts } from './accountingReportPorts';
import { createCoreReadTools, createCursorStore } from './coreReadTools';
import { COVERAGE, CORE_COVERAGE } from './coverage';
import { createLiveDataPorts } from './liveDataPorts';
import { createLivePermissions, createLiveScopeGuard, liveScopePorts } from './liveScopePorts';
import { buildScope } from './scopeContext';
import { bundle, type BundleId } from './toolBundles';
import { createProposalTools } from './proposalRegistry';
import { validateAssistantProposal } from '../aiActions';
import { LIVE_GEMMA_PROPOSALS } from './liveProposalPolicy';
import { captureAssistantScope, enabledFor } from './liveProposalController';
import { sameScope } from './agentCore';

const cursorStore = createCursorStore();

export function chooseGemmaReadBundle(question: string): BundleId {
  const q = question.toLowerCase();
  if (/\b(stock|inventory|product|quantity|valuation)\b/.test(q)) return 'inventory';
  if (/\b(customer|supplier|party|parties|owe|owes|owed|receivable|payable|invoice|receipt)\b/.test(q)) return 'parties';
  if (/\b(cash|bank|money in|money out|cashbook)\b/.test(q)) return 'cash';
  if (/\b(entry|entries|transaction|journal|daybook|reference)\b/.test(q)) return 'entries';
  if (/\b(capital|drawing|partner|member|business account)\b/.test(q)) return 'businessAccounts';
  if (/\b(profit|loss|balance sheet|trial balance|revenue|expense|report|sales total|cogs)\b/.test(q)) return 'reports';
  if (/\b(can you|what can|feature|screen|support|capabilit)\b/.test(q)) return 'capabilities';
  return 'capabilities';
}

function enabledFromEpoch(epoch: string): string[] {
  try {
    const value: unknown = JSON.parse(epoch);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function capabilityReport(scope: Awaited<ReturnType<typeof buildScope>>) {
  const enabled = enabledFromEpoch(scope.featureEpoch);
  const rows = [...COVERAGE, ...CORE_COVERAGE.map((row) => ({ ...row, feature: row.area }))];
  return {
    enabledFeatures: enabled,
    coverage: rows
      .filter((row) => enabled.includes(row.feature) || row.feature === 'parties' || row.feature === 'businessAccounts')
      .map((row) => ({ feature: row.feature, mode: row.mode, tools: row.tools, route: row.route, reason: row.reason })),
    navigationTargets: rows
      .filter((row) => row.route)
      .map((row) => ({ screenId: row.route!, label: row.feature })),
  };
}

export type LiveGemmaAskDeps = {
  captureScope?: typeof captureAssistantScope;
  runtime: typeof installedGemmaRuntime;
  run: (tools: Tool[], currentScope: () => Promise<Awaited<ReturnType<typeof buildScope>>>, runtime: InstalledGemmaRuntime, question: string, canPropose: boolean) => Promise<AgentResult>;
};

const GLOSSARY = 'Sales are income; bills and supplier payments are purchases/payables; Business Accounts are member capital and drawings. Never treat purchases as COGS unless the accounting report does.';

function runLiveAgent(
  tools: Tool[],
  currentScope: () => Promise<Awaited<ReturnType<typeof buildScope>>>,
  runtime: InstalledGemmaRuntime,
  question: string,
  canPropose: boolean,
  requestId: string,
): Promise<AgentResult> {
  return createAgent(runtime.engine)({
    requestId,
    modelId: runtime.modelId,
    question,
    glossary: GLOSSARY,
    tools,
    currentScope,
    canPropose,
  });
}

const productionDeps: LiveGemmaAskDeps = {
  runtime: installedGemmaRuntime,
  run: async (tools, currentScope, runtime, question, canPropose) =>
    runLiveAgent(tools, currentScope, runtime, question, canPropose, `ask-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`),
};

/** Runs Gemma over scoped tools only. No serialized whole-book snapshot is supplied. */
const PROPOSAL_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  expenses: ['add_expense', 'log_personal_expense'],
  sales: ['add_sale', 'add_debtor_payment'],
  bills: ['add_bill', 'create_supplier_payment'],
  invoices: ['create_invoice', 'create_receipt'],
  businessAccounts: ['add_capital', 'create_drawing'],
  inventory: ['record_inventory'],
  parties: ['add_debtor', 'add_supplier'],
};

export function chooseGemmaProposalFamily(question: string): keyof typeof PROPOSAL_FAMILIES | null {
  const q = question.toLowerCase();
  if (/\b(add|create|new)\b.*\b(customer|debtor|supplier)\b|\b(customer|debtor|supplier)\b.*\b(add|create|new)\b/.test(q)) return 'parties';
  if (/\b(stock|inventory|count)\b/.test(q)) return 'inventory';
  if (/\b(capital|drawing|withdrawal|partner|member)\b/.test(q)) return 'businessAccounts';
  if (/\b(invoice|receipt)\b/.test(q)) return 'invoices';
  if (/\b(bill|supplier|purchase|pay supplier)\b/.test(q)) return 'bills';
  if (/\b(customer payment|debtor payment|sale|sold)\b/.test(q)) return 'sales';
  if (/\b(expense|spent|paid for|personal)\b/.test(q)) return 'expenses';
  return null;
}

export async function askWithLiveGemma(
  question: string,
  allowProposals = false,
  deps: LiveGemmaAskDeps = productionDeps,
): Promise<AgentResult | null> {
  const originScope = Object.freeze({ ...await (deps.captureScope ?? captureAssistantScope)() });
  const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const runtime = await deps.runtime();
  if (!sameScope(originScope, await (deps.captureScope ?? captureAssistantScope)())) {
    return { kind: 'stopped', code: 'STALE_SCOPE' };
  }
  const db = activeSqlRunner();
  if (!runtime || !db) return null;
  const scopePorts = liveScopePorts();
  const currentScope = async () => {
    const scope = await buildScope(scopePorts);
    if (!sameScope(originScope, scope)) throw new Error('STALE_SCOPE');
    return scope;
  };
  const guard = createLiveScopeGuard(scopePorts);
  const permissions = createLivePermissions(scopePorts);
  const reports = createAccountingReportPorts(db, guard);
  const data = createLiveDataPorts(db, permissions, guard);
  const registry = createCoreReadTools({
    permissions,
    cursors: cursorStore,
    ...reports,
    ...data,
    capabilities: async (scope) => capabilityReport(scope),
  });
  const names = new Set<string>(bundle(chooseGemmaReadBundle(question)).tools);
  const tools: Tool[] = registry.filter((tool) => names.has(tool.name));
  if (allowProposals) {
    const family = chooseGemmaProposalFamily(question);
    const selected = new Set(family ? PROPOSAL_FAMILIES[family] : []);
    const proposals = createProposalTools({
      canPrepare: async (operation, _feature, expected) => LIVE_GEMMA_PROPOSALS.has(operation)
        && selected.has(operation) && expected.actorId === 'local-owner' && enabledFor(operation, expected),
      prepare: async (operation, args, expected) => {
        const checked = validateAssistantProposal({ type: operation, params: args }, 'ai');
        if (!checked.ok) throw new Error('INVALID_PROPOSAL');
        const normalized = checked.action.params as Obj;
        if (operation === 'add_sale' && normalized.paymentType === 'credit') {
          throw new Error('GUIDED_SCREEN_ONLY_CREDIT_SALE');
        }
        const entityVersions: Record<string, string> = {};
        const bindRevision = async (id: string) => {
          const row = await db.first<{ revision: number }>(
            'SELECT MAX(revision) revision FROM sync_entity_revisions WHERE book_id=? AND aggregate_id=?',
            [expected.bookId, id],
          );
          entityVersions[id] = String(Number(row?.revision || 0));
        };
        const exactParty = async (field: string, role: 'customer' | 'supplier') => {
          const name = String(normalized[field] || '').trim();
          const rows = await db.all<{ id: string; name: string; roles: string }>(
            'SELECT id,name,roles FROM v2_parties WHERE book_id=? AND archived=0 AND lower(trim(name))=lower(trim(?))',
            [expected.bookId, name],
          );
          const matches = rows.filter((row) => {
            try { return (JSON.parse(row.roles) as unknown[]).includes(role); } catch { return false; }
          });
          if (matches.length !== 1) throw new Error(matches.length ? 'AMBIGUOUS_PARTY' : 'UNKNOWN_PARTY');
          normalized[field] = matches[0].name;
          normalized[`${field}Id`] = matches[0].id;
          await bindRevision(matches[0].id);
        };
        if (operation === 'add_debtor' || operation === 'add_supplier') {
          const role = operation === 'add_debtor' ? 'customer' : 'supplier';
          const name = String(normalized.name || '').trim();
          const rows = await db.all<{ roles: string }>(
            'SELECT roles FROM v2_parties WHERE book_id=? AND archived=0 AND lower(trim(name))=lower(trim(?))',
            [expected.bookId, name],
          );
          const exists = rows.some((row) => {
            try { return (JSON.parse(row.roles) as unknown[]).includes(role); } catch { return false; }
          });
          if (exists) throw new Error('PARTY_ALREADY_EXISTS');
        }
        if (operation === 'add_bill' || operation === 'create_supplier_payment') await exactParty('supplierName', 'supplier');
        if (operation === 'add_debtor_payment') await exactParty('name', 'customer');
        if (operation === 'create_invoice') await exactParty('clientName', 'customer');
        if (operation === 'create_receipt' && normalized.mode !== 'cash_sale') await exactParty('customerName', 'customer');
        if (operation === 'create_receipt' && normalized.mode === 'against_invoice') {
          const invoiceId = String(normalized.invoiceId || '');
          const invoice = await db.first<{ id: string }>(
            "SELECT id FROM v2_sources WHERE id=? AND book_id=? AND type='invoice'",
            [invoiceId, expected.bookId],
          );
          if (!invoice) throw new Error('UNKNOWN_INVOICE');
          await bindRevision(invoice.id);
        }
        if (operation === 'add_capital' || operation === 'create_drawing') {
          const name = String(normalized.partnerName || '').trim();
          const members = await db.all<{ id: string; name: string }>(
            'SELECT id,name FROM v2_members WHERE book_id=? AND lower(trim(name))=lower(trim(?))',
            [expected.bookId, name],
          );
          if (members.length !== 1) throw new Error(members.length ? 'AMBIGUOUS_MEMBER' : 'UNKNOWN_MEMBER');
          normalized.partnerName = members[0].name;
          normalized.memberId = members[0].id;
          await bindRevision(members[0].id);
        }
        return {
          operation,
          normalized,
          preview: checked.action.confirmation.preview,
          destructive: checked.action.isDestructive === true,
          entityVersions,
        };
      },
    }).filter((tool) => LIVE_GEMMA_PROPOSALS.has(tool.name) && selected.has(tool.name));
    tools.push(...proposals.slice(0, Math.max(0, 8 - tools.length)));
  }
  if (deps.run === productionDeps.run) {
    return runLiveAgent(tools, currentScope, runtime, question, allowProposals, requestId);
  }
  return deps.run(tools, currentScope, runtime, question, allowProposals);
}
