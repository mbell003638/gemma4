import type { SqlRunner } from '../../db/schema';
import { withSyncedMutationLocked, type SyncMutation } from '../../sync/coordinator';
import { createAppMutationRouter, createAppWriteRouter, V2AppService } from '../appService';
import { V2InvestorLedgerService } from '../investorLedgerService';
import type { Obj, Scope } from './agentCore';
import { createAssistantActionExecutor, type AssistantActionApi } from './assistantActionExecutor';

type JsonRow = Record<string, any>;

function json(raw: unknown): JsonRow {
  try { const value = JSON.parse(String(raw || '{}')); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

function resultIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as JsonRow;
  return [...new Set([row.id, row.source?.id, row.journal?.id].filter(item => typeof item === 'string'))] as string[];
}

/** Builds the action API on the executor's runner and already-held sync lock. */
export function createTransactionActionPort() {
  return async (operation: string, normalized: Obj, scope: Scope, db: SqlRunner): Promise<Obj> => {
    const service = new V2AppService(db);
    const writes = createAppWriteRouter(service) as JsonRow;
    const mutations = createAppMutationRouter(service) as JsonRow;
    const committedIds: string[] = [];
    const capture = async <T>(mutation: SyncMutation, work: () => Promise<T>): Promise<T> => {
      const value = await withSyncedMutationLocked(db, mutation, work, scope.bookId);
      committedIds.push(...resultIds(value));
      return value;
    };
    const sourceRows = async (types: string[]) => {
      const rows = await db.all<JsonRow>(`SELECT id,type,date,reference,metadata FROM v2_sources WHERE book_id=? AND type IN (${types.map(() => '?').join(',')}) ORDER BY date DESC,id DESC`, [scope.bookId, ...types]);
      return rows.map(row => ({ ...json(row.metadata), id: row.id, type: row.type, sourceType: row.type, date: row.date, reference: row.reference }));
    };
    const create = (name: string) => async (input: JsonRow): Promise<any> => {
      const payload: JsonRow = { ...input, ...(scope.locationId ? { locationId: scope.locationId } : {}) };
      return capture({ commandType: 'transaction.create', aggregateType: 'source', aggregateId: String(payload.id || `${name}:${Date.now()}`), payload: { name, input: payload }, businessDate: payload.date, operationIdentity: !payload.id }, () => writes[name](payload));
    };
    const mutate = (name: string) => async (...args: any[]) => capture({ commandType: 'transaction.mutate', aggregateType: 'source', aggregateId: String(args[0]), payload: { name, args }, businessDate: args[1]?.date }, () => mutations[name](...args));
    const parties = async (role: 'customer' | 'supplier') => (await service.listParties()).filter((row: any) => row.roles.includes(role)).map((row: any) => ({ ...row, role }));
    const unsupported = async () => { throw new Error('GUIDED_SCREEN_ONLY'); };
    const api = {
      createExpense: create('createExpense'), createSale: create('createSale'), createBill: create('createBill'), createPayment: create('createPayment'), createReceipt: create('createReceipt'), createInvoice: create('createInvoice'),
      listSuppliers: () => parties('supplier'), listDebtors: () => parties('customer'),
      findOrCreateParty: async (name: string, role: any, details: any) => capture({ commandType: 'party.create', aggregateType: 'party', aggregateId: `${role}:${name.toLowerCase()}`, payload: { name, roles: [role], ...details }, operationIdentity: true }, () => service.ensureParty(name, role, details)),
      listExpenses: () => sourceRows(['expense']), listSales: () => sourceRows(['cash_sale', 'credit_sale']), listBills: () => service.listBills(), listPayments: () => sourceRows(['supplier_payment', 'drawing']), listReceipts: () => sourceRows(['receipt']),
      listInvoices: async () => (await service.listSalesAndInvoices()).filter((row: any) => row.type === 'invoice'),
      updateExpense: mutate('updateExpense'), deleteExpense: mutate('deleteExpense'), updateSale: mutate('updateSale'), deleteSale: mutate('deleteSale'), updateBill: mutate('updateBill'), deleteBill: mutate('deleteBill'), updatePayment: mutate('updatePayment'), deletePayment: mutate('deletePayment'), updateReceipt: mutate('updateReceipt'), deleteReceipt: mutate('deleteReceipt'), updateInvoice: mutate('updateInvoice'), deleteInvoice: mutate('deleteInvoice'), updateNote: mutate('updateNote'), deleteNote: mutate('deleteNote'),
      listQuotes: unsupported as any, createQuote: unsupported as any, updateQuote: unsupported as any, deleteQuote: unsupported as any,
      listDeliveryNotes: unsupported as any, updateDeliveryNote: unsupported as any, deleteDeliveryNote: unsupported as any,
      updateDebtor: async (id: string, patch: any) => capture({ commandType: 'party.patch', aggregateType: 'party', aggregateId: id, payload: { id, patch } }, () => service.updateParty(id, patch)),
      updateSupplier: async (id: string, patch: any) => capture({ commandType: 'party.patch', aggregateType: 'party', aggregateId: id, payload: { id, patch } }, () => service.updateParty(id, patch)),
      recordV2InventoryCount: async (input: any) => capture({ commandType: 'inventory.count.record', aggregateType: 'inventory_count', aggregateId: `inventory:${input.date}`, payload: input, businessDate: input.date, operationIdentity: true }, () => service.recordInventoryCount({ ...input, ...(scope.locationId ? { locationId: scope.locationId } : {}) })),
      listInvestors: () => db.all<any>('SELECT id,name,opening_contribution openingCapital,current_capital currentCapital,profit_share_pct profitSharePct FROM v2_members WHERE book_id=?', [scope.bookId]),
      getInvestorLedger: (id: string) => new V2InvestorLedgerService(db).detail(scope.bookId, id),
      depositInvestorCapital: async (id: string, input: any) => capture({ commandType: 'capital.deposit', aggregateType: 'member', aggregateId: id, payload: { memberId: id, input: { ...input, bookId: scope.bookId } }, businessDate: input.date, operationIdentity: true }, () => new V2InvestorLedgerService(db).deposit({ ...input, bookId: scope.bookId, memberId: id })),
      drawInvestorFunds: async (id: string, input: any) => capture({ commandType: 'capital.draw', aggregateType: 'member', aggregateId: id, payload: { memberId: id, input: { ...input, bookId: scope.bookId } }, businessDate: input.date, operationIdentity: true }, () => new V2InvestorLedgerService(db).draw({ ...input, bookId: scope.bookId, memberId: id })),
      updateInvestorCapital: async (id: string, sourceId: string, input: any) => capture({ commandType: 'capital.patch', aggregateType: 'source', aggregateId: sourceId, payload: { memberId: id, sourceId, input }, businessDate: input.date }, () => new V2InvestorLedgerService(db).updateDeposit(sourceId, { ...input, bookId: scope.bookId, memberId: id })),
      deleteInvestorCapital: async (id: string, sourceId: string) => capture({ commandType: 'capital.delete', aggregateType: 'source', aggregateId: sourceId, payload: { memberId: id, sourceId } }, () => new V2InvestorLedgerService(db).deleteDeposit(sourceId, scope.bookId, id)),
      listCashEntries: () => service.listCashMovements(),
      updateCashEntry: async (id: string, input: any) => capture({ commandType: 'cash.patch', aggregateType: 'source', aggregateId: id, payload: { id, input }, businessDate: input.date }, () => service.updateManualCash(id, input)),
      deleteCashEntry: async (id: string) => capture({ commandType: 'cash.delete', aggregateType: 'source', aggregateId: id, payload: { id } }, () => service.deleteManualCash(id)),
    } as unknown as AssistantActionApi;
    const message = await createAssistantActionExecutor(api, () => scope.today)({ type: operation, params: normalized });
    if (!committedIds.length) throw new Error('DOMAIN_RETURNED_NO_RESULT');
    return { message, committedIds: [...new Set(committedIds)] };
  };
}
