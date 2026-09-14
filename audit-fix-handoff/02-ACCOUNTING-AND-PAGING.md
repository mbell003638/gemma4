# Phase 2 — branch-specific accounting and paging

All paths are inside the selected lab. Change `frontend/src/accountingV2/gemma/liveDataPorts.ts`; extend `frontend/__tests__/gemmaLiveDataPorts.test.ts` using its real SQLite setup. Do not mock query results for the accounting acceptance tests. Preserve before/after authorization guards, query binding, location restrictions, schema validation, observation limits and outer scope-bound cursor contracts.

## A06 — Codex cash paging

The adapter emits `journalId:sourceId` but compares the next cursor to `journalId`; journal IDs are also not unique per cash line. Use the journal LINE primary key as the movement ID. It is an observation identifier, not a source ID; retain sourceId separately.

In the cash SELECT, change `e.id` to `l.id AS id` (select `e.id AS journal_id` too only if needed). Replace the sort/cursor/mapping block with:

```ts
const compareId = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
const desc = period.slice().sort((x, y) =>
  compareId(String(y.date), String(x.date)) || compareId(String(y.id), String(x.id)));
const a = anchor(page);
const eligible = a.date
  ? desc.filter(row => row.date < a.date! || (row.date === a.date && String(row.id) < a.id!))
  : desc;
const movements = paged(eligible.slice(0, page.limit + 1).map(row => ({
  id: String(row.id), date: row.date,
  direction: Number(row.debit) > 0 ? 'in' as const : 'out' as const,
  amount: Number(row.debit) || Number(row.credit),
  sourceId: row.source_id || null, sourceType: row.source_type || null,
})), page);
```

Keep opening/closing/totalIn/totalOut computed over the whole authorized period, not only the page. Review Manus cash paging for the same journal-line uniqueness issue while adding the shared multi-line fixture; do not claim the Codex composite-ID bug existed there. If that fixture fails in Manus, fix its row identity while preserving its ascending cursor/date conventions and record it as an additional related fix.

Acceptance: two cash lines in one journal on the same day plus a different journal, page size 1; all identities returned exactly once, traversal terminates, first/last cursor correct, totals constant across pages. Include null source ID and foreign-book/location lines.

## A07 — Manus name-sorted lists

Chosen minimal repair: these adapters already read the full authorized result into memory. Locate the last unique identity in THAT ordered list and slice after it, instead of comparing IDs numerically/lexically. Preserve SQL name ordering. Fail closed on a missing/stale anchor instead of restarting at zero. This avoids introducing a second JavaScript collation that disagrees with SQLite's lower(name). No offset supplied by the model is trusted. Retain the existing scope/revision-bound outer cursor.

Add this helper in Manus `liveDataPorts.ts` (types Obj and Page are already imported):

```ts
function orderedPage<T>(
  rows: T[], request: { size: number; after: Obj | null }, key: (row: T) => string,
): Page<T> {
  if (!Number.isInteger(request.size) || request.size < 1 || request.size > 100) {
    throw new Error('INVALID_PAGE_SIZE');
  }
  const identities = rows.map(key);
  if (new Set(identities).size !== identities.length) throw new Error('DUPLICATE_PAGE_ID');
  let start = 0;
  if (request.after) {
    if (request.after.v !== 2 || typeof request.after.id !== 'string') throw new Error('INVALID_CURSOR');
    const index = identities.indexOf(request.after.id);
    if (index < 0) throw new Error('STALE_CURSOR');
    start = index + 1;
  }
  const shown = rows.slice(start, start + request.size);
  const hasMore = start + shown.length < rows.length;
  return {
    rows: shown, hasMore,
    next: hasMore && shown.length ? { v: 2, id: key(shown[shown.length - 1]) } : null,
  };
}
```

Use the branch's actual MAX_PAGE_ROWS instead of literal 100 if it is stricter; the helper may narrow but must not relax it. Version 2 invalidates old cursor payloads with a clear retry message. Verify the existing cursor parser permits the `v` field in its internal Obj payload; if its schema is closed, extend the internal schema while keeping all signature/scope/query checks.

Party roles need deterministic order within each party. Sort the filtered role strings before mapping. Replace parties' final cursor/filter/page lines with:

```ts
return orderedPage(expanded, request, row => JSON.stringify([row.id, row.role]));
```

Inventory: keep totalValue computed before paging and return `...orderedPage(mapped, request, row => row.productId)` with the existing valuation fields. Business accounts: `return orderedPage(members, request, row => row.memberId)`. Do NOT replace the shared date-based `page()` helper for all the other APIs.

Acceptance: Alpha(z), Beta(a), duplicate names, Unicode names, dual customer/supplier role on one party, page sizes 1 and 2, deleted anchor => STALE_CURSOR, malformed/version-1 cursor => INVALID_CURSOR. Iterate all pages for parties/inventory/members and compare to a one-page authorized reference. Keep feature/book/location/query cursor mismatch negative tests.

## A08 — Codex role-specific statements

Account constants in `frontend/src/accountingV2/types.ts`: AR 1100, AP 2000, customer advances 2100, supplier advances 1210. Net customer balance includes AR plus customer-advance debit-minus-credit; net supplier balance includes AP plus supplier-advance credit-minus-debit. The two roles must never share their account sets.

Inside partyStatement, replace its rows query with this reference code. Keep `party` validation and `l = loc(location,'l')` above it:

```ts
const accountCodes = query.role === 'customer' ? ['1100', '2100'] : ['2000', '1210'];
const rows = await db.all<any>(
  `SELECT s.id,s.type,s.date,s.reference,
          COALESCE(SUM(l.debit),0) debit,
          COALESCE(SUM(l.credit),0) credit
     FROM v2_sources s
     JOIN v2_journal_entries j ON j.source_id=s.id AND j.book_id=s.book_id
     JOIN v2_journal_lines l ON l.journal_id=j.id AND l.party_id=?${l.sql}
     JOIN v2_accounts a ON a.id=l.account_id AND a.book_id=s.book_id
    WHERE s.book_id=? AND s.date<=? AND a.code IN (?,?)
    GROUP BY s.id,s.type,s.date,s.reference
    ORDER BY s.date,s.id`,
  [query.partyId, ...l.params, scope.bookId, query.range.to, ...accountCodes],
);
```

In the running-balance map, use `const debit = Number(row.debit)` and `const credit = Number(row.credit)` for either role; remove `ap_debit`. Keep the branch's existing sign: customer `debit-credit`, supplier `credit-debit`. Negative balances mean an advance/overpayment, not an error. Do not hide negative balances or apply Math.abs.

This fixes the audited dual-role contamination and the two-sided advance postings. **Before closing A08**, compare the projection to authoritative debtor/supplier statements for manual/opening/reversal journals too. The proposed query preserves the existing source-based grouping; if the authoritative ledger includes source-less journal rows, extend it with a LEFT JOIN and stable journal fallback identity/date. Do not silently exclude legitimate history or claim complete statement coverage based only on the simple fixture. Never omit original/reversal pairs just because source metadata says reversed: balanced ledger semantics, not active-source UI filtering, govern net balances.

Required SQLite fixtures: dual-role invoice100 plus supplier bill70 => customer100/supplier70; customer receipt/advance and its reversal; supplier prepayment and its reversal; opening before from; excluded later posting; source-less journal if supported; foreign book/location; full movement sum reconciles opening and closing across all pages. Repeat expected values against the existing ordinary statement service, not a duplicated copy of the new SQL.

## A09 — Codex current-period capital

Minimal exact repair to the sources query in businessAccounts:

```ts
const sources = await db.all<any>(
  "SELECT id,type,metadata FROM v2_sources WHERE book_id=? AND date>=? AND date<=? AND type IN ('capital_injection','drawing') AND json_extract(metadata,'$.memberId')=?",
  [scope.bookId, period.start_date, period.end_date, row.id],
);
```

Do not stop at that line: currentProfitShare and legacy member matching in `V2InvestorLedgerService` already encode authoritative business rules. Prefer a **read-only projection extraction** shared by that service and the adapter. Its existing `detail(bookId,memberId)` method returns `openingCapital`, `totalInjected`, `totalDrawings`, `currentCapitalBalance`, `profitSharePct` and period bounds. For partnership books the mapping is:

```ts
const detail = await ledger.detail(scope.bookId, row.id);
members.push({
  id: detail.id, name: detail.name, profitSharePct: detail.profitSharePct,
  openingCapital: detail.openingCapital, injected: detail.totalInjected,
  drawings: detail.totalDrawings, currentCapital: detail.currentCapitalBalance,
  revision: await revision(db, scope.bookId, row.id),
});
```

Do not blindly call that partnership-only method for every persona. For other personas retain existing allowed behavior, apply period bounds, and use shared pure rounding/profit helpers where the semantics agree. Do not widen permissions or change product availability to make the test pass. Prefer extracting a projection helper accepting explicit book/period/member arguments rather than importing `api.ts` (which captures global state). Match the authoritative `round2` and partnership profit/commission treatment; raw `netProfit * pct` is not automatically equivalent. Characterize the service before extraction, including its legacy memberName matching.

Acceptance: carried150 with prior deposit50 and no current movement =>150; current deposit20/drawing10 =>160 before profit; closed/reopened period; reversed/deleted deposits; legacy member-name source; rounding/commission; partnership and supported non-partnership persona. Leave Manus's already period-bounded implementation alone except A07 unless an independent regression demonstrates another defect.
