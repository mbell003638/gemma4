import { activeBookId, activeSqlRunner, readSettings } from '../../db/backend';
import type { SqlRunner } from '../../db/schema';
import { getDataVersion } from '../../utils/dataVersion';
import { assertAssistantSessionReady, getAssistantSessionState } from '../../utils/assistantSessionState';
import { readV2BookPrefs } from '../optionalModules';
import { sameScope } from './agentCore';
import type { PermissionPorts } from './coreReadTools';
import { buildScope, localCalendarDay, type ScopePorts } from './scopeContext';
import type { ReportReadGuard } from './scopedReportReader';

export type LiveScopeProviders = {
  activeBookId(): string;
  readSettings(): Promise<Record<string, unknown>>;
  session(): { storageReady: boolean; unlocked: boolean; epoch: number };
  dataVersion(): number;
  now(): Date;
  timeZone(): string;
};

const productionProviders: LiveScopeProviders = {
  activeBookId,
  readSettings,
  session: getAssistantSessionState,
  dataVersion: getDataVersion,
  now: () => new Date(),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export function createSqlScopePorts(db: SqlRunner, providers: LiveScopeProviders): ScopePorts {
  const selectedBook = async () => {
    const memoryId = providers.activeBookId();
    const persisted = await db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    return memoryId && persisted?.value === memoryId ? memoryId : null;
  };
  return {
    isUnlocked: async () => {
      const session = providers.session();
      return session.storageReady && session.unlocked;
    },
    activeBookId: selectedBook,
    activeLocationId: async () => {
      const bookId = await selectedBook();
      if (!bookId) return null;
      const prefs = await readV2BookPrefs(db, bookId);
      return prefs?.activeLocationId?.trim() || null;
    },
    actor: async () => {
      const bookId = await selectedBook();
      if (!bookId) return null;
      const sync = await db.first<{ enabled: number; updated_at: string }>('SELECT enabled,updated_at FROM sync_profiles WHERE id=?', [bookId]);
      // The current local schema does not persist the enrolled role/location
      // grants. Never turn an authenticated sync identity into an owner guess.
      if (sync && Boolean(sync.enabled)) return null;
      const session = providers.session();
      return { id: 'local-owner', permissionEpoch: `local-owner:${session.epoch}` };
    },
    featureEpoch: async () => {
      const bookId = await selectedBook();
      if (!bookId) return null;
      const prefs = await readV2BookPrefs(db, bookId);
      return JSON.stringify([...(prefs?.enabledFeatures || [])].sort());
    },
    dataRevision: async () => {
      const bookId = await selectedBook();
      if (!bookId) return null;
      const journal = await db.first<{ count: number; stamp: string }>("SELECT COUNT(*) count,COALESCE(MAX(posted_at),'') stamp FROM v2_journal_entries WHERE book_id=?", [bookId]);
      const entities = await db.first<{ revision: number }>('SELECT COALESCE(MAX(revision),0) revision FROM sync_entity_revisions WHERE book_id=?', [bookId]);
      return `${providers.dataVersion()}:${Number(journal?.count || 0)}:${journal?.stamp || ''}:${Number(entities?.revision || 0)}`;
    },
    bookConfig: async () => {
      const bookId = await selectedBook();
      if (!bookId) return null;
      const [book, settings] = await Promise.all([
        db.first<{ basis: string }>('SELECT basis FROM v2_books WHERE id=?', [bookId]),
        providers.readSettings(),
      ]);
      const currency = String(settings.currency || '').toUpperCase();
      return book && (book.basis === 'cash' || book.basis === 'accrual')
        ? { currency, basis: book.basis }
        : null;
    },
    localDate: async () => {
      const timeZone = providers.timeZone();
      return timeZone ? { timeZone, today: localCalendarDay(providers.now(), timeZone) } : null;
    },
  };
}

export function liveScopePorts(): ScopePorts {
  assertAssistantSessionReady();
  const db = activeSqlRunner();
  if (!db) throw new Error('SQLITE_NOT_READY');
  return createSqlScopePorts(db, productionProviders);
}

export function createLiveScopeGuard(ports: ScopePorts): ReportReadGuard {
  const current = () => buildScope(ports);
  return {
    assertCurrent: async (expected) => { if (!sameScope(expected, await current())) throw new Error('STALE_SCOPE'); },
    canReadReports: async (expected) => sameScope(expected, await current()),
    authorizedLocations: async (expected) => sameScope(expected, await current()) ? 'all' : [],
  };
}

export function createLivePermissions(ports: ScopePorts): PermissionPorts {
  const current = () => buildScope(ports);
  return {
    canRead: async (_feature, expected) => sameScope(expected, await current()),
    authorizedLocations: async (expected) => sameScope(expected, await current()) ? 'all' : [],
  };
}
