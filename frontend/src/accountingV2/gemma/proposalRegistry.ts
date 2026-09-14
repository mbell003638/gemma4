/**
 * Typed schemas for the sixteen assistant write operations (stage P5).
 *
 * These sit AHEAD of `validateAssistantProposal`, not instead of it. That
 * validator is tested, handles normalization the domain depends on, and keeps
 * running — but it is deliberately forgiving at the edges, because it was
 * written for a grammar-constrained local model and for parsed speech. It
 * coerces `params.amount` through `assistantAmount`, so `"1,250"` and `" 1250 "`
 * become numbers.
 *
 * That is the right behaviour for a transcript. It is the wrong behaviour for a
 * tool schema: a model that can hand back `"1,250"` can also hand back `"1.250"`
 * and mean twelve hundred and fifty in a locale that reads it as one and a
 * quarter. So the schemas here require a finite JSON number in range, reject
 * unknown properties, and then pass the result to the existing validator, which
 * still gets the final say.
 *
 * Field names below are the ones `aiActions.ts` actually reads (`supplierName`,
 * `clientName`, `partnerName`, `name`, `mode`, `invoiceId`, ...). Wording in
 * descriptions is the app's own: Business Accounts, supplier payment, receipt.
 */
import { MAX_AI_AMOUNT, MIN_AI_YEAR, MAX_AI_YEAR, type AssistantProposalType } from '../aiActions';
import type { Draft, Obj, ProposalTool, Schema, Scope } from './agentCore';
import { validate } from './agentCore';

const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}$';

/**
 * Amounts are finite JSON numbers within the app's accepted range.
 *
 * `minimum: 0.01` rather than 0: a zero-value sale or expense is a mistake the
 * user should see, not something to post silently. `record_inventory` overrides
 * this, because a genuine count of nothing is meaningful.
 */
const amount: Schema = { type: 'number', minimum: 0.01, maximum: MAX_AI_AMOUNT };
const countAmount: Schema = { type: 'number', minimum: 0, maximum: MAX_AI_AMOUNT };
const dateField: Schema = { type: 'string', pattern: ISO_DATE, maxLength: 10 };
const nameField: Schema = { type: 'string', maxLength: 120 };
const notesField: Schema = { type: 'string', maxLength: 500 };
const idField: Schema = { type: 'string', maxLength: 120 };

/** The five methods `aiActions.METHODS` accepts. 'upi' is normalized to 'mobile' there. */
const methodField: Schema = { type: 'string', enum: ['cash', 'bank', 'card', 'mobile', 'other'], maxLength: 10 };
const paymentTypeField: Schema = { type: 'string', enum: ['cash', 'credit'], maxLength: 10 };
const receiptModeField: Schema = { type: 'string', enum: ['cash_sale', 'against_invoice', 'advance'], maxLength: 20 };

function object(properties: Record<string, Schema>, required: readonly string[]): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export type ProposalDescriptor = {
  operation: AssistantProposalType;
  feature: string;
  description: string;
  schema: Schema;
  /** True for anything that removes or reverses value the user can already see. */
  destructive: boolean;
};

/**
 * Every operation in `ASSISTANT_PROPOSAL_TYPES`, with a closed schema.
 *
 * `date` is optional throughout: the existing validator defaults it to the
 * device's local today, and a trusted default is better than asking a small
 * model to restate a date it was never told.
 */
export const PROPOSAL_DESCRIPTORS: readonly ProposalDescriptor[] = [
  {
    operation: 'add_expense',
    feature: 'expenses',
    description: 'Record a business expense paid by the shop.',
    schema: object({ amount, date: dateField, category: nameField, method: methodField, notes: notesField }, ['amount']),
    destructive: false,
  },
  {
    operation: 'log_personal_expense',
    feature: 'expenses',
    description: 'Record a personal expense kept separate from business profit.',
    schema: object({ amount, date: dateField, category: nameField, method: methodField, notes: notesField }, ['amount']),
    destructive: false,
  },
  {
    operation: 'add_sale',
    feature: 'sales',
    description: 'Record a sale. Cash means paid now; credit means the customer owes it.',
    schema: object({
      amount, date: dateField, paymentType: paymentTypeField, method: methodField,
      customerName: nameField, notes: notesField,
    }, ['amount']),
    destructive: false,
  },
  {
    operation: 'add_bill',
    feature: 'bills',
    description: 'Record a supplier bill. Credit means the shop still owes the supplier.',
    schema: object({
      supplierName: nameField, amount, date: dateField, paymentType: paymentTypeField,
      method: methodField, invoiceNo: nameField, notes: notesField,
    }, ['supplierName', 'amount']),
    destructive: false,
  },
  {
    operation: 'create_supplier_payment',
    feature: 'bills',
    description: 'Record a supplier payment. Unallocated amounts become a supplier advance.',
    schema: object({
      supplierName: nameField, amount, date: dateField, method: methodField, notes: notesField,
    }, ['supplierName', 'amount']),
    destructive: false,
  },
  {
    operation: 'add_debtor',
    feature: 'parties',
    description: 'Add a customer. Check for an existing customer with this name first.',
    schema: object({ name: nameField, phone: nameField, email: nameField, address: notesField, notes: notesField }, ['name']),
    destructive: false,
  },
  {
    operation: 'add_supplier',
    feature: 'parties',
    description: 'Add a supplier. Check for an existing supplier with this name first.',
    schema: object({ name: nameField, phone: nameField, email: nameField, address: notesField, notes: notesField }, ['name']),
    destructive: false,
  },
  {
    operation: 'add_debtor_payment',
    feature: 'parties',
    description: 'Record money received from a customer against what they owe.',
    schema: object({ name: nameField, amount, date: dateField, method: methodField, notes: notesField }, ['name', 'amount']),
    destructive: false,
  },
  {
    operation: 'create_invoice',
    feature: 'invoices',
    description: 'Raise an invoice for a customer. Totals are computed by the app, not stated by you.',
    schema: object({
      clientName: nameField, amount, date: dateField, dueDate: dateField,
      clientPhone: nameField, notes: notesField,
    }, ['clientName', 'amount']),
    destructive: false,
  },
  {
    operation: 'create_quote',
    feature: 'quotes',
    description: 'Raise a quote for a customer. A quote does not post to the ledger.',
    schema: object({
      clientName: nameField, amount, date: dateField, validUntil: dateField,
      clientPhone: nameField, notes: notesField,
    }, ['clientName', 'amount']),
    destructive: false,
  },
  {
    operation: 'create_receipt',
    feature: 'invoices',
    description: 'Record a receipt. Against an invoice needs the resolved customer and invoice id.',
    schema: object({
      amount, date: dateField, mode: receiptModeField, method: methodField,
      customerName: nameField, invoiceId: idField, notes: notesField,
    }, ['amount']),
    destructive: false,
  },
  {
    operation: 'add_capital',
    feature: 'businessAccounts',
    description: 'Record capital introduced by a member into Business Accounts.',
    schema: object({ partnerName: nameField, amount, date: dateField, memberId: idField, notes: notesField }, ['partnerName', 'amount']),
    destructive: false,
  },
  {
    operation: 'create_drawing',
    feature: 'businessAccounts',
    description: 'Record a capital withdrawal by a member from Business Accounts.',
    schema: object({ partnerName: nameField, amount, date: dateField, memberId: idField, notes: notesField }, ['partnerName', 'amount']),
    destructive: false,
  },
  {
    operation: 'record_inventory',
    feature: 'inventory',
    description: 'Record a counted stock value for the open period. A count of zero is allowed.',
    schema: object({ amount: countAmount, date: dateField, notes: notesField }, ['amount']),
    destructive: false,
  },
  {
    operation: 'update_entry',
    feature: 'entries',
    description: 'Change fields on one existing record you have read. Capital changes need its member id.',
    schema: object({
      entity: { type: 'string', maxLength: 32 },
      id: idField,
      amount, date: dateField, notes: notesField, memberId: idField,
    }, ['entity', 'id']),
    destructive: false,
  },
  {
    operation: 'delete_entry',
    feature: 'entries',
    // Reversal, not erasure: the audit trail is the point of the ledger.
    description: 'Reverse one existing reversible record you have read. Counts and parties cannot be reversed.',
    schema: object({ entity: { type: 'string', maxLength: 32 }, id: idField }, ['entity', 'id']),
    destructive: true,
  },
];

export function descriptor(operation: string): ProposalDescriptor {
  const found = PROPOSAL_DESCRIPTORS.find((entry) => entry.operation === operation);
  if (!found) throw new Error('UNKNOWN_PROPOSAL_OPERATION');
  return found;
}

export type PreparePorts = {
  canPrepare(operation: AssistantProposalType, feature: string, scope: Scope): Promise<boolean>;
  /**
   * Normalizes, resolves entity references against real scoped records, and
   * builds the preview — with ZERO writes.
   *
   * No party creation, no record save, no sync outbox entry. The branch adapter
   * behind this port is where the existing `validateAssistantProposal` runs and
   * where a duplicate-name preflight happens; if a reference is ambiguous it
   * must fail rather than pick the closest match.
   */
  prepare(operation: AssistantProposalType, args: Obj, scope: Scope): Promise<Draft>;
};

/**
 * Wraps one descriptor as a proposal tool.
 *
 * The `operation` check on the returned draft is not paranoia about our own
 * code: the adapter behind `prepare` dispatches on a string, and a draft
 * carrying a different operation than the one requested would be confirmed
 * later by id, with the user having reviewed the wrong preview.
 */
export function proposalTool(entry: ProposalDescriptor, ports: PreparePorts): ProposalTool {
  return {
    name: entry.operation,
    access: 'proposal',
    feature: entry.feature,
    description: entry.description,
    parameters: entry.schema,
    authorize: (context) => ports.canPrepare(entry.operation, entry.feature, context.scope),
    prepare: async (args, context) => {
      await context.assertCurrent();
      if (!await ports.canPrepare(entry.operation, entry.feature, context.scope)) {
        throw new Error('FORBIDDEN');
      }
      if (validate(entry.schema, args).length) throw new Error('INVALID_ARGUMENTS');
      const draft = await ports.prepare(entry.operation, args, context.scope);
      await context.assertCurrent();
      if (draft.operation !== entry.operation) throw new Error('OPERATION_MISMATCH');
      if (draft.destructive !== entry.destructive) throw new Error('DESTRUCTIVE_FLAG_MISMATCH');
      if (!draft.preview.trim()) throw new Error('DRAFT_WITHOUT_PREVIEW');
      return draft;
    },
  };
}

export function createProposalTools(ports: PreparePorts): ProposalTool[] {
  return PROPOSAL_DESCRIPTORS.map((entry) => proposalTool(entry, ports));
}

/** Date bounds re-exported so callers do not re-derive the app's accepted range. */
export const PROPOSAL_DATE_BOUNDS = { minYear: MIN_AI_YEAR, maxYear: MAX_AI_YEAR };
