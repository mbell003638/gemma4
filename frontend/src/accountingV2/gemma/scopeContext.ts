/**
 * Builds the trusted `Scope` for one turn.
 *
 * `Scope` is the boundary of everything the model can reach: the book, the
 * location, the actor, the currency, the accounting basis and the data
 * revision. It is assembled here from real configuration and never from model
 * output, a document, or a default.
 *
 * The rule that matters most: **this must fail rather than guess.** A
 * hard-coded USD, an assumed accrual basis, an owner actor or an
 * all-locations fallback in a catch block does not degrade gracefully — it
 * silently answers about the wrong money, or answers someone who should not
 * have been answered. Every field is required.
 *
 * Ports, not `api.ts` imports: see the note at the top of `coreReadTools.ts`.
 * See docs/plans/gemma4-litertlm/04-app-integration.md section 2.
 */
import type { Scope } from './agentCore';

export class ScopeUnavailableError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'ScopeUnavailableError';
  }
}

function fail(code: string, message?: string): never {
  throw new ScopeUnavailableError(code, message);
}

export type ScopePorts = {
  /** False when storage is not ready, the app is locked, or nobody is signed in. */
  isUnlocked(): Promise<boolean>;
  /** The active book, or null when none is selected. */
  activeBookId(): Promise<string | null>;
  /** The selected location, or null for "nothing selected" (NOT "everywhere"). */
  activeLocationId(): Promise<string | null>;
  /**
   * The effective actor plus an epoch that changes whenever their permissions
   * do. The epoch is what lets a mid-turn role change invalidate the turn.
   */
  actor(): Promise<{ id: string; permissionEpoch: string } | null>;
  /** Changes whenever the enabled-feature set changes. */
  featureEpoch(): Promise<string | null>;
  /**
   * A journal/entity revision that changes on every write, including writes
   * applied by sync.
   *
   * NOT `api.v2BookVersion()`: that is the accounting SCHEMA version and
   * changes on migration, so using it here would mark data fresh across every
   * posting the app ever makes. `getDataVersion()` is useful for in-process
   * invalidation but is not by itself a durable cross-device revision; audit
   * every `bumpDataVersion` and sync notification path before trusting it.
   */
  dataRevision(): Promise<string | null>;
  /** From real book configuration. No default. */
  bookConfig(): Promise<{ currency: string; basis: 'cash' | 'accrual' } | null>;
  /** Device-local calendar day and zone, so "today" means the user's today. */
  localDate(): Promise<{ today: string; timeZone: string } | null>;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** ISO 4217: three letters. A symbol or a name is a configuration bug. */
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Assembles the scope, or throws.
 *
 * Passed to the agent core as `currentScope`, which calls it again after every
 * model turn and before every tool read. That is how a book switch, a lock or
 * a role change mid-answer stops the turn: the comparison is cheap, and the
 * cost of getting it wrong is answering about another book's money.
 */
export async function buildScope(ports: ScopePorts): Promise<Scope> {
  if (!await ports.isUnlocked()) fail('APP_LOCKED', 'The app is locked or signed out');

  const bookId = await ports.activeBookId();
  if (!bookId) fail('NO_ACTIVE_BOOK', 'No book is open');

  const actor = await ports.actor();
  if (!actor?.id) fail('NO_ACTOR', 'No effective user for this book');
  if (!actor.permissionEpoch) fail('NO_PERMISSION_EPOCH', 'Permissions carry no epoch to invalidate against');

  const featureEpoch = await ports.featureEpoch();
  if (!featureEpoch) fail('NO_FEATURE_EPOCH', 'Enabled features carry no epoch');

  const revision = await ports.dataRevision();
  if (!revision) fail('NO_DATA_REVISION', 'No journal revision to detect a mid-turn write');

  const config = await ports.bookConfig();
  if (!config) fail('NO_BOOK_CONFIG', 'Book currency and accounting basis are unavailable');
  if (!CURRENCY.test(config.currency)) fail('INVALID_CURRENCY', 'Book currency is not an ISO 4217 code');
  if (config.basis !== 'cash' && config.basis !== 'accrual') {
    fail('INVALID_BASIS', 'Book accounting basis is neither cash nor accrual');
  }

  const date = await ports.localDate();
  if (!date) fail('NO_LOCAL_DATE', 'Device date and time zone are unavailable');
  if (!ISO_DATE.test(date.today)) fail('INVALID_LOCAL_DATE', 'Device date is not an ISO calendar date');
  if (!date.timeZone) fail('NO_TIME_ZONE', 'Device time zone is unavailable');

  return {
    bookId,
    // null means "no location selected". It does NOT mean company-wide access:
    // `resolveLocationScope` decides that from the actor's real grants.
    locationId: await ports.activeLocationId(),
    actorId: actor.id,
    permissionEpoch: actor.permissionEpoch,
    featureEpoch,
    revision,
    currency: config.currency,
    basis: config.basis,
    today: date.today,
    timeZone: date.timeZone,
  };
}

/**
 * A monotonic request epoch for the composition root.
 *
 * `Scope` equality catches a book switch or a posting, but some invalidations
 * are not visible in any of its fields — a sync notification that changed
 * nothing yet, a screen teardown, a model switch. The composition root bumps
 * this on those, and a turn holding a stale epoch is abandoned.
 */
export function createRequestEpoch() {
  let epoch = 0;
  return {
    current: () => epoch,
    bump: () => { epoch += 1; return epoch; },
    /** Throws once the epoch has moved on, so a late result cannot be used. */
    assert: (held: number) => {
      if (held !== epoch) throw new ScopeUnavailableError('STALE_REQUEST_EPOCH');
    },
  };
}

/** Local calendar day in a specific zone, without pulling in a date library. */
export function localCalendarDay(now: Date, timeZone: string): string {
  // `en-CA` formats as YYYY-MM-DD, which is the shape the tools validate.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  if (!ISO_DATE.test(parts)) throw new ScopeUnavailableError('INVALID_LOCAL_DATE');
  return parts;
}
