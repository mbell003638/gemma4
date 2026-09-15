import type { SqlRunner } from '../../db/schema';
import { buildPersistentV2Reports } from '../persistentReports';
import { round2 } from '../../money';
import { partnershipProfitFromReports, postedCommissionFromReports } from '../reports';
import { V2BookConfigRepository } from '../bookConfigRepository';
import type {
  BusinessAccountMember, BusinessAccountsReport, CashMovementReport, CoreReadPorts,
  EntryDetail, EntryEntity, EntrySummary, InventoryReport, LocationScope, Page,
  PageRequest, PartyStatement, PartySummary, PermissionPorts,
  UnpaidInvoice,
} from './coreReadTools';
import type { Scope } from './agentCore';
import type { ReportReadGuard } from './scopedReportReader';

type Json = Record<string, any>;
type CoreDataPorts = Pick<CoreReadPorts,
  'parties' | 'partyStatement' | 'entries' | 'entry' | 'unpaidInvoices'
  | 'cashMovements' | 'inventory' | 'businessAccounts'>;

function parseJson(raw: unknown): Json {
  try {
    const value = JSON.parse(String(raw || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function flag(value: unknown): boolean { return value === true || value === 1 || value === '1'; }
function active(meta: Json): boolean { return !flag(meta.deleted) && !flag(meta.reversed); }
function loc(location: LocationScope, alias: string): { sql: string; params: string[] } {
  if (location.kind === 'company') return { sql: '', params: [] };
  if (!location.ids.length) throw new Error('NO_AUTHORIZED_LOCATION');
  const marks = location.ids.map(() => '?').join(',');
  return { sql: ` AND ${alias}.location_id IN (${marks})`, params: [...location.ids] };
}
function anchor(page: PageRequest): { date?: string; id?: string } {
  if (!page.after) return {};
  const split = page.after.indexOf('|');
  if (split <= 0) throw new Error('INVALID_CURSOR');
  return { date: page.after.slice(0, split), id: page.after.slice(split + 1) };
}
function paged<T extends { id: string; date?: string }>(rows: T[], page: PageRequest): Page<T> {
  const sliced = rows.slice(0, page.limit);
  const last = sliced[sliced.length - 1];
  return { rows: sliced, nextAnchor: rows.length > page.limit && last ? `${last.date || ''}|${last.id}` : null };
}
function nameStart<T extends { id: string }>(rows: T[], after: string | null): number {
  if (!after) return 0;
  const index = rows.findIndex(row => `|${row.id}` === after);
  if (index < 0) throw new Error('STALE_CURSOR');
  return index + 1;
}
async function check(guard: ReportReadGuard, scope: Scope): Promise<void> {
  await guard.assertCurrent(scope);
}
async function roleParty(db: SqlRunner, scope: Scope, partyId: string, role: 'customer' | 'supplier') {
  const row = await db.first<any>('SELECT id,name,roles FROM v2_parties WHERE id=? AND book_id=? AND archived=0', [partyId, scope.bookId]);
  if (!row) return null;
  const roles = Array.isArray(parseJsonArray(row.roles)) ? parseJsonArray(row.roles) : [];
  return roles.includes(role) ? { ...row, roles } : null;
}
function parseJsonArray(raw: unknown): string[] {
  try { const value = JSON.parse(String(raw || '[]')); return Array.isArray(value) ? value.map(String) : []; } catch { return []; }
}
async function revision(db: SqlRunner, bookId: string, id: string): Promise<string> {
  const sync = await db.first<{ revision: number }>('SELECT MAX(revision) AS revision FROM sync_entity_revisions WHERE book_id=? AND aggregate_id=?', [bookId, id]);
  const source = await db.first<{ stamp: string; count: number }>(
    'SELECT COALESCE(MAX(posted_at),\'\') AS stamp,COUNT(*) AS count FROM v2_journal_entries WHERE book_id=? AND source_id=?', [bookId, id],
  );
  return `${Number(sync?.revision || 0)}:${source?.stamp || ''}:${Number(source?.count || 0)}`;
}
async function sourceRows(db: SqlRunner, scope: Scope, location: LocationScope, where: string, params: unknown[]) {
  const l = loc(location, 'jl');
  return db.all<any>(
    `SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name
       FROM v2_sources s
       LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') AND p.book_id=s.book_id
      WHERE s.book_id=? AND ${where}
        AND EXISTS (SELECT 1 FROM v2_journal_entries je JOIN v2_journal_lines jl ON jl.journal_id=je.id
                     WHERE je.book_id=s.book_id AND je.source_id=s.id${l.sql})
      ORDER BY s.date DESC,s.id DESC`,
    [scope.bookId, ...params, ...l.params],
  );
}

export function createLiveDataPorts(db: SqlRunner, permissions: PermissionPorts, guard: ReportReadGuard): CoreDataPorts {
  const before = async (feature: string, scope: Scope) => {
    await check(guard, scope);
    if (!await permissions.canRead(feature, scope)) throw new Error('FORBIDDEN');
  };
  const after = (scope: Scope) => check(guard, scope);

  return {
    parties: async (query, location, scope, page) => {
      await before('parties', scope);
      const l = loc(location, 'l');
      const rows = await db.all<any>(
        `SELECT p.id,p.name,p.roles,
          COALESCE(SUM(CASE WHEN a.code='1100' THEN l.debit-l.credit ELSE 0 END),0) receivable,
          COALESCE(SUM(CASE WHEN a.code='2000' THEN l.credit-l.debit ELSE 0 END),0) payable
         FROM v2_parties p
         LEFT JOIN v2_journal_lines l ON l.party_id=p.id${l.sql}
         LEFT JOIN v2_journal_entries j ON j.id=l.journal_id AND j.book_id=p.book_id
         LEFT JOIN v2_accounts a ON a.id=l.account_id AND a.book_id=p.book_id
         WHERE p.book_id=? AND p.archived=0 AND (?='' OR lower(p.name) LIKE ?)
         GROUP BY p.id,p.name,p.roles ORDER BY lower(p.name),p.id`,
        [...l.params, scope.bookId, query.text || '', `%${(query.text || '').toLowerCase()}%`],
      );
      const filtered = rows.filter(row => query.role === 'any' || parseJsonArray(row.roles).includes(query.role));
      const start = nameStart(filtered, page.after);
      const window = filtered.slice(start, start + page.limit + 1);
      const output = window.map((row): PartySummary => ({ id: row.id, name: row.name, roles: parseJsonArray(row.roles), receivable: Number(row.receivable), payable: Number(row.payable) }));
      await after(scope);
      const result = paged(output, page);
      if (window.length > page.limit && result.rows.length) result.nextAnchor = `|${result.rows[result.rows.length - 1].id}`;
      return result;
    },

    partyStatement: async (query, location, scope, page) => {
      await before('parties', scope);
      const party = await roleParty(db, scope, query.partyId, query.role);
      if (!party) return null;
      const l = loc(location, 'l');
      const accountCodes = query.role === 'customer' ? ['1100', '2100'] : ['2000', '1210'];
      const rows = await db.all<any>(
        `SELECT j.id,COALESCE(s.type,'journal') type,j.date,s.reference,
          COALESCE(SUM(l.debit),0) debit,COALESCE(SUM(l.credit),0) credit
         FROM v2_journal_entries j LEFT JOIN v2_sources s ON j.source_id=s.id AND j.book_id=s.book_id
         JOIN v2_journal_lines l ON l.journal_id=j.id AND l.party_id=?${l.sql}
         JOIN v2_accounts a ON a.id=l.account_id AND a.book_id=j.book_id
         WHERE j.book_id=? AND j.date<=? AND a.code IN (?,?) GROUP BY j.id,s.type,j.date,s.reference
         ORDER BY j.date,j.id`,
        [query.partyId, ...l.params, scope.bookId, query.range.to, ...accountCodes],
      );
      let running = 0;
      const all = rows.map(row => {
        const debit = Number(row.debit);
        const credit = Number(row.credit);
        running = round2(running + (query.role === 'customer' ? debit - credit : credit - debit));
        return { id: row.id, kind: row.type, date: row.date, reference: row.reference || null, debit, credit, balance: running };
      });
      const openingBalance = all.filter(row => row.date < query.range.from).reduce((_sum, row) => row.balance, 0);
      const inRange = all.filter(row => row.date >= query.range.from);
      const a = anchor(page);
      const eligible = a.date ? inRange.filter(row => row.date > a.date! || (row.date === a.date && row.id > a.id!)) : inRange;
      const movements = paged(eligible, page);
      await after(scope);
      return { id: party.id, name: party.name, roles: party.roles, openingBalance, closingBalance: running, movements } satisfies PartyStatement;
    },

    entries: async (query, location, scope, page) => {
      await before('entries', scope);
      const rows = await sourceRows(db, scope, location, 's.type=? AND s.date>=? AND s.date<=?', [query.entity, query.range.from, query.range.to]);
      const a = anchor(page);
      const eligible = rows.filter(row => {
        const meta = parseJson(row.metadata);
        return active(meta) && (!query.text || `${row.reference || ''} ${row.party_name || ''} ${meta.notes || ''}`.toLowerCase().includes(query.text.toLowerCase()))
          && (!a.date || row.date < a.date || (row.date === a.date && row.id < a.id!));
      });
      const mapped: EntrySummary[] = [];
      for (const row of eligible.slice(0, page.limit + 1)) mapped.push({
        id: row.id, entity: row.type as EntryEntity, date: row.date, amount: Number(parseJson(row.metadata).total),
        reference: row.reference || null, partyId: parseJson(row.metadata).partyId ? String(parseJson(row.metadata).partyId) : null,
        partyName: row.party_name || null, revision: await revision(db, scope.bookId, row.id),
      });
      await after(scope);
      return paged(mapped, page);
    },

    entry: async (entity, id, location, scope) => {
      await before('entries', scope);
      const rows = await sourceRows(db, scope, location, 's.type=? AND s.id=?', [entity, id]);
      const row = rows[0];
      if (!row) return null;
      const meta = parseJson(row.metadata);
      const allocations = await db.all<any>(
        'SELECT invoice_source_id,amount FROM v2_invoice_allocations WHERE book_id=? AND receipt_source_id=? ORDER BY allocated_at,id',
        [scope.bookId, id],
      );
      const reversed = flag(meta.reversed) || Boolean(await db.first(
        'SELECT 1 FROM v2_journal_entries original JOIN v2_journal_entries reversal ON reversal.reversal_of=original.id WHERE original.book_id=? AND original.source_id=? LIMIT 1',
        [scope.bookId, id],
      ));
      await after(scope);
      return {
        id, entity, date: row.date, amount: Number(meta.total), reference: row.reference || null,
        partyId: meta.partyId ? String(meta.partyId) : null, partyName: row.party_name || null,
        revision: await revision(db, scope.bookId, id), subtotal: meta.subtotal == null ? null : Number(meta.subtotal),
        tax: meta.tax == null ? null : Number(meta.tax), status: meta.status ? String(meta.status) : null,
        allocations: allocations.map(item => ({ invoiceId: item.invoice_source_id, amount: Number(item.amount) })),
        reversed, deleted: flag(meta.deleted), editable: active(meta) && !reversed,
      } satisfies EntryDetail;
    },

    unpaidInvoices: async (query, location, scope, page) => {
      await before('invoices', scope);
      if (query.partyId && !await roleParty(db, scope, query.partyId, 'customer')) return null;
      const rows = await sourceRows(db, scope, location, `s.type='invoice'${query.partyId ? " AND json_extract(s.metadata,'$.partyId')=?" : ''}`, query.partyId ? [query.partyId] : []);
      const a = anchor(page);
      const result: UnpaidInvoice[] = [];
      for (const row of rows) {
        const meta = parseJson(row.metadata);
        if (!active(meta) || (a.date && !(row.date < a.date || (row.date === a.date && row.id < a.id!)))) continue;
        const allocatedRow = await db.first<{ amount: number }>('SELECT COALESCE(SUM(amount),0) amount FROM v2_invoice_allocations WHERE book_id=? AND invoice_source_id=?', [scope.bookId, row.id]);
        const total = Number(meta.total);
        const allocated = Number(allocatedRow?.amount || 0);
        if (total - allocated <= 0.005) continue;
        result.push({ id: row.id, partyId: String(meta.partyId), partyName: row.party_name || null, date: row.date,
          dueDate: meta.dueDate ? String(meta.dueDate) : null, total, allocated, outstanding: total - allocated,
          status: allocated > 0 ? 'partial' : 'unpaid', revision: await revision(db, scope.bookId, row.id) });
        if (result.length > page.limit) break;
      }
      await after(scope);
      return paged(result, page);
    },

    cashMovements: async (range, location, scope, page) => {
      await before('cashbook', scope);
      const l = loc(location, 'l');
      const rows = await db.all<any>(
        `SELECT l.id,e.date,e.source_id,s.type source_type,l.debit,l.credit
         FROM v2_journal_entries e JOIN v2_journal_lines l ON l.journal_id=e.id${l.sql}
         JOIN v2_accounts a ON a.id=l.account_id AND a.book_id=e.book_id
         LEFT JOIN v2_sources s ON s.id=e.source_id AND s.book_id=e.book_id
         WHERE e.book_id=? AND a.code IN ('1000','1010','1020','1030') AND e.date<=?
         ORDER BY e.date,e.id,l.id`, [...l.params, scope.bookId, range.to],
      );
      const openingBalance = rows.filter(row => row.date < range.from).reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0);
      const period = rows.filter(row => row.date >= range.from);
      const totalIn = period.reduce((sum, row) => sum + Number(row.debit), 0);
      const totalOut = period.reduce((sum, row) => sum + Number(row.credit), 0);
      const compare = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
      const desc = period.slice().sort((x, y) => compare(y.date, x.date) || compare(String(y.id), String(x.id)));
      const a = anchor(page);
      const eligible = a.date ? desc.filter(row => row.date < a.date! || (row.date === a.date && String(row.id) < a.id!)) : desc;
      const movements = paged(eligible.slice(0, page.limit + 1).map(row => ({
        id: String(row.id), date: row.date, direction: Number(row.debit) > 0 ? 'in' as const : 'out' as const,
        amount: Number(row.debit) || Number(row.credit), sourceId: row.source_id || null, sourceType: row.source_type || null,
      })), page);
      await after(scope);
      return { openingBalance, closingBalance: openingBalance + totalIn - totalOut, totalIn, totalOut, movements } satisfies CashMovementReport;
    },

    inventory: async (query, location, scope, page) => {
      await before('inventory', scope);
      const period = await db.first<any>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1", [scope.bookId]);
      let valuation: InventoryReport['valuation'] = null;
      if (period) {
        const report = await buildPersistentV2Reports(db, { bookId: scope.bookId, to: period.end_date, ...(location.kind === 'locations' && location.ids.length === 1 ? { locationId: location.ids[0] } : {}) });
        const inventory = report.trialBalance.accounts.find(account => account.code === '1200')?.normalBalance || 0;
        const counts = await db.all<any>(`SELECT date,value FROM v2_inventory_counts WHERE book_id=? AND period_id=?${location.kind === 'locations' ? ` AND location_id IN (${location.ids.map(() => '?').join(',')})` : ''} ORDER BY date DESC,id DESC`,
          [scope.bookId, period.id, ...(location.kind === 'locations' ? location.ids : [])]);
        const last = counts[0];
        const since = last?.date || period.start_date;
        const sources = await sourceRows(db, scope, location, "s.date>=? AND s.date<=? AND s.type IN ('cash_purchase','credit_purchase','cash_sale','invoice')", [since, period.end_date]);
        let purchases = 0, sales = 0;
        for (const source of sources) { const meta = parseJson(source.metadata); if (!active(meta)) continue; if (source.type.includes('purchase')) purchases += Number(meta.total || 0); else sales += Number(meta.total || 0); }
        valuation = { expectedValue: inventory, openingValue: 0, lastCountedValue: last ? Number(last.value) : null, lastCountDate: last?.date || null,
          purchasesSince: purchases, salesSince: sales, periodStart: period.start_date, periodEnd: period.end_date,
          costOfGoodsSoldProvisional: Boolean((report as any).provisionalShopCogs) };
      }
      const l = location.kind === 'locations' ? location.ids : [];
      const qtySql = l.length
        ? `COALESCE((SELECT SUM(sm.qty) FROM v2_stock_moves sm WHERE sm.book_id=p.book_id AND sm.product_id=p.id AND sm.location_id IN (${l.map(() => '?').join(',')})),0)`
        : 'p.qty';
      const rows = await db.all<any>(`SELECT p.id,p.name,p.unit,${qtySql} quantity FROM v2_products p WHERE p.book_id=? AND p.archived=0 AND (?='' OR lower(p.name) LIKE ?) ORDER BY lower(p.name),p.id`,
        [...l, scope.bookId, query.productQuery || '', `%${(query.productQuery || '').toLowerCase()}%`]);
      const start = nameStart(rows, page.after);
      const window = rows.slice(start, start + page.limit + 1);
      const products = paged(window.map(row => ({ id: row.id, name: row.name, unit: row.unit || null, quantity: Number(row.quantity),
        locationId: location.kind === 'locations' && location.ids.length === 1 ? location.ids[0] : null })), page);
      if (window.length > page.limit && products.rows.length) products.nextAnchor = `|${products.rows[products.rows.length - 1].id}`;
      await after(scope);
      return { valuation, products } satisfies InventoryReport;
    },

    businessAccounts: async (query, location, scope, page) => {
      await before('business_accounts', scope);
      if (location.kind !== 'company') throw new Error('LOCATION_SCOPED_CAPITAL_UNAVAILABLE');
      const period = await db.first<any>("SELECT start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1", [scope.bookId]);
      if (!period) throw new Error('NO_ACTIVE_PERIOD');
      const rows = await db.all<any>('SELECT id,name,opening_contribution,current_capital,profit_share_pct FROM v2_members WHERE book_id=? ORDER BY lower(name),id', [scope.bookId]);
      if (query.memberId && !rows.some(row => row.id === query.memberId)) return null;
      const report = await buildPersistentV2Reports(db, { bookId: scope.bookId, from: period.start_date, to: period.end_date });
      let commissionPct = 0;
      try { commissionPct = (await new V2BookConfigRepository(db).getBookConfig(scope.bookId)).retailPartnership.commissionPct; } catch { /* optional low-level book config, as in investorLedgerService */ }
      const allocatableProfit = partnershipProfitFromReports(report.profitAndLoss, commissionPct, postedCommissionFromReports(report)).netProfit;
      const selected = rows.filter(row => !query.memberId || row.id === query.memberId);
      const members: BusinessAccountMember[] = [];
      // Match investorLedgerService.detail, including per-movement rounding,
      // legacy name matching and numeric reversal/deletion flags. Keep this
      // projection read-only and available to the same enabled personas.
      const sources = await db.all<any>("SELECT id,type,metadata FROM v2_sources WHERE book_id=? AND date>=? AND date<=? AND type IN ('capital_injection','drawing') ORDER BY date DESC,id DESC", [scope.bookId, period.start_date, period.end_date]);
      for (const row of selected) {
        let injected = 0, drawings = 0;
        for (const source of sources) {
          const meta = parseJson(source.metadata);
          const matches = meta.memberId === row.id || String(meta.memberName || meta.partnerName || '').trim().toLowerCase() === String(row.name).trim().toLowerCase();
          if (!active(meta) || !matches) continue;
          if (source.type === 'drawing') drawings += round2(Number(meta.total || 0)); else injected += round2(Number(meta.total || 0));
        }
        injected = round2(injected); drawings = round2(drawings);
        const openingCapital = round2(Number(row.current_capital));
        const profitShare = round2(allocatableProfit * Number(row.profit_share_pct) / 100);
        members.push({ id: row.id, name: row.name, profitSharePct: Number(row.profit_share_pct), openingCapital,
          injected, drawings, currentCapital: round2(openingCapital + injected + profitShare - drawings),
          revision: await revision(db, scope.bookId, row.id) });
      }
      const start = nameStart(members, page.after);
      const window = members.slice(start, start + page.limit + 1);
      const result = paged(window, page);
      if (window.length > page.limit && result.rows.length) result.nextAnchor = `|${result.rows[result.rows.length - 1].id}`;
      await after(scope);
      return { periodStart: period.start_date, periodEnd: period.end_date, allocatableProfit, members: result } satisfies BusinessAccountsReport;
    },
  };
}
