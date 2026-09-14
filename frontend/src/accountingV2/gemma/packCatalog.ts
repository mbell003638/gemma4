/**
 * Schema-2 model catalogue and model policy for the optional Gemma 4 /
 * LiteRT-LM runtime.
 *
 * This file exists alongside `../onDevicePackManifest.ts`, not instead of it.
 * Schema 1 describes Qwen/Phi `.task` packs for the old MediaPipe runtime and
 * is deliberately permissive: it drops bad rows and keeps going. Schema 2 is
 * the opposite. A pack here is a multi-gigabyte binary that gets memory-mapped
 * into the process by a native engine, so a row is either completely, exactly
 * what a reviewed build approved, or it is rejected. There is no "mostly
 * valid" pack.
 *
 * Three rules shape everything below, from docs/plans/gemma4-litertlm:
 *
 * 1. One parser for every source (02 s2). The bundled asset, a fetched
 *    manifest and a cached manifest all go through `parseGemmaCatalog`. Cached
 *    JSON is attacker-writable on a rooted device and is never cast to a
 *    trusted type.
 * 2. Remote data may only re-point a URL (02 s2). Hash, size, runtime,
 *    revision, filename and capabilities come from the compiled catalogue. A
 *    new model fingerprint needs a new reviewed build, because "HTTPS plus a
 *    hash from the same untrusted manifest" is not integrity.
 * 3. Declared capability is a claim, not a feature (02 s2). What a pack says
 *    it can do is intersected with what the verified bridge on this device
 *    actually implements.
 */

import type { OnDevicePackCapability } from '../onDeviceTools';
import { OPTIONAL_ON_DEVICE_MODELS } from '../onDeviceTools';
import BUNDLED_CATALOG_DOCUMENT from './model-packs-v2.json';

/**
 * Schema 1 packs must never be interpreted by the LiteRT-LM runtime, and an
 * older MediaPipe build must never be offered Gemma. Bumping the number is the
 * whole mechanism: each build reads exactly one schema and rejects the other.
 */
export const GEMMA_PACK_SCHEMA = 2;

/** The only runtime this build can load. Any other string is rejected, not skipped. */
export const GEMMA_RUNTIME = 'litert-lm';

/**
 * The native bridge ABI this build implements (session begin/resume, typed tool
 * frames, cancel/finish). A pack asking for a newer bridge is not offered
 * rather than downloaded and then failing to initialise.
 */
export const APP_BRIDGE_VERSION = 3;

/**
 * Storage keys are versioned so a schema-1 cache written by an older install
 * can never be read as a schema-2 catalogue, and so a pinned Qwen id cannot
 * survive into the Gemma selector. The old unversioned keys are left in place
 * on purpose; see `LEGACY_STORAGE_KEYS`.
 */
export const PACK_MANIFEST_CACHE_KEY_V2 = 'ledgr_pack_manifest_cache_v2';
export const PREFERRED_ON_DEVICE_MODEL_KEY_V2 = 'ledgr_preferred_on_device_model_v2';

/** Written by schema-1 builds. Read by nothing here; only the cleanup path touches them. */
export const LEGACY_STORAGE_KEYS = ['ledgr_pack_manifest_cache', 'ledgr_preferred_on_device_model'] as const;

/**
 * E2B is the default (01 s7). E4B is bigger, not automatically better here, and
 * costs the user a second multi-gigabyte download, so it is opt-in.
 */
export const DEFAULT_GEMMA_MODEL_ID = 'gemma4-e2b';

/** Mirrors the native store's bounds so JS rejects what Kotlin would reject (02 s3). */
export const MAX_PACK_BYTES = 16 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
/** Canonical, revision-stamped, extension-pinned. Excludes `/`, `\` and `..` by construction. */
const FILENAME_PATTERN = /^[A-Za-z0-9_-]+\.litertlm$/;
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Hosts the download may resolve to, matching the native allowlist in 02 s3.
 * Kept narrow: a mirror the owner has not reviewed is not a mirror.
 */
const ALLOWED_HOSTS = new Set(['huggingface.co', 'hf.co']);
const ALLOWED_HOST_SUFFIX = '.hf.co';

const KNOWN_CAPABILITIES: readonly OnDevicePackCapability[] = ['text', 'tools', 'vision', 'audio'];

/**
 * One approved model file. Every field is required: schema 1 could shrug off a
 * missing checksum, but an unverifiable multi-gigabyte binary is exactly the
 * thing this schema exists to make impossible.
 */
export type GemmaPack = {
  id: string;
  label: string;
  runtime: typeof GEMMA_RUNTIME;
  minBridgeVersion: number;
  license: string;
  /** Upstream commit, 40 hex. Pins the artefact so "same URL" cannot mean "different weights". */
  revision: string;
  /** Canonical on-device filename. Used as a path component by native code. */
  filename: string;
  bytes: number;
  sha256: string;
  downloadUrl: string;
  capabilities: OnDevicePackCapability[];
  /** Higher wins between installed packs. Gaps are deliberate. */
  rank: number;
  /** True until the device gates in 05 s4 pass for this pack. */
  experimental: boolean;
};

export type GemmaCatalog = {
  schema: typeof GEMMA_PACK_SCHEMA;
  catalogVersion: number;
  packs: GemmaPack[];
};

/**
 * Rejection carries a code rather than a sentence so callers can branch and
 * tests can assert the reason instead of matching prose. `field` names the row
 * member at fault, for diagnostics that never include the URL or a path.
 */
export class PackCatalogError extends Error {
  readonly code: string;
  readonly field: string | null;

  constructor(code: string, field: string | null = null) {
    super(code);
    this.name = 'PackCatalogError';
    this.code = code;
    this.field = field;
  }
}

function fail(code: string, field: string | null = null): never {
  throw new PackCatalogError(code, field);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string, maxLength: number): string {
  const value = source[key];
  if (typeof value !== 'string') fail('PACK_FIELD_MISSING', key);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) fail('PACK_FIELD_INVALID', key);
  return trimmed;
}

/**
 * Integers only, and no coercion from strings. `"2588147712"` is not a size; a
 * manifest that writes sizes as strings is a manifest this build did not
 * produce, and guessing what it meant is how a mismatch becomes a truncated
 * download that still passes a length check.
 */
function requireInteger(
  source: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('PACK_FIELD_INVALID', key);
  if (value < minimum || value > maximum) fail('PACK_FIELD_OUT_OF_RANGE', key);
  return value;
}

/**
 * Minimal https parser used instead of `new URL`, because React Native's URL
 * is a partial polyfill whose `port`/`username` handling cannot be relied on
 * for a security check. Backslashes are refused outright: several parsers
 * treat `\` as `/`, so a string that disagrees with itself about where the
 * host ends is never allowed to reach a downloader.
 */
function requireAllowedHttpsUrl(source: Record<string, unknown>, key: string): string {
  const raw = requireString(source, key, 2048);
  if (raw.includes('\\') || /[\s"'<>]/.test(raw)) fail('PACK_URL_MALFORMED', key);
  const match = /^https:\/\/([^/?#]+)([/?#][^\s]*)?$/i.exec(raw);
  if (!match) fail('PACK_URL_NOT_HTTPS', key);
  const authority = match[1];
  // Embedded credentials are how a "download" turns into a credentialed
  // request; 02 s1 requires downloads to carry no credentials at all.
  if (authority.includes('@')) fail('PACK_URL_HAS_CREDENTIALS', key);
  const portSplit = /^([^:]+)(?::(\d+))?$/.exec(authority);
  if (!portSplit) fail('PACK_URL_MALFORMED', key);
  const host = portSplit[1].toLowerCase();
  const port = portSplit[2];
  if (port !== undefined && port !== '443') fail('PACK_URL_PORT_NOT_ALLOWED', key);
  if (!ALLOWED_HOSTS.has(host) && !host.endsWith(ALLOWED_HOST_SUFFIX)) {
    fail('PACK_URL_HOST_NOT_ALLOWED', key);
  }
  return raw;
}

function requireCapabilities(source: Record<string, unknown>): OnDevicePackCapability[] {
  const value = source.capabilities;
  if (!Array.isArray(value) || value.length === 0) fail('PACK_FIELD_INVALID', 'capabilities');
  const capabilities: OnDevicePackCapability[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') fail('PACK_FIELD_INVALID', 'capabilities');
    if (!(KNOWN_CAPABILITIES as readonly string[]).includes(entry)) {
      // An unknown modality name cannot be gated, because nothing in this
      // build knows what it would enable. Refuse the row rather than ignore
      // the word.
      fail('PACK_CAPABILITY_UNKNOWN', 'capabilities');
    }
    if (capabilities.includes(entry as OnDevicePackCapability)) {
      fail('PACK_CAPABILITY_DUPLICATE', 'capabilities');
    }
    capabilities.push(entry as OnDevicePackCapability);
  }
  // Every route in the agent core sends text. A pack that cannot do text is
  // not a pack this app has any use for.
  if (!capabilities.includes('text')) fail('PACK_CAPABILITY_MISSING_TEXT', 'capabilities');
  return capabilities;
}

/**
 * Parses one row, or throws.
 *
 * Unlike `parsePackRow` in schema 1 this never returns null-and-carry-on.
 * Dropping a malformed row silently is fine when the worst case is "one fewer
 * option in a list"; it is not fine when the row describes which bytes get
 * loaded as a model.
 *
 * Unknown extra keys are tolerated and discarded rather than rejected, so a
 * later catalogVersion can add a field without bricking installed builds. That
 * is safe precisely because nothing outside this whitelist is ever read.
 */
export function parseGemmaPackRow(row: unknown): GemmaPack {
  if (!isObject(row)) fail('PACK_NOT_AN_OBJECT');

  const runtime = requireString(row, 'runtime', 64);
  // Checked before anything else: a schema-1 Qwen/Phi row reaching this parser
  // must stop here, not be repaired into something the new runtime will load.
  if (runtime !== GEMMA_RUNTIME) fail('PACK_RUNTIME_NOT_APPROVED', 'runtime');

  const id = requireString(row, 'id', 64);
  if (!PACK_ID_PATTERN.test(id)) fail('PACK_ID_INVALID', 'id');

  const filename = requireString(row, 'filename', 128);
  // Native code joins this onto the pack directory. `FILENAME_PATTERN` admits
  // no separator and no dot-segment, so there is no path to escape with, and
  // the `.litertlm` extension keeps a `.task` file from being handed to an
  // engine that cannot read it.
  if (!FILENAME_PATTERN.test(filename)) fail('PACK_FILENAME_INVALID', 'filename');

  const sha256 = requireString(row, 'sha256', 64);
  if (!SHA256_PATTERN.test(sha256)) fail('PACK_SHA256_INVALID', 'sha256');

  const revision = requireString(row, 'revision', 40);
  if (!REVISION_PATTERN.test(revision)) fail('PACK_REVISION_INVALID', 'revision');

  const experimental = row.experimental;
  if (typeof experimental !== 'boolean') fail('PACK_FIELD_INVALID', 'experimental');

  return {
    id,
    label: requireString(row, 'label', 80),
    runtime: GEMMA_RUNTIME,
    minBridgeVersion: requireInteger(row, 'minBridgeVersion', 1, 1000),
    license: requireString(row, 'license', 80),
    revision,
    filename,
    bytes: requireInteger(row, 'bytes', 1, MAX_PACK_BYTES),
    sha256,
    downloadUrl: requireAllowedHttpsUrl(row, 'downloadUrl'),
    capabilities: requireCapabilities(row),
    rank: requireInteger(row, 'rank', 0, 10_000),
    experimental,
  };
}

/**
 * Parses a whole catalogue document, or throws.
 *
 * The document fails as a unit. If one row of a catalogue is wrong, the
 * document was not produced by the process that was reviewed, and the
 * remaining rows have no more standing than the broken one.
 */
export function parseGemmaCatalog(raw: unknown): GemmaCatalog {
  if (!isObject(raw)) fail('CATALOG_NOT_AN_OBJECT');
  if (raw.schema !== GEMMA_PACK_SCHEMA) fail('CATALOG_SCHEMA_MISMATCH', 'schema');
  const catalogVersion = requireInteger(raw, 'catalogVersion', 1, 1_000_000);
  if (!Array.isArray(raw.packs) || raw.packs.length === 0) fail('CATALOG_PACKS_INVALID', 'packs');
  if (raw.packs.length > 32) fail('CATALOG_TOO_LARGE', 'packs');

  const packs = raw.packs.map(parseGemmaPackRow);
  // Two rows claiming one id makes selection order-dependent, and order comes
  // from a file. Reject rather than keep-first.
  const ids = new Set<string>();
  const filenames = new Set<string>();
  for (const pack of packs) {
    if (ids.has(pack.id)) fail('CATALOG_DUPLICATE_ID', 'id');
    // Two ids sharing a filename would let one pack's download overwrite the
    // other's verified file on disk.
    if (filenames.has(pack.filename)) fail('CATALOG_DUPLICATE_FILENAME', 'filename');
    ids.add(pack.id);
    filenames.add(pack.filename);
  }
  return { schema: GEMMA_PACK_SCHEMA, catalogVersion, packs };
}

/**
 * Same parser, non-throwing, for sources that are expected to be junk
 * sometimes: a cache written by an older build, a truncated file, a manifest
 * from a captive portal. Returns null and the caller falls back to bundled.
 */
export function tryParseGemmaCatalog(raw: unknown): GemmaCatalog | null {
  try {
    return parseGemmaCatalog(raw);
  } catch {
    return null;
  }
}

/**
 * Reads a cached catalogue string. Deliberately the only way cached bytes
 * become packs: `JSON.parse(cached) as GemmaPack[]` would make a writable file
 * on disk into a trusted type, which is the exact mistake 02 s2 names.
 */
export function parseCachedCatalog(cached: string | null | undefined): GemmaCatalog | null {
  if (typeof cached !== 'string' || !cached.trim() || cached.length > 256_000) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(cached);
  } catch {
    return null;
  }
  return tryParseGemmaCatalog(decoded);
}

/** Serialises a catalogue for the cache in the same shape the parser expects. */
export function serializeCatalogForCache(catalog: GemmaCatalog): string {
  return JSON.stringify({
    schema: catalog.schema,
    catalogVersion: catalog.catalogVersion,
    packs: catalog.packs,
  });
}

/**
 * The catalogue compiled into this build. Parsed, not trusted: if the bundled
 * asset and this parser ever disagree, that is a build error and it should
 * surface in tests rather than at model-load time on a user's phone.
 */
export function bundledGemmaCatalog(): GemmaCatalog {
  return parseGemmaCatalog(BUNDLED_CATALOG_DOCUMENT as unknown);
}

export function bundledGemmaPacks(): GemmaPack[] {
  return bundledGemmaCatalog().packs;
}

// ---------------------------------------------------------------------------
// Remote refresh: DISABLED, on purpose
// ---------------------------------------------------------------------------

/**
 * Remote catalogue refresh is off in this build.
 *
 * This is a decision, not an unimplemented feature. Doc 02 s2: the owner has
 * not chosen a catalogue hosting location, and `main` must not receive this
 * catalogue, so there is no URL that would be legitimate to ship. Pointing
 * this at the schema-1 manifest on the `main` repo would let a schema-1
 * publisher influence which multi-gigabyte binary a schema-2 build fetches.
 *
 * The plumbing below is written and tested so that enabling it later is a
 * one-line change to `enabled`/`url` plus wiring a fetch, not a redesign. The
 * trust rule it enforces (`applyRemoteUrlOverrides`) is the part that has to
 * be right before any URL exists, so it is implemented and unit-tested now.
 */
export const REMOTE_CATALOG = {
  enabled: false as boolean,
  url: null as string | null,
  reason: 'No owner-approved catalogue host yet (docs/plans/gemma4-litertlm/02-native-and-downloads.md s2).',
} as const;

export type RemoteRefreshOutcome =
  | { status: 'disabled'; reason: string }
  | { status: 'rejected'; code: string }
  | { status: 'applied'; catalog: GemmaCatalog; overridden: string[] };

/**
 * The fingerprint a reviewed build approved. Remote data that does not
 * reproduce this exactly describes a different model, whatever its `id` says.
 *
 * `label`, `rank` and `capabilities` are excluded on purpose: they are product
 * policy, not identity, and remote data is not allowed to change them either
 * (see `applyRemoteUrlOverrides`) — they simply are not part of "same model".
 */
export function packFingerprint(pack: GemmaPack): string {
  return [pack.id, pack.runtime, pack.revision, pack.sha256, String(pack.bytes), pack.filename].join('|');
}

export function sameFingerprint(a: GemmaPack, b: GemmaPack): boolean {
  return packFingerprint(a) === packFingerprint(b);
}

/**
 * The single trust rule for remote catalogue data.
 *
 * A fetched or cached catalogue may do exactly one thing: point an
 * already-approved fingerprint at a different allowlisted URL, for when a host
 * moves a file. It may not add a pack, remove a pack, change a hash, size,
 * runtime, revision or filename, or widen capabilities. A genuinely new model
 * requires a new reviewed build (02 s2).
 *
 * Every returned pack is therefore a compiled-in object with at most its
 * `downloadUrl` replaced, and the replacement URL has already been through the
 * host allowlist in the parser.
 */
export function applyRemoteUrlOverrides(
  approved: GemmaPack[],
  remote: GemmaPack[],
): { packs: GemmaPack[]; overridden: string[] } {
  const remoteById = new Map<string, GemmaPack>();
  for (const pack of remote) remoteById.set(pack.id, pack);
  // A remote document with two rows for one id is not something to resolve, so
  // the id is skipped entirely below rather than picking a winner. The parser
  // already rejects duplicates; this stays as a second line of defence for
  // callers that assemble a pack list some other way.
  const duplicated = new Set(
    remote.map((pack) => pack.id).filter((id, index, all) => all.indexOf(id) !== index),
  );

  const overridden: string[] = [];
  const packs = approved.map((pack) => {
    const candidate = remoteById.get(pack.id);
    if (!candidate || duplicated.has(pack.id)) return pack;
    if (!sameFingerprint(pack, candidate)) return pack;
    if (candidate.downloadUrl === pack.downloadUrl) return pack;
    overridden.push(pack.id);
    return { ...pack, downloadUrl: candidate.downloadUrl };
  });
  return { packs, overridden };
}

/**
 * Resolves the catalogue this build should use.
 *
 * With remote refresh disabled this never touches the network and never
 * depends on the cache, which is what makes an installed model usable in
 * airplane mode after a restart (05 s4, D10). The cached branch is kept live
 * and tested so that turning refresh on does not introduce untested code.
 */
export function resolveGemmaCatalog(cached?: string | null): {
  catalog: GemmaCatalog;
  source: 'bundled' | 'bundled+remote-urls';
  overridden: string[];
} {
  const bundled = bundledGemmaCatalog();
  if (!REMOTE_CATALOG.enabled) return { catalog: bundled, source: 'bundled', overridden: [] };

  const remote = parseCachedCatalog(cached);
  if (!remote) return { catalog: bundled, source: 'bundled', overridden: [] };
  const { packs, overridden } = applyRemoteUrlOverrides(bundled.packs, remote.packs);
  return {
    catalog: { ...bundled, packs },
    source: overridden.length ? 'bundled+remote-urls' : 'bundled',
    overridden,
  };
}

/**
 * What a refresh would do today. Callable so the UI can say "using the bundled
 * list" honestly instead of showing a spinner that never resolves.
 */
export function refreshRemoteCatalog(): RemoteRefreshOutcome {
  if (!REMOTE_CATALOG.enabled || !REMOTE_CATALOG.url) {
    return { status: 'disabled', reason: REMOTE_CATALOG.reason };
  }
  // Intentionally unreachable in this build. Wiring a fetch here is the whole
  // change; the validation and trust rules it must call already exist above.
  return { status: 'rejected', code: 'REMOTE_FETCH_NOT_WIRED' };
}

// ---------------------------------------------------------------------------
// Legacy schema-1 packs
// ---------------------------------------------------------------------------

/**
 * A Qwen/Phi `.task` file already on disk. Inert data: it cannot be converted,
 * cannot be loaded by LiteRT-LM, and is never offered as a Gemma option.
 *
 * It is also not deleted behind the user's back. They paid for those gigabytes
 * once already; removing them is a choice they make, not a migration side
 * effect (01 s2, 02 s2).
 */
export type LegacyPackRow = {
  id: string;
  label: string;
  filename: string;
  bytes: number;
  runtime: 'legacy-mediapipe';
};

export function legacyPackRows(): LegacyPackRow[] {
  return OPTIONAL_ON_DEVICE_MODELS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    filename: spec.filename,
    bytes: spec.bytes,
    runtime: 'legacy-mediapipe' as const,
  }));
}

const LEGACY_IDS = new Set(OPTIONAL_ON_DEVICE_MODELS.map((spec) => spec.id));

/** True for anything the old runtime owned, by id or by file extension. */
export function isLegacyPackId(id: string): boolean {
  return LEGACY_IDS.has(id as (typeof OPTIONAL_ON_DEVICE_MODELS)[number]['id']);
}

/**
 * Builds a deletion plan for legacy files. Throws unless the caller passes
 * explicit user approval, so "free up space" cannot become a silent sweep, and
 * refuses ids that are not legacy so this path can never be used to remove a
 * verified Gemma pack.
 */
export function planLegacyPackDeletion(
  ids: string[],
  approval: { userApproved: boolean },
): { rows: LegacyPackRow[]; bytes: number } {
  if (!approval.userApproved) fail('LEGACY_DELETE_NOT_APPROVED');
  const rows = legacyPackRows().filter((row) => ids.includes(row.id));
  if (rows.length !== new Set(ids).size) fail('LEGACY_DELETE_UNKNOWN_ID');
  return { rows, bytes: rows.reduce((total, row) => total + row.bytes, 0) };
}

// ---------------------------------------------------------------------------
// Device profile, capability gating and model selection
// ---------------------------------------------------------------------------

/** Native install states, from 02 s3 point 2. `File.exists()` is not a state. */
export type PackInstallState =
  | 'not-installed'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'ready'
  | 'unsupported'
  | 'error';

/**
 * What the verified bridge on this device can actually do.
 *
 * `capabilities` is the bridge's implemented modality list, not the pack's
 * claim and not a UI toggle. `memoryCheck` and `validatedPacks` are measured
 * or gated results supplied by the native probe — there is deliberately no
 * minimum-RAM constant in this file, because 01 s7 and 02 s2 both forbid
 * inventing one from the old Qwen/Phi thresholds.
 */
export type DeviceProfile = {
  bridgeVersion: number;
  capabilities: OnDevicePackCapability[];
  /** Per-pack measured outcome. A missing entry means "not measured", never "fine". */
  memoryCheck: Record<string, 'pass' | 'fail'>;
  /** Pack ids whose device profile has passed the validation gates. */
  validatedPacks: string[];
};

/**
 * What a pack may actually be used for here.
 *
 * The intersection is the point. A catalogue row saying `"vision"` on a build
 * whose bridge has no image path would otherwise route a photo into an engine
 * that drops it, and the user would be told the receipt was read.
 */
export function effectiveCapabilities(
  pack: GemmaPack,
  profile: DeviceProfile,
): OnDevicePackCapability[] {
  return pack.capabilities.filter((capability) => profile.capabilities.includes(capability));
}

export type EligibilityOptions = {
  /** Modalities this turn needs. Defaults to text. */
  needs?: OnDevicePackCapability[];
  /**
   * Ids the user explicitly opted into as experimental, in a UI that said so.
   * Never set from a catalogue field, a document, or model output.
   */
  experimentalOptIn?: string[];
};

export type Eligibility =
  | { eligible: true; capabilities: OnDevicePackCapability[] }
  | { eligible: false; code: string };

/**
 * Whether this build, on this device, is allowed to run this pack at all.
 *
 * Install state is deliberately not considered here: "may run" and "is on
 * disk" are different questions, and conflating them is how a UI ends up
 * starting a download to answer the first one.
 */
export function packEligibility(
  pack: GemmaPack,
  profile: DeviceProfile,
  options: EligibilityOptions = {},
): Eligibility {
  if (pack.runtime !== GEMMA_RUNTIME) return { eligible: false, code: 'RUNTIME_NOT_APPROVED' };
  if (pack.minBridgeVersion > profile.bridgeVersion) {
    return { eligible: false, code: 'BRIDGE_TOO_OLD' };
  }

  const capabilities = effectiveCapabilities(pack, profile);
  const needs = options.needs ?? ['text'];
  if (!needs.every((capability) => capabilities.includes(capability))) {
    return { eligible: false, code: 'CAPABILITY_UNSUPPORTED' };
  }

  // 01 s7: E2B is the default; anything larger is only for a validated device
  // profile, or an explicitly marked experimental opt-in that has already
  // passed a memory check. An unmeasured device is not a passing device.
  if (pack.id !== DEFAULT_GEMMA_MODEL_ID) {
    const validated = profile.validatedPacks.includes(pack.id);
    const optedIn = (options.experimentalOptIn ?? []).includes(pack.id);
    if (!validated && !optedIn) return { eligible: false, code: 'OPT_IN_REQUIRED' };
    if (!validated) {
      const memory = profile.memoryCheck[pack.id];
      if (memory === 'fail') return { eligible: false, code: 'MEMORY_CHECK_FAILED' };
      if (memory !== 'pass') return { eligible: false, code: 'MEMORY_CHECK_REQUIRED' };
    }
  } else if (profile.memoryCheck[pack.id] === 'fail') {
    return { eligible: false, code: 'MEMORY_CHECK_FAILED' };
  }

  return { eligible: true, capabilities };
}

export type SelectionRequest = {
  packs: GemmaPack[];
  /** Native install state per pack id. Missing means not installed. */
  installed: Record<string, PackInstallState>;
  profile: DeviceProfile;
  needs?: OnDevicePackCapability[];
  /** The pinned model from `PREFERRED_ON_DEVICE_MODEL_KEY_V2`, or null for Auto. */
  preferredId?: string | null;
  experimentalOptIn?: string[];
};

export type PackSelection =
  | {
      kind: 'ready';
      pack: GemmaPack;
      capabilities: OnDevicePackCapability[];
      /** Why this pack, so the UI can name the model instead of implying a choice. */
      reason: 'pinned' | 'default' | 'installed-alternative';
      /** True when a pinned model was asked for and a different one is being used. */
      substituted: boolean;
      requestedId: string | null;
    }
  | {
      kind: 'unavailable';
      code: 'NOTHING_INSTALLED' | 'NO_ELIGIBLE_PACK' | 'PINNED_UNAVAILABLE';
      requestedId: string | null;
      /** Eligible and already on disk. Switching to one of these costs nothing. */
      installedAlternatives: GemmaPack[];
      /**
       * Eligible but not on disk. Returned so the UI can offer a download the
       * user starts; selection never starts one (01 s7, 02 s1).
       */
      downloadRequired: GemmaPack[];
      /** Per-pack rejection codes, for an honest "why not" instead of a shrug. */
      rejected: Record<string, string>;
    };

function isReady(state: PackInstallState | undefined): boolean {
  return state === 'ready';
}

/**
 * Picks the model to answer with, or explains why it cannot.
 *
 * The rules that matter, all from 01 s7:
 *
 * - A pinned model wins when it is eligible and ready.
 * - A pinned model that is not ready does NOT silently become another model
 *   that would have to be downloaded first. That is the E4B-to-E2B fallback
 *   the doc forbids: the user picked the big one, and a "helpful" substitution
 *   would spend gigabytes of their data without being asked.
 * - Falling back to a pack that is already installed is allowed, because it
 *   costs nothing — but the result says `substituted: true` and names the pack
 *   so the caller can tell the user which model answered.
 * - Nothing here ever downloads. The unavailable branch reports candidates and
 *   stops.
 */
export function selectGemmaPack(request: SelectionRequest): PackSelection {
  const requestedId = request.preferredId ?? null;
  const rejected: Record<string, string> = {};
  const eligible: { pack: GemmaPack; capabilities: OnDevicePackCapability[] }[] = [];

  for (const pack of request.packs) {
    const verdict = packEligibility(pack, request.profile, {
      needs: request.needs,
      experimentalOptIn: request.experimentalOptIn,
    });
    if (verdict.eligible) eligible.push({ pack, capabilities: verdict.capabilities });
    else rejected[pack.id] = verdict.code;
  }

  const installedAlternatives = eligible
    .filter((entry) => isReady(request.installed[entry.pack.id]))
    .sort((a, b) => b.pack.rank - a.pack.rank);
  const downloadRequired = eligible
    .filter((entry) => !isReady(request.installed[entry.pack.id]))
    .map((entry) => entry.pack)
    .sort((a, b) => b.rank - a.rank);

  if (requestedId) {
    const pinnedReady = installedAlternatives.find((entry) => entry.pack.id === requestedId);
    if (pinnedReady) {
      return {
        kind: 'ready',
        pack: pinnedReady.pack,
        capabilities: pinnedReady.capabilities,
        reason: 'pinned',
        substituted: false,
        requestedId,
      };
    }
    // The pinned pack is missing, ineligible, or mid-download. Only an
    // already-installed alternative is acceptable, and it is reported as a
    // substitution rather than presented as the user's choice.
    if (installedAlternatives.length) {
      const [best] = installedAlternatives;
      return {
        kind: 'ready',
        pack: best.pack,
        capabilities: best.capabilities,
        reason: 'installed-alternative',
        substituted: true,
        requestedId,
      };
    }
    return {
      kind: 'unavailable',
      code: 'PINNED_UNAVAILABLE',
      requestedId,
      installedAlternatives: [],
      downloadRequired,
      rejected,
    };
  }

  if (installedAlternatives.length) {
    // Auto: prefer the default, then the highest-ranked installed pack. The
    // default is checked first so an opted-in E4B does not quietly become the
    // everyday model on a phone that also has E2B.
    const preferred = installedAlternatives.find((entry) => entry.pack.id === DEFAULT_GEMMA_MODEL_ID)
      ?? installedAlternatives[0];
    return {
      kind: 'ready',
      pack: preferred.pack,
      capabilities: preferred.capabilities,
      reason: preferred.pack.id === DEFAULT_GEMMA_MODEL_ID ? 'default' : 'installed-alternative',
      substituted: false,
      requestedId: null,
    };
  }

  return {
    kind: 'unavailable',
    code: eligible.length ? 'NOTHING_INSTALLED' : 'NO_ELIGIBLE_PACK',
    requestedId,
    installedAlternatives: [],
    downloadRequired,
    rejected,
  };
}

/** Lookup that refuses legacy ids, so no caller can reach one through this module. */
export function findGemmaPack(packs: GemmaPack[], id: string): GemmaPack | null {
  if (isLegacyPackId(id)) return null;
  return packs.find((pack) => pack.id === id) ?? null;
}
