import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { buildScope } from '../src/accountingV2/gemma/scopeContext';
import { createLivePermissions, createLiveScopeGuard, createSqlScopePorts, type LiveScopeProviders } from '../src/accountingV2/gemma/liveScopePorts';

const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach(close => close()));

async function setup() {
  const { runner: db, close } = makeNodeRunner(); closes.push(close);
  await initSchema(db);
  const repo = new V2SqlRepository(db);
  await repo.createBook(defaultBook('a', 'A'), defaultAccounts('a'));
  await repo.createPeriod({ id: 'p', bookId: 'a', startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
  await db.run("INSERT INTO meta(key,value) VALUES('v2_active_book_id','a') ON CONFLICT(key) DO UPDATE SET value='a'");
  await db.run("INSERT INTO settings(key,value) VALUES('v2_prefs:a',?)", [JSON.stringify({ enabledFeatures: ['inventory'], activeLocationId: 'shop' })]);
  let session = { storageReady: true, unlocked: true, epoch: 4 };
  let version = 7;
  const providers: LiveScopeProviders = {
    activeBookId: () => 'a', readSettings: async () => ({ currency: 'inr' }), session: () => session,
    dataVersion: () => version, now: () => new Date('2026-09-10T04:00:00Z'), timeZone: () => 'Asia/Calcutta',
  };
  return { db, providers, ports: createSqlScopePorts(db, providers), setSession: (next: typeof session) => { session = next; }, bump: () => { version += 1; } };
}

test('builds every scope field from trusted persisted state', async () => {
  const { ports } = await setup();
  await expect(buildScope(ports)).resolves.toEqual({
    bookId: 'a', actorId: 'local-owner', locationId: 'shop', permissionEpoch: 'local-owner:4',
    featureEpoch: '["inventory"]', revision: '7:0::0', currency: 'INR', basis: 'accrual',
    today: '2026-09-10', timeZone: 'Asia/Calcutta',
  });
});

test('fails closed while locked, on book disagreement, and for unpersisted sync grants', async () => {
  const { db, providers, setSession } = await setup();
  setSession({ storageReady: true, unlocked: false, epoch: 5 });
  await expect(buildScope(createSqlScopePorts(db, providers))).rejects.toMatchObject({ code: 'APP_LOCKED' });
  setSession({ storageReady: true, unlocked: true, epoch: 6 });
  providers.activeBookId = () => 'other';
  await expect(buildScope(createSqlScopePorts(db, providers))).rejects.toMatchObject({ code: 'NO_ACTIVE_BOOK' });
  providers.activeBookId = () => 'a';
  await db.run("INSERT INTO sync_profiles(id,server_url,user_id,enabled,created_at,updated_at) VALUES('a','https://sync.example','u',1,'x','x')");
  await expect(buildScope(createSqlScopePorts(db, providers))).rejects.toMatchObject({ code: 'NO_ACTOR' });
});

test('revision and lock changes invalidate guards and permissions', async () => {
  const { ports, bump } = await setup();
  const scope = await buildScope(ports);
  const guard = createLiveScopeGuard(ports);
  const permissions = createLivePermissions(ports);
  await expect(guard.assertCurrent(scope)).resolves.toBeUndefined();
  await expect(permissions.canRead('reports', scope)).resolves.toBe(true);
  bump();
  await expect(guard.assertCurrent(scope)).rejects.toThrow('STALE_SCOPE');
  await expect(permissions.canRead('reports', scope)).resolves.toBe(false);
});
