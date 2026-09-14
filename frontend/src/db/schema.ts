/**
 * SQLite schema + runner contract for the Ledgr data layer.
 * Non-posting document collections remain row-per-record JSON tables; V2 uses
 * normalized tables for books, parties, accounts, periods, sources, journals,
 * and lines.
 */

export interface SqlRunner {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: any[]): Promise<void>;
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
  first<T = any>(sql: string, params?: any[]): Promise<T | null>;
}

export const COLLECTIONS = [
  'suppliers', 'bills', 'sales', 'payments', 'inventoryChecks', 'periods', 'expenses',
  'debtors', 'invoices', 'quotes', 'receipts', 'creditNotes', 'debitNotes', 'deliveryNotes', 'cashEntries',
] as const;
export type CollectionName = typeof COLLECTIONS[number];
export const SCHEMA_VERSION = 15;

export const V2_TABLES = [
  'v2_books', 'v2_personas', 'v2_parties', 'v2_accounts', 'v2_periods', 'v2_sources',
  'v2_journal_entries', 'v2_journal_lines', 'v2_invoice_allocations', 'v2_inventory_counts',
  'v2_members', 'v2_close_books',
  'v2_employees', 'v2_pay_runs', 'v2_payslips',
  'v2_products', 'v2_stock_moves',
  'v2_locations',
] as const;

export function schemaSql(): string {
  const documents = COLLECTIONS.map((c) => `
    CREATE TABLE IF NOT EXISTS ${c} (id TEXT PRIMARY KEY, date TEXT, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_${c}_date ON ${c}(date);`).join('\n');
  return `${documents}
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS v2_books (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, style TEXT NOT NULL, basis TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v2_personas (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL, enabled INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}',
      UNIQUE(book_id, type), FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_parties (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, email TEXT, roles TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(book_id) REFERENCES v2_books(id)
    );
    CREATE TABLE IF NOT EXISTS v2_accounts (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, payment_method TEXT, active INTEGER NOT NULL,
      UNIQUE(book_id, code), FOREIGN KEY(book_id) REFERENCES v2_books(id)
    );
    CREATE TABLE IF NOT EXISTS v2_periods (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL, close_snapshot TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id)
    );
    CREATE TABLE IF NOT EXISTS v2_sources (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL, reference TEXT, metadata TEXT,
      location_id TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id)
    );
    CREATE TABLE IF NOT EXISTS v2_journal_entries (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, period_id TEXT NOT NULL, source_id TEXT, date TEXT NOT NULL, memo TEXT NOT NULL, posted_at TEXT NOT NULL, reversal_of TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(period_id) REFERENCES v2_periods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(reversal_of) REFERENCES v2_journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT NOT NULL, account_id TEXT NOT NULL, party_id TEXT,
      debit REAL NOT NULL CHECK(typeof(debit) IN ('integer','real') AND debit >= 0),
      credit REAL NOT NULL CHECK(typeof(credit) IN ('integer','real') AND credit >= 0), memo TEXT,
      location_id TEXT,
      CHECK((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
      FOREIGN KEY(journal_id) REFERENCES v2_journal_entries(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(account_id) REFERENCES v2_accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(party_id) REFERENCES v2_parties(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_invoice_allocations (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, invoice_source_id TEXT NOT NULL, receipt_source_id TEXT NOT NULL,
      amount REAL NOT NULL CHECK(typeof(amount) IN ('integer','real') AND amount > 0), allocated_at TEXT NOT NULL,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(invoice_source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(receipt_source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_inventory_counts (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, period_id TEXT NOT NULL, date TEXT NOT NULL,
      value REAL NOT NULL CHECK(typeof(value) IN ('integer','real') AND value >= 0), location_id TEXT, notes TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(period_id) REFERENCES v2_periods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(location_id) REFERENCES v2_locations(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_members (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL,
      opening_contribution REAL NOT NULL CHECK(typeof(opening_contribution) IN ('integer','real') AND opening_contribution >= 0),
      current_capital REAL NOT NULL CHECK(typeof(current_capital) IN ('integer','real')),
      profit_share_pct REAL NOT NULL CHECK(typeof(profit_share_pct) IN ('integer','real') AND profit_share_pct >= 0 AND profit_share_pct <= 100),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_close_books (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, period_id TEXT NOT NULL, closed_at TEXT NOT NULL, snapshot TEXT NOT NULL, journal_id TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(period_id) REFERENCES v2_periods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(journal_id) REFERENCES v2_journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      UNIQUE(book_id, period_id)
    );
    CREATE TABLE IF NOT EXISTS v2_employees (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT,
      pay_rate REAL NOT NULL DEFAULT 0, tax_withhold_pct REAL NOT NULL DEFAULT 0,
      start_date TEXT, archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_pay_runs (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, period_id TEXT NOT NULL, date TEXT NOT NULL,
      notes TEXT, source_id TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(period_id) REFERENCES v2_periods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_payslips (
      id TEXT PRIMARY KEY, pay_run_id TEXT NOT NULL, employee_id TEXT NOT NULL,
      gross REAL NOT NULL, tax_withheld REAL NOT NULL, net REAL NOT NULL, notes TEXT,
      FOREIGN KEY(pay_run_id) REFERENCES v2_pay_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(employee_id) REFERENCES v2_employees(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_products (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, sku TEXT, name TEXT NOT NULL, unit TEXT,
      cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, qty REAL NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_stock_moves (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, product_id TEXT NOT NULL, date TEXT NOT NULL,
      qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL, source_id TEXT,
      location_id TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(product_id) REFERENCES v2_products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_locations (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_unique_reversal ON v2_journal_entries(reversal_of) WHERE reversal_of IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_v2_journals_book_date ON v2_journal_entries(book_id, date);
    CREATE INDEX IF NOT EXISTS idx_v2_journal_lines_journal ON v2_journal_lines(journal_id);
    CREATE INDEX IF NOT EXISTS idx_v2_sources_book_date ON v2_sources(book_id, date);
    CREATE INDEX IF NOT EXISTS idx_v2_alloc_invoice ON v2_invoice_allocations(invoice_source_id);

    CREATE TABLE IF NOT EXISTS sync_profiles (
      id TEXT PRIMARY KEY, server_url TEXT NOT NULL, user_id TEXT, device_id TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT '', book_epoch TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
      recovery_required INTEGER NOT NULL DEFAULT 0, recovery_reason TEXT, last_sync_at TEXT, oidc_issuer TEXT, oidc_client_id TEXT, oidc_scopes TEXT, protocol_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_device_state (
      book_id TEXT NOT NULL, device_id TEXT NOT NULL, book_epoch TEXT NOT NULL,
      next_sequence INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      PRIMARY KEY(book_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS sync_outbox (
      op_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, book_epoch TEXT NOT NULL, device_id TEXT NOT NULL,
      device_sequence INTEGER NOT NULL, actor_id TEXT NOT NULL, command_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL, base_revision INTEGER, dependencies TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL, payload_hash TEXT NOT NULL, client_created_at TEXT NOT NULL,
      business_date TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT, last_error TEXT, accepted_book_sequence INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(book_id, device_id, device_sequence)
    );
    CREATE TABLE IF NOT EXISTS sync_applied_ops (
      op_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, book_sequence INTEGER NOT NULL,
      applied_at TEXT NOT NULL, aggregate_revision INTEGER, apply_mode TEXT NOT NULL DEFAULT 'replayed', resolution_conflict_id TEXT,
      UNIQUE(book_id, book_sequence)
    );
    CREATE TABLE IF NOT EXISTS sync_book_state (
      book_id TEXT PRIMARY KEY, book_epoch TEXT NOT NULL, server_cursor INTEGER NOT NULL DEFAULT 0,
      snapshot_hash TEXT, projection_hash TEXT, last_verified_at TEXT, epoch_number INTEGER,
      epoch_start_sequence INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_entity_revisions (
      book_id TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(book_id, aggregate_type, aggregate_id)
    );
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      conflict_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, op_id TEXT NOT NULL,
      canonical_op_id TEXT, aggregate_id TEXT, command_type TEXT, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      base_payload TEXT, local_payload TEXT NOT NULL, canonical_payload TEXT,
      remote_operation TEXT, blocking_book_sequence INTEGER, canonical_revision INTEGER, resolution_type TEXT,
      resolution_op_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_bootstrap_history (
      snapshot_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, book_epoch TEXT NOT NULL,
      through_sequence INTEGER NOT NULL, payload_hash TEXT NOT NULL, checkpoint_hash TEXT NOT NULL,
      projection_hash TEXT, installed_at TEXT NOT NULL, replay_operation_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS sync_conflict_resolutions (
      resolution_id TEXT PRIMARY KEY, conflict_id TEXT NOT NULL, book_id TEXT NOT NULL,
      resolution_type TEXT NOT NULL, resolution_op_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_tombstones (
      book_id TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      op_id TEXT NOT NULL, book_sequence INTEGER, created_at TEXT NOT NULL,
      PRIMARY KEY(book_id, aggregate_type, aggregate_id)
    );
    CREATE TABLE IF NOT EXISTS assistant_proposals (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      normalized_json TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      entity_versions_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','applied','cancelled','expired')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(book_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_proposals_book_state ON assistant_proposals(book_id, state, created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_status ON sync_outbox(book_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_applied_book_seq ON sync_applied_ops(book_id, book_sequence);
    CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON sync_conflicts(book_id, status, created_at);
  `;
}

async function addColumnIfMissing(db: SqlRunner, table: string, column: string, definition: string): Promise<void> {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export async function initSchema(db: SqlRunner): Promise<void> {
  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA busy_timeout = 5000;');
  await db.exec('PRAGMA synchronous = NORMAL;');
  await db.exec('PRAGMA wal_autocheckpoint = 1000;');
  await db.exec(schemaSql());
  // Schema 7: drop the unused Fixed Asset Register tables. Chart accounts 1400/1450 stay.
  // Legacy fixed-asset tables may contain user-entered data from earlier builds.
  // Keep them intact even though the current UI uses generic dated asset entries.
  // A future explicit migration can convert them after a verified backup.
  await addColumnIfMissing(db, 'v2_sources', 'location_id', 'TEXT');
  await addColumnIfMissing(db, 'v2_journal_lines', 'location_id', 'TEXT');
  await addColumnIfMissing(db, 'v2_stock_moves', 'location_id', 'TEXT');
  await addColumnIfMissing(db, 'v2_inventory_counts', 'location_id', 'TEXT');
  await addColumnIfMissing(db, 'v2_inventory_counts', 'notes', "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing(db, 'sync_profiles', 'device_id', "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing(db, 'sync_profiles', 'actor_id', "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing(db, 'sync_profiles', 'book_epoch', "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing(db, 'sync_profiles', 'recovery_required', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(db, 'sync_profiles', 'recovery_reason', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'last_sync_at', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'oidc_issuer', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'oidc_client_id', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'oidc_scopes', 'TEXT');
  await addColumnIfMissing(db, 'sync_applied_ops', 'aggregate_revision', 'INTEGER');
  await addColumnIfMissing(db, 'sync_applied_ops', 'apply_mode', "TEXT NOT NULL DEFAULT 'replayed'");
  await addColumnIfMissing(db, 'sync_applied_ops', 'resolution_conflict_id', 'TEXT');
  await addColumnIfMissing(db, 'sync_book_state', 'projection_hash', 'TEXT');
  await addColumnIfMissing(db, 'sync_book_state', 'last_verified_at', 'TEXT');
  await addColumnIfMissing(db, 'sync_book_state', 'epoch_number', 'INTEGER');
  await addColumnIfMissing(db, 'sync_book_state', 'epoch_start_sequence', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(db, 'sync_conflicts', 'aggregate_id', 'TEXT');
  await addColumnIfMissing(db, 'sync_conflicts', 'command_type', 'TEXT');
  await addColumnIfMissing(db, 'sync_conflicts', 'remote_operation', 'TEXT');
  await addColumnIfMissing(db, 'sync_conflicts', 'blocking_book_sequence', 'INTEGER');
  await addColumnIfMissing(db, 'sync_conflicts', 'canonical_revision', 'INTEGER');
  await addColumnIfMissing(db, 'sync_conflicts', 'resolution_type', 'TEXT');
  await addColumnIfMissing(db, 'sync_conflicts', 'resolution_op_id', 'TEXT');
  const personaColumns = await db.all<{ name: string }>('PRAGMA table_info(v2_personas)');
  if (!personaColumns.some((column) => column.name === 'active')) {
    await db.exec('ALTER TABLE v2_personas ADD COLUMN active INTEGER NOT NULL DEFAULT 0;');
  }
  const memberColumns = await db.all<{ name: string }>('PRAGMA table_info(v2_members)');
  if (!memberColumns.some((column) => column.name === 'current_capital')) {
    await db.exec('ALTER TABLE v2_members ADD COLUMN current_capital REAL NOT NULL DEFAULT 0;');
    await db.exec('UPDATE v2_members SET current_capital = opening_contribution;');
  }
  await db.run("UPDATE v2_accounts SET name='Capital Accounts' WHERE code='3000' AND name='Member Capital'");
  await db.run("UPDATE v2_accounts SET name='Capital Withdrawals' WHERE code='3100' AND name='Member Drawings'");
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_persona_book_type ON v2_personas(book_id, type);');
  const booksWithoutActivePersona = await db.all<{ book_id: string }>(`SELECT book_id FROM v2_personas
    GROUP BY book_id HAVING SUM(CASE WHEN enabled = 1 AND active = 1 THEN 1 ELSE 0 END) = 0
    AND SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) > 0`);
  for (const { book_id } of booksWithoutActivePersona) {
    const firstPersona = await db.first<{ id: string }>('SELECT id FROM v2_personas WHERE book_id = ? AND enabled = 1 ORDER BY rowid LIMIT 1', [book_id]);
    if (firstPersona) await db.run('UPDATE v2_personas SET active = 1 WHERE id = ?', [firstPersona.id]);
  }
  const row = await db.first<{ value: string }>('SELECT value FROM meta WHERE key = \'schema_version\'');
  if (!row) await db.run('INSERT INTO meta(key, value) VALUES(\'schema_version\', ?)', [String(SCHEMA_VERSION)]);
  else if (Number(row.value) < SCHEMA_VERSION) await db.run('UPDATE meta SET value = ? WHERE key = \'schema_version\'', [String(SCHEMA_VERSION)]);
}
