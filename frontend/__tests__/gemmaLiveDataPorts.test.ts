import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { createLiveDataPorts } from '../src/accountingV2/gemma/liveDataPorts';
import { V2DocumentService } from '../src/accountingV2/documentService';
import { PartyDomainService } from '../src/accountingV2/services/partyDomainService';
import { V2InvestorLedgerService } from '../src/accountingV2/investorLedgerService';
import { V2CloseBooksRepository } from '../src/accountingV2/closeBooksRepository';
import type { V2JournalEntry, V2Source } from '../src/accountingV2/types';
import type { PermissionPorts } from '../src/accountingV2/gemma/coreReadTools';
import type { Scope } from '../src/accountingV2/gemma/agentCore';

const scope: Scope = { bookId: 'a', actorId: 'owner', locationId: null, permissionEpoch: '1', featureEpoch: '1', revision: '1', currency: 'INR', basis: 'accrual', today: '2026-09-10', timeZone: 'Asia/Calcutta' };
const cleanups: (() => void)[] = [];
test('cash pages traverse every cash line once with stable totals and scoped history', async () => {
  const { db, repo, ports } = await setup();
  await repo.postJournal({ id: 'multi-cash', bookId: 'a', periodId: 'a-p', date: '2026-03-02', memo: 'transfer', lines: [
    { accountId: 'a:account:1000', debit: 10, credit: 0, locationId: 'shop-a' },
    { accountId: 'a:account:1010', debit: 0, credit: 3, locationId: 'shop-a' },
    { accountId: 'a:account:3000', debit: 0, credit: 7, locationId: 'shop-a' },
  ] });
  await repo.postJournal({ id: 'other-cash', bookId: 'a', periodId: 'a-p', date: '2026-03-02', memo: 'deposit', lines: [
    { accountId: 'a:account:1000', debit: 5, credit: 0, locationId: 'shop-a' },
    { accountId: 'a:account:3000', debit: 0, credit: 5, locationId: 'shop-a' },
  ] });
  for (const [id, bookId, locationId, date] of [
    ['foreign-cash', 'b', undefined, '2026-03-02'],
    ['hidden-cash', 'a', 'shop-b', '2026-03-02'],
    ['later-cash', 'a', 'shop-a', '2026-04-01'],
  ] as const) {
    await repo.postJournal({ id, bookId, periodId: bookId + '-p', date, memo: id, lines: [
      { accountId: bookId + ':account:1000', debit: 900, credit: 0, locationId },
      { accountId: bookId + ':account:3000', debit: 0, credit: 900, locationId },
    ] });
  }
  // Integer SQLite keys deliberately straddle a digit boundary. Numeric '<'
  // must not be mixed with the adapter's string cursor order.
  await db.run("UPDATE v2_journal_lines SET id=900 WHERE journal_id='multi-cash' AND account_id='a:account:1000'");
  await db.run("UPDATE v2_journal_lines SET id=1000 WHERE journal_id='multi-cash' AND account_id='a:account:1010'");
  await db.run("UPDATE v2_journal_lines SET id=1001 WHERE journal_id='other-cash' AND account_id='a:account:1000'");

  let after: string | null = null;
  const seen: string[] = [];
  do {
    const result = await ports.cashMovements({ from: '2026-03-01', to: '2026-03-31' }, { kind: 'locations', ids: ['shop-a'] }, scope, { limit: 1, after });
    expect(result).toMatchObject({ openingBalance: 40, totalIn: 15, totalOut: 3, closingBalance: 52 });
    expect(result.movements.rows).toHaveLength(1);
    expect(result.movements.rows[0].sourceId).toBeNull();
    seen.push(result.movements.rows[0].id);
    expect(seen.length).toBeLessThanOrEqual(3);
    after = result.movements.nextAnchor;
    expect(after).toBe(seen.length < 3 ? '2026-03-02|' + seen[seen.length - 1] : null);
  } while (after !== null);
  expect(seen).toEqual(['900', '1001', '1000']);
});

afterEach(() => cleanups.splice(0).forEach(close => close()));

async function setup() {
  const { runner: db, close } = makeNodeRunner(); cleanups.push(close);
  await initSchema(db);
  const repo = new V2SqlRepository(db);
  for (const id of ['a', 'b']) {
    await repo.createBook(defaultBook(id, id), defaultAccounts(id));
    await repo.createPeriod({ id: id + '-p', bookId: id, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
  }
  await db.run("INSERT INTO v2_locations(id,book_id,name,archived) VALUES('shop-a','a','Shop A',0)");
  await db.run("INSERT INTO v2_locations(id,book_id,name,archived) VALUES('shop-b','a','Shop B',0)");
  await repo.createParty({ id: 'cust-a', bookId: 'a', name: 'Acme', roles: ['customer'] });
  await repo.createParty({ id: 'cust-b', bookId: 'b', name: 'Secret Other Book', roles: ['customer'] });
  await repo.createParty({ id: 'supplier-a', bookId: 'a', name: 'Supply Co', roles: ['supplier'] });
  const post = async (id: string, bookId: string, type: any, total: number, date: string, locationId: string | undefined, partyId: string | undefined, lines: any[]) =>
    repo.postSourceJournal({ id, bookId, type, date, locationId, reference: id, metadata: { total, partyId, dueDate: '2026-12-31' } }, {
      id: id + '-j', bookId, periodId: bookId + '-p', date, memo: id, lines,
    });
  await post('inv-a', 'a', 'invoice', 100, '2026-02-01', 'shop-a', 'cust-a', [
    { accountId: 'a:account:1100', partyId: 'cust-a', debit: 100, credit: 0 },
    { accountId: 'a:account:4000', debit: 0, credit: 100 },
  ]);
  await post('receipt-a', 'a', 'receipt', 40, '2026-02-02', 'shop-a', 'cust-a', [
    { accountId: 'a:account:1000', debit: 40, credit: 0 },
    { accountId: 'a:account:1100', partyId: 'cust-a', debit: 0, credit: 40 },
  ]);
  await db.run("INSERT INTO v2_invoice_allocations(id,book_id,invoice_source_id,receipt_source_id,amount,allocated_at) VALUES('alloc','a','inv-a','receipt-a',40,'2026-02-02')");
  await post('secret', 'b', 'invoice', 9000, '2026-02-01', undefined, 'cust-b', [
    { accountId: 'b:account:1100', partyId: 'cust-b', debit: 9000, credit: 0 },
    { accountId: 'b:account:4000', debit: 0, credit: 9000 },
  ]);
  await db.run("INSERT INTO v2_products(id,book_id,name,unit,cost,price,qty,archived) VALUES('product-a','a','Widget','pc',3,5,7,0)");
  await db.run("INSERT INTO v2_members(id,book_id,name,opening_contribution,current_capital,profit_share_pct) VALUES('member-a','a','Owner',100,100,100)");
  const permissions: PermissionPorts = { canRead: async () => true, authorizedLocations: async () => 'all' };
  const guard = { assertCurrent: jest.fn(async () => {}), canReadReports: async () => true, authorizedLocations: async () => 'all' as const };
  return { db, repo, ports: createLiveDataPorts(db, permissions, guard), guard };
}

test('A08 dual-role advances and reversals agree with ordinary party balances', async () => {
  const { db, repo, ports } = await setup();
  await repo.createParty({ id: 'dual', bookId: 'a', name: 'Both Roles', roles: ['customer', 'supplier'] });
  const documents = new V2DocumentService(repo);
  const ordinary = new PartyDomainService(db, repo, documents, async () => ({ bookId: 'a', periodId: 'a-p' }));
  const post = (id: string, type: V2Source['type'], lines: V2JournalEntry['lines']) => repo.postSourceJournal(
    { id, bookId: 'a', type, date: '2026-03-01', metadata: { partyId: 'dual' } },
    { id: id + '-j', bookId: 'a', periodId: 'a-p', date: '2026-03-01', memo: id, lines },
  );
  const line = (code: string, debit: number, credit: number) => ({ accountId: 'a:account:' + code, partyId: 'dual', debit, credit });
  const agree = async (customer: number, supplier: number) => {
    for (const [role, expected] of [['customer', customer], ['supplier', supplier]] as const) {
      const actual = await ports.partyStatement({ partyId: 'dual', role, range: { from: '2026-03-01', to: '2026-03-31' } }, { kind: 'company' }, scope, { limit: 25, after: null });
      expect(actual?.closingBalance).toBe(expected);
      expect(actual?.closingBalance).toBe((await ordinary.getPartyDetail('dual', role))?.balance);
      expect(actual?.movements.rows.reduce((sum, row) => sum + (role === 'customer' ? row.debit - row.credit : row.credit - row.debit), actual.openingBalance)).toBe(expected);
    }
  };
  await post('dual-invoice', 'invoice', [line('1100', 100, 0), line('4000', 0, 100)]);
  await post('dual-bill', 'credit_purchase', [line('6000', 70, 0), line('2000', 0, 70)]);
  await agree(100, 70);
  await post('dual-receipt', 'receipt', [line('1000', 140, 0), line('1100', 0, 100), line('2100', 0, 40)]);
  await agree(-40, 70);
  // A debit to customer advances must participate, not just advance credits.
  await post('advance-used', 'invoice', [line('2100', 15, 0), line('4000', 0, 15)]);
  await agree(-25, 70);
  await documents.reverseSource('advance-used', 'invoice', 'undo advance use', true);
  await documents.reverseSource('dual-receipt', 'receipt', 'undo receipt', true);
  await agree(100, 70);
  await post('dual-prepay', 'supplier_payment', [line('2000', 70, 0), line('1210', 30, 0), line('1000', 0, 100)]);
  await agree(100, -30);
  // A credit to supplier advances reduces the prepayment with the opposite sign.
  await post('prepay-used', 'credit_purchase', [line('6000', 10, 0), line('1210', 0, 10)]);
  await agree(100, -20);
  await documents.reverseSource('prepay-used', 'credit_purchase', 'undo prepayment use', true);
  await documents.reverseSource('dual-prepay', 'supplier_payment', 'undo payment', true);
  await agree(100, 70);
});

test.each(['customer', 'supplier'] as const)('A08 %s manual/opening journals reconcile across pages and exclude later/location/book history', async role => {
  const { db, repo, ports } = await setup();
  await repo.createParty({ id: 'manual-party', bookId: 'a', name: 'Manual Party', roles: [role] });
  const account = role === 'customer' ? '1100' : '2000';
  const post = async (id: string, date: string, amount: number, locationId = 'shop-a') => repo.postJournal({
    id, bookId: 'a', periodId: 'a-p', date, memo: id, lines: [
      { accountId: 'a:account:' + account, partyId: 'manual-party', debit: role === 'customer' ? amount : 0, credit: role === 'supplier' ? amount : 0, locationId },
      { accountId: 'a:account:3000', debit: role === 'supplier' ? amount : 0, credit: role === 'customer' ? amount : 0, locationId },
    ],
  });
  await post('opening', '2026-02-28', 20);
  await post('manual-a', '2026-03-01', 0.1);
  await post('manual-z', '2026-03-01', 0.2);
  await post('manual-reversed', '2026-03-02', 9);
  await repo.reverseJournal('manual-reversed', 'undo manual');
  await post('later', '2026-04-01', 900);
  await post('other-location', '2026-03-01', 800, 'shop-b');
  let after: string | null = null;
  const ids: string[] = [];
  let delta = 0;
  do {
    const result = await ports.partyStatement({ partyId: 'manual-party', role, range: { from: '2026-03-01', to: '2026-03-31' } }, { kind: 'locations', ids: ['shop-a'] }, scope, { limit: 1, after });
    expect(result).toMatchObject({ openingBalance: 20, closingBalance: 20.3 });
    expect(result!.movements.rows).toHaveLength(1);
    const movement = result!.movements.rows[0];
    ids.push(movement.id);
    delta += role === 'customer' ? movement.debit - movement.credit : movement.credit - movement.debit;
    expect(ids.length).toBeLessThanOrEqual(4);
    after = result!.movements.nextAnchor;
  } while (after !== null);
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
  expect(20 + delta).toBeCloseTo(20.3, 8);
  const ordinary = new PartyDomainService(db, repo, new V2DocumentService(repo), async () => ({ bookId: 'a', periodId: 'a-p' }));
  // Characterize the screen's source-only limitation explicitly. Do not erase
  // legitimate source-less history to force agreement with that UI projection.
  expect((await ordinary.getPartyDetail('manual-party', role))?.balance).toBe(0);
  expect(await ports.partyStatement({ partyId: 'cust-b', role, range: { from: '2026-01-01', to: '2026-12-31' } }, { kind: 'company' }, scope, { limit: 25, after: null })).toBeNull();
});

test.each(['standard', 'retail_partnership'] as const)('A09 %s carried capital, legacy names, rounding and reversals match investor detail', async style => {
  const { db, repo, ports } = await setup();
  await db.run('UPDATE v2_books SET style=? WHERE id=?', [style, 'a']);
  await db.run("UPDATE v2_periods SET end_date='2026-02-28' WHERE id='a-p'");
  await repo.createPeriod({ id: 'current-p', bookId: 'a', startDate: '2026-03-01', endDate: '2026-03-31', status: 'open' });
  const ledger = new V2InvestorLedgerService(db);
  await ledger.deposit({ bookId: 'a', memberId: 'member-a', date: '2026-02-15', amount: 50 });
  await db.run("UPDATE v2_periods SET status='closed' WHERE id='a-p'");
  await db.run("UPDATE v2_members SET current_capital=150 WHERE id='member-a'");
  const agree = async (expected: number) => {
    const report = await ports.businessAccounts({ memberId: 'member-a' }, { kind: 'company' }, scope, { limit: 25, after: null });
    const detail = await ledger.detail('a', 'member-a');
    expect(report).toMatchObject({ periodStart: detail.periodStart, periodEnd: detail.periodEnd });
    expect(report?.members.rows[0]).toMatchObject({ openingCapital: detail.openingCapital, injected: detail.totalInjected, drawings: detail.totalDrawings, currentCapital: detail.currentCapitalBalance });
    expect(report?.members.rows[0].currentCapital).toBe(expected);
  };
  await agree(150);
  await ledger.deposit({ bookId: 'a', memberId: 'member-a', date: '2026-03-01', amount: 20 });
  await ledger.draw({ bookId: 'a', memberId: 'member-a', date: '2026-03-31', amount: 10 });
  await agree(160);
  const removed = await ledger.deposit({ bookId: 'a', memberId: 'member-a', date: '2026-03-02', amount: 45 });
  await ledger.deleteDeposit(removed.source.id, 'a', 'member-a');
  // Real document reversal writes numeric 1 flags, not boolean true.
  await agree(160);
  for (const [id, metadata] of [
    ['legacy-name', { memberName: '  OWNER ', total: 0.105 }],
    ['legacy-partner', { partnerName: 'Owner', total: 0.105 }],
    ['boolean-deleted', { memberId: 'member-a', total: 800, deleted: true }],
    ['numeric-reversed', { memberId: 'member-a', total: 800, reversed: 1 }],
    ['string-deleted', { memberId: 'member-a', total: 800, deleted: '1' }],
    ['different-member', { memberId: 'elsewhere', total: 800 }],
  ] as const) {
    await db.run("INSERT INTO v2_sources(id,book_id,type,date,metadata) VALUES(?,'a','capital_injection','2026-03-15',?)", [id, JSON.stringify(metadata)]);
  }
  await agree(160.22);
  await db.run("INSERT INTO v2_sources(id,book_id,type,date,metadata) VALUES('foreign-capital','b','capital_injection','2026-03-15',?)", [JSON.stringify({ memberId: 'member-a', total: 900 })]);
  await db.run("INSERT INTO v2_sources(id,book_id,type,date,metadata) VALUES('future-capital','a','capital_injection','2026-04-01',?)", [JSON.stringify({ memberId: 'member-a', total: 900 })]);
  await agree(160.22);
  await db.run("INSERT INTO v2_personas(id,book_id,type,enabled,active,config) VALUES('persona','a','custom',1,1,?)", [JSON.stringify({ commissionPct: 12.5 })]);
  await repo.postJournal({ id: 'current-profit', bookId: 'a', periodId: 'current-p', date: '2026-03-15', memo: 'profit', lines: [
    { accountId: 'a:account:1000', debit: 10.01, credit: 0 }, { accountId: 'a:account:4000', debit: 0, credit: 10.01 },
  ] });
  await agree(168.98);
  await repo.postJournal({ id: 'commission', bookId: 'a', periodId: 'current-p', date: '2026-03-15', memo: 'commission', lines: [
    { accountId: 'a:account:6100', debit: 1.25, credit: 0 }, { accountId: 'a:account:2200', debit: 0, credit: 1.25 },
  ] });
  await agree(168.98);
  await db.run("UPDATE v2_members SET profit_share_pct=33.33,current_capital=150.005 WHERE id='member-a'");
  await agree(163.15);
});

test('A09 real period close carries capital once; reopened snapshot uses restored opening', async () => {
  const { db, repo, ports } = await setup();
  // Separate clean partnership: avoid the ordinary setup's preexisting sales.
  await repo.createBook(defaultBook('close-book', 'Close', 'retail_partnership'), defaultAccounts('close-book'));
  const closeRepo = new V2CloseBooksRepository(db);
  await closeRepo.addMember({ id: 'closer', bookId: 'close-book', name: 'Closer', openingContribution: 100, profitSharePct: 100 });
  for (const [id, startDate, endDate] of [['p1', '2026-01-01', '2026-01-31'], ['p2', '2026-02-01', '2026-02-28']] as const) {
    await repo.createPeriod({ id, bookId: 'close-book', startDate, endDate, status: 'open' });
  }
  const ledger = new V2InvestorLedgerService(db);
  await ledger.deposit({ bookId: 'close-book', memberId: 'closer', date: '2026-01-10', amount: 50 });
  await closeRepo.closeBooks({ id: 'close-one', bookId: 'close-book', periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 0 });
  const read = () => ports.businessAccounts({ memberId: 'closer' }, { kind: 'company' }, { ...scope, bookId: 'close-book' }, { limit: 25, after: null });
  expect((await read())?.members.rows[0]).toMatchObject({ openingCapital: 150, injected: 0, currentCapital: 150 });
  // There is no reopen API in closeBooksRepository. Model the persisted restored
  // snapshot explicitly; this is adapter coverage, not a reopen-workflow test.
  await db.run("UPDATE v2_periods SET status='open' WHERE id='p1'");
  await db.run("UPDATE v2_members SET current_capital=100 WHERE id='closer'");
  expect((await read())?.members.rows[0]).toMatchObject({ openingCapital: 100, injected: 50, currentCapital: 150 });
  expect((await read())?.members.rows[0].currentCapital).toBe((await ledger.detail('close-book', 'closer')).currentCapitalBalance);
});

test('party search and statement use only the scoped book', async () => {
  const { ports } = await setup();
  const found = await ports.parties({ text: null, role: 'any' }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(found.rows.map(row => row.name)).toEqual(['Acme', 'Supply Co']);
  expect(found.rows.find(row => row.id === 'cust-a')).toMatchObject({ receivable: 60 });
  const statement = await ports.partyStatement({ partyId: 'cust-a', role: 'customer', range: { from: '2026-02-01', to: '2026-02-28' } }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(statement).toMatchObject({ openingBalance: 0, closingBalance: 60 });
  expect(statement?.movements.rows).toHaveLength(2);
});

test('entry and unpaid-invoice adapters return real identifiers and allocations', async () => {
  const { ports } = await setup();
  const entries = await ports.entries({ entity: 'invoice', range: { from: '2026-01-01', to: '2026-12-31' }, text: null }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(entries.rows).toHaveLength(1);
  expect(entries.rows[0]).toMatchObject({ id: 'inv-a', amount: 100, partyId: 'cust-a' });
  const detail = await ports.entry('receipt', 'receipt-a', { kind: 'company' }, scope);
  expect(detail?.allocations).toEqual([{ invoiceId: 'inv-a', amount: 40 }]);
  const unpaid = await ports.unpaidInvoices({ partyId: 'cust-a' }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(unpaid?.rows).toEqual([expect.objectContaining({ id: 'inv-a', outstanding: 60, allocated: 40 })]);
});

test('cash, inventory and Business Accounts read the authoritative rows', async () => {
  const { ports } = await setup();
  const cash = await ports.cashMovements({ from: '2026-02-01', to: '2026-02-28' }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(cash).toMatchObject({ openingBalance: 0, totalIn: 40, totalOut: 0, closingBalance: 40 });
  const inventory = await ports.inventory({ productQuery: 'Wid' }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(inventory.products?.rows).toEqual([{ id: 'product-a', name: 'Widget', unit: 'pc', quantity: 7, locationId: null }]);
  const members = await ports.businessAccounts({ memberId: null }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(members?.members.rows[0]).toMatchObject({ id: 'member-a', openingCapital: 100, currentCapital: 200 });
});

test('location restriction is applied in SQL and stale scope is rechecked', async () => {
  const { ports, guard } = await setup();
  const denied = await ports.entries({ entity: 'invoice', range: { from: '2026-01-01', to: '2026-12-31' }, text: null }, { kind: 'locations', ids: ['shop-b'] }, scope, { after: null, limit: 25 });
  expect(denied.rows).toEqual([]);
  expect(guard.assertCurrent).toHaveBeenCalledTimes(2);
});

test('paging is anchored and bounded', async () => {
  const { ports } = await setup();
  const first = await ports.parties({ text: null, role: 'any' }, { kind: 'company' }, scope, { after: null, limit: 1 });
  expect(first.rows).toHaveLength(1);
  expect(first.nextAnchor).not.toBeNull();
  const second = await ports.parties({ text: null, role: 'any' }, { kind: 'company' }, scope, { after: first.nextAnchor, limit: 1 });
  expect(second.rows[0].id).not.toBe(first.rows[0].id);
});

test('name-ordered lists throw STALE_CURSOR when the after id is gone', async () => {
  const { ports } = await setup();
  await expect(ports.parties({ text: null, role: 'any' }, { kind: 'company' }, scope, { after: '|missing-party', limit: 1 })).rejects.toThrow('STALE_CURSOR');
  await expect(ports.inventory({ productQuery: null }, { kind: 'company' }, scope, { after: '|missing-product', limit: 1 })).rejects.toThrow('STALE_CURSOR');
  await expect(ports.businessAccounts({ memberId: null }, { kind: 'company' }, scope, { after: '|missing-member', limit: 1 })).rejects.toThrow('STALE_CURSOR');
});

test('numeric reverse and delete flags hide live documents and inventory activity', async () => {
  const { db, repo, ports } = await setup();
  const post = (id: string, type: V2Source['type'], total: number, partyId: string, lines: V2JournalEntry['lines']) => repo.postSourceJournal(
    { id, bookId: 'a', type, date: '2026-03-01', locationId: 'shop-a', metadata: { total, partyId } },
    { id: id + '-j', bookId: 'a', periodId: 'a-p', date: '2026-03-01', memo: id, lines },
  );
  await post('inv-rev', 'invoice', 50, 'cust-a', [
    { accountId: 'a:account:1100', partyId: 'cust-a', debit: 50, credit: 0 }, { accountId: 'a:account:4000', debit: 0, credit: 50 },
  ]);
  await post('inv-del', 'invoice', 50, 'cust-a', [
    { accountId: 'a:account:1100', partyId: 'cust-a', debit: 50, credit: 0 }, { accountId: 'a:account:4000', debit: 0, credit: 50 },
  ]);
  await post('buy-live', 'cash_purchase', 15, 'supplier-a', [
    { accountId: 'a:account:6000', debit: 15, credit: 0 }, { accountId: 'a:account:1000', debit: 0, credit: 15 },
  ]);
  await post('buy-rev', 'cash_purchase', 800, 'supplier-a', [
    { accountId: 'a:account:6000', debit: 800, credit: 0 }, { accountId: 'a:account:1000', debit: 0, credit: 800 },
  ]);
  await db.run("UPDATE v2_sources SET metadata=json_set(metadata,'$.reversed',1) WHERE id IN ('inv-rev','buy-rev')");
  await db.run("UPDATE v2_sources SET metadata=json_set(metadata,'$.deleted','1') WHERE id='inv-del'");
  const entries = await ports.entries({ entity: 'invoice', range: { from: '2026-01-01', to: '2026-12-31' }, text: null }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(entries.rows.map(row => row.id)).toEqual(['inv-a']);
  const unpaid = await ports.unpaidInvoices({ partyId: 'cust-a' }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(unpaid?.rows.map(row => row.id)).toEqual(['inv-a']);
  expect(await ports.entry('invoice', 'inv-rev', { kind: 'company' }, scope)).toMatchObject({ reversed: true, editable: false });
  expect(await ports.entry('invoice', 'inv-del', { kind: 'company' }, scope)).toMatchObject({ deleted: true, editable: false });
  const inventory = await ports.inventory({ productQuery: null }, { kind: 'company' }, scope, { after: null, limit: 25 });
  expect(inventory.valuation).toMatchObject({ purchasesSince: 15, salesSince: 100 });
});
