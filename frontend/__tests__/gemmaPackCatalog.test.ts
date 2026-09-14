import {
  parseGemmaPackRow, parseGemmaCatalog, tryParseGemmaCatalog, parseCachedCatalog,
  serializeCatalogForCache, bundledGemmaCatalog, bundledGemmaPacks, resolveGemmaCatalog,
  applyRemoteUrlOverrides, refreshRemoteCatalog, packFingerprint, sameFingerprint,
  effectiveCapabilities, packEligibility, selectGemmaPack, findGemmaPack,
  legacyPackRows, isLegacyPackId, planLegacyPackDeletion,
  PackCatalogError, REMOTE_CATALOG, GEMMA_PACK_SCHEMA, GEMMA_RUNTIME,
  DEFAULT_GEMMA_MODEL_ID, APP_BRIDGE_VERSION,
  PACK_MANIFEST_CACHE_KEY_V2, PREFERRED_ON_DEVICE_MODEL_KEY_V2,
  type GemmaPack, type DeviceProfile, type PackInstallState,
} from '../src/accountingV2/gemma/packCatalog';
import { OPTIONAL_ON_DEVICE_MODELS } from '../src/accountingV2/onDeviceTools';
import * as fs from 'fs';
import * as path from 'path';

const e2b = () => bundledGemmaPacks().find((p) => p.id === 'gemma4-e2b')!;
const e4b = () => bundledGemmaPacks().find((p) => p.id === 'gemma4-e4b')!;

/** A device whose bridge implements everything and has measured both packs. */
function fullProfile(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    bridgeVersion: APP_BRIDGE_VERSION,
    capabilities: ['text', 'tools', 'vision', 'audio'],
    memoryCheck: { 'gemma4-e2b': 'pass', 'gemma4-e4b': 'pass' },
    validatedPacks: [],
    ...overrides,
  };
}

function code(run: () => unknown): string {
  try { run(); } catch (error) {
    if (error instanceof PackCatalogError) return error.code;
    return `UNEXPECTED:${String(error)}`;
  }
  return 'NO_ERROR';
}

// ---------------------------------------------------------------------------
// The bundled catalogue
// ---------------------------------------------------------------------------

test('the bundled catalogue parses through the same parser as untrusted data', () => {
  const catalog = bundledGemmaCatalog();
  expect(catalog.schema).toBe(GEMMA_PACK_SCHEMA);
  expect(catalog.packs.map((p) => p.id)).toEqual(['gemma4-e2b', 'gemma4-e4b']);
  for (const pack of catalog.packs) {
    expect(pack.runtime).toBe(GEMMA_RUNTIME);
    expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pack.bytes).toBeGreaterThan(0);
    // Still experimental until the device gates in doc 05 s4 pass.
    expect(pack.experimental).toBe(true);
  }
});

test('the bundled artefacts match the reviewed pinned fingerprints', () => {
  // These are the hashes and sizes verified against Hugging Face. If a rebuild
  // changes them, that is a new model and needs a new review, not a passing test.
  expect(packFingerprint(e2b())).toBe([
    'gemma4-e2b', 'litert-lm', 'b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1',
    '181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c',
    '2588147712', 'gemma4-e2b-181938105e0eefd1.litertlm',
  ].join('|'));
  expect(e4b().bytes).toBe(3659530240);
  expect(e4b().sha256).toBe('0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0');
});

// ---------------------------------------------------------------------------
// D8: legacy schema and legacy packs are never offered to the new runtime
// ---------------------------------------------------------------------------

test('D8: a schema-1 manifest is rejected outright', () => {
  const schemaOne = {
    schema: 1,
    packs: [{ id: 'qwen25-0-5b', filename: 'q.task', downloadUrl: 'https://huggingface.co/x/y', capabilities: ['text'] }],
  };
  expect(code(() => parseGemmaCatalog(schemaOne))).toBe('CATALOG_SCHEMA_MISMATCH');
  expect(tryParseGemmaCatalog(schemaOne)).toBeNull();
});

test('D8: legacy Qwen and Phi packs are inert legacy data, not runnable packs', () => {
  const legacy = legacyPackRows();
  expect(legacy.length).toBe(OPTIONAL_ON_DEVICE_MODELS.length);
  for (const row of legacy) {
    expect(row.runtime).toBe('legacy-mediapipe');
    expect(isLegacyPackId(row.id)).toBe(true);
    // A legacy id can never resolve to something the LiteRT-LM runtime loads.
    expect(findGemmaPack(bundledGemmaPacks(), row.id)).toBeNull();
  }
  expect(isLegacyPackId('gemma4-e2b')).toBe(false);
});

test('D8: legacy files are never deleted silently, and only legacy ids can be deleted', () => {
  const ids = legacyPackRows().map((r) => r.id);
  expect(code(() => planLegacyPackDeletion(ids, { userApproved: false }))).toBe('LEGACY_DELETE_NOT_APPROVED');
  const plan = planLegacyPackDeletion(ids, { userApproved: true });
  expect(plan.rows).toHaveLength(ids.length);
  expect(plan.bytes).toBeGreaterThan(0);
  // This path must never become a way to remove a verified Gemma pack.
  expect(code(() => planLegacyPackDeletion(['gemma4-e2b'], { userApproved: true }))).toBe('LEGACY_DELETE_UNKNOWN_ID');
});

// ---------------------------------------------------------------------------
// D9: manifest tampering
// ---------------------------------------------------------------------------

describe('D9: a tampered catalogue row is rejected', () => {
  const base = () => JSON.parse(JSON.stringify(e2b())) as Record<string, unknown>;

  const cases: [string, Record<string, unknown>][] = [
    ['bad sha256', { sha256: 'deadbeef' }],
    ['sha256 wrong length', { sha256: 'a'.repeat(63) }],
    ['uppercase sha256', { sha256: '181938105E0EEFD105961417E8DA75903EACDA102C4FCE9CE90F50B97139A63C' }],
    ['bad revision', { revision: 'not-a-commit' }],
    ['zero bytes', { bytes: 0 }],
    ['negative bytes', { bytes: -1 }],
    ['non-integer bytes', { bytes: 1.5 }],
    ['absurd bytes', { bytes: 64 * 1024 * 1024 * 1024 }],
    ['wrong runtime', { runtime: 'mediapipe' }],
    ['filename with a path separator', { filename: '../../evil.litertlm' }],
    ['filename with a subdirectory', { filename: 'a/b.litertlm' }],
    ['filename with a backslash', { filename: 'a\\b.litertlm' }],
    ['wrong file extension', { filename: 'gemma4-e2b.task' }],
    ['http url', { downloadUrl: 'http://huggingface.co/a/b' }],
    ['unallowlisted host', { downloadUrl: 'https://evil.example.com/gemma-4-E2B-it.litertlm' }],
    ['host that merely contains the allowed name', { downloadUrl: 'https://huggingface.co.evil.com/a' }],
    ['url with credentials', { downloadUrl: 'https://user:pass@huggingface.co/a/b' }],
    ['missing capabilities', { capabilities: [] }],
    ['unknown capability', { capabilities: ['text', 'root'] }],
    ['missing bridge version', { minBridgeVersion: undefined }],
    ['missing license', { license: '' }],
  ];

  for (const [name, patch] of cases) {
    test(name, () => {
      const row = { ...base(), ...patch };
      if (patch.minBridgeVersion === undefined) delete row.minBridgeVersion;
      expect(code(() => parseGemmaPackRow(row))).not.toBe('NO_ERROR');
    });
  }

  test('a row missing any required field at all', () => {
    for (const field of Object.keys(base())) {
      const row = base();
      delete row[field];
      expect(code(() => parseGemmaPackRow(row))).not.toBe('NO_ERROR');
    }
  });

  test('duplicate ids make selection non-deterministic and are refused', () => {
    const catalog = { schema: 2, catalogVersion: 1, packs: [e2b(), e2b()] };
    expect(code(() => parseGemmaCatalog(catalog))).toBe('CATALOG_DUPLICATE_ID');
  });

  test('a non-object row, a non-array packs list and a non-object document', () => {
    expect(code(() => parseGemmaPackRow(null))).not.toBe('NO_ERROR');
    expect(code(() => parseGemmaPackRow([]))).not.toBe('NO_ERROR');
    expect(code(() => parseGemmaCatalog({ schema: 2, catalogVersion: 1, packs: {} }))).not.toBe('NO_ERROR');
    expect(code(() => parseGemmaCatalog(null))).not.toBe('NO_ERROR');
  });
});

test('D9: remote data may repoint a URL but never change what the model is', () => {
  const approved = bundledGemmaPacks();
  const mirrored: GemmaPack = { ...e2b(), downloadUrl: 'https://hf.co/mirror/gemma-4-E2B-it.litertlm' };

  // Same fingerprint, different URL: allowed, and reported.
  const ok = applyRemoteUrlOverrides(approved, [mirrored]);
  expect(ok.overridden).toEqual(['gemma4-e2b']);
  expect(findGemmaPack(ok.packs, 'gemma4-e2b')!.downloadUrl).toBe(mirrored.downloadUrl);

  // Any change to identity means it is a different model, so nothing is taken.
  for (const patch of [
    { sha256: 'b'.repeat(64) },
    { bytes: 123456 },
    { revision: 'c'.repeat(40) },
    { filename: 'gemma4-e2b-other.litertlm' },
    { runtime: 'litert-lm' as const, id: 'gemma4-e2b' },
  ]) {
    const tampered: GemmaPack = { ...mirrored, ...patch };
    const result = applyRemoteUrlOverrides(approved, [tampered]);
    const resolved = findGemmaPack(result.packs, 'gemma4-e2b')!;
    if (sameFingerprint(e2b(), tampered)) continue;
    expect(result.overridden).toEqual([]);
    expect(resolved.downloadUrl).toBe(e2b().downloadUrl);
    expect(resolved.sha256).toBe(e2b().sha256);
    expect(resolved.bytes).toBe(e2b().bytes);
  }

  // A remote id the build never approved cannot introduce a new pack.
  const injected = applyRemoteUrlOverrides(approved, [{ ...e2b(), id: 'gemma4-e9b' }]);
  expect(injected.packs.map((p) => p.id)).toEqual(approved.map((p) => p.id));
});

test('D9: cached catalogue JSON goes through the same parser, never a cast', () => {
  const good = serializeCatalogForCache(bundledGemmaCatalog());
  expect(parseCachedCatalog(good)!.packs).toHaveLength(2);
  expect(parseCachedCatalog(null)).toBeNull();
  expect(parseCachedCatalog('')).toBeNull();
  expect(parseCachedCatalog('not json')).toBeNull();
  expect(parseCachedCatalog('{"schema":1,"packs":[]}')).toBeNull();
  const tampered = good.replace(e2b().sha256, 'f'.repeat(64));
  // Still parses (it is well-formed), but the fingerprint rule below refuses it.
  const parsed = parseCachedCatalog(tampered);
  if (parsed) {
    const applied = applyRemoteUrlOverrides(bundledGemmaPacks(), parsed.packs);
    expect(applied.overridden).toEqual([]);
  }
});

test('the versioned storage keys are separate from the schema-1 ones', () => {
  expect(PACK_MANIFEST_CACHE_KEY_V2).toBe('ledgr_pack_manifest_cache_v2');
  expect(PREFERRED_ON_DEVICE_MODEL_KEY_V2).toBe('ledgr_preferred_on_device_model_v2');
});

// ---------------------------------------------------------------------------
// D10: airplane mode — no catalogue fetch dependency
// ---------------------------------------------------------------------------

test('D10: remote refresh is disabled and resolution never needs the network or cache', () => {
  expect(REMOTE_CATALOG.enabled).toBe(false);
  expect(REMOTE_CATALOG.url).toBeNull();
  expect(refreshRemoteCatalog().status).toBe('disabled');

  const offline = resolveGemmaCatalog(null);
  expect(offline.source).toBe('bundled');
  expect(offline.catalog.packs).toHaveLength(2);
  // A corrupt cache cannot take the catalogue away from an offline user.
  expect(resolveGemmaCatalog('garbage').catalog.packs).toHaveLength(2);
});

test('D10: a verified installed model stays selectable with no catalogue fetch', () => {
  const selection = selectGemmaPack({
    packs: resolveGemmaCatalog(null).catalog.packs,
    installed: { 'gemma4-e2b': 'ready' },
    profile: fullProfile(),
  });
  expect(selection.kind).toBe('ready');
  if (selection.kind === 'ready') expect(selection.pack.id).toBe('gemma4-e2b');
});

// ---------------------------------------------------------------------------
// Capability intersection
// ---------------------------------------------------------------------------

test('a declared capability does not enable a modality the bridge lacks', () => {
  const textOnlyBridge = fullProfile({ capabilities: ['text', 'tools'] });
  expect(e2b().capabilities).toContain('vision');
  expect(effectiveCapabilities(e2b(), textOnlyBridge)).toEqual(['text', 'tools']);

  const verdict = packEligibility(e2b(), textOnlyBridge, { needs: ['vision'] });
  expect(verdict).toEqual({ eligible: false, code: 'CAPABILITY_UNSUPPORTED' });

  // And a vision request cannot be answered by picking the pack anyway.
  const selection = selectGemmaPack({
    packs: bundledGemmaPacks(), installed: { 'gemma4-e2b': 'ready' },
    profile: textOnlyBridge, needs: ['vision'],
  });
  expect(selection.kind).toBe('unavailable');
});

test('an older native bridge is refused rather than handed a newer protocol', () => {
  const old = fullProfile({ bridgeVersion: 1 });
  expect(packEligibility(e2b(), old)).toEqual({ eligible: false, code: 'BRIDGE_TOO_OLD' });
});

// ---------------------------------------------------------------------------
// M10: honest selection, no surprise downloads
// ---------------------------------------------------------------------------

test('M10: nothing installed reports what could be downloaded but starts nothing', () => {
  const selection = selectGemmaPack({
    packs: bundledGemmaPacks(), installed: {}, profile: fullProfile(),
  });
  expect(selection.kind).toBe('unavailable');
  if (selection.kind === 'unavailable') {
    expect(selection.code).toBe('NOTHING_INSTALLED');
    expect(selection.downloadRequired.map((p) => p.id)).toContain('gemma4-e2b');
    expect(selection.installedAlternatives).toEqual([]);
  }
});

test('M10: E2B is the default when both packs are ready', () => {
  const selection = selectGemmaPack({
    packs: bundledGemmaPacks(),
    installed: { 'gemma4-e2b': 'ready', 'gemma4-e4b': 'ready' },
    profile: fullProfile({ validatedPacks: ['gemma4-e4b'] }),
  });
  expect(selection.kind).toBe('ready');
  if (selection.kind === 'ready') {
    expect(selection.pack.id).toBe(DEFAULT_GEMMA_MODEL_ID);
    expect(selection.reason).toBe('default');
    expect(selection.substituted).toBe(false);
  }
});

test('M10: a pinned, eligible, ready model wins and is named', () => {
  const selection = selectGemmaPack({
    packs: bundledGemmaPacks(),
    installed: { 'gemma4-e2b': 'ready', 'gemma4-e4b': 'ready' },
    profile: fullProfile({ validatedPacks: ['gemma4-e4b'] }),
    preferredId: 'gemma4-e4b',
  });
  expect(selection.kind).toBe('ready');
  if (selection.kind === 'ready') {
    expect(selection.pack.id).toBe('gemma4-e4b');
    expect(selection.reason).toBe('pinned');
    expect(selection.substituted).toBe(false);
  }
});

test('M10: a pinned model that is not installed never silently downloads another', () => {
  const selection = selectGemmaPack({
    packs: bundledGemmaPacks(),
    installed: {},
    profile: fullProfile({ validatedPacks: ['gemma4-e4b'] }),
    preferredId: 'gemma4-e4b',
  });
  // The forbidden behaviour is spending gigabytes of the user's data to
  // substitute a model they did not choose.
  expect(selection.kind).toBe('unavailable');
  if (selection.kind === 'unavailable') {
    expect(selection.requestedId).toBe('gemma4-e4b');
    expect(selection.installedAlternatives).toEqual([]);
  }
});

test('M10: falling back to an already-installed pack is allowed but declared', () => {
  const selection = selectGemmaPack({
    packs: bundledGemmaPacks(),
    installed: { 'gemma4-e2b': 'ready' },
    profile: fullProfile({ validatedPacks: ['gemma4-e4b'] }),
    preferredId: 'gemma4-e4b',
  });
  expect(selection.kind).toBe('ready');
  if (selection.kind === 'ready') {
    expect(selection.pack.id).toBe('gemma4-e2b');
    expect(selection.substituted).toBe(true);
    expect(selection.requestedId).toBe('gemma4-e4b');
    expect(selection.reason).toBe('installed-alternative');
  }
});

test('M10: a partially installed pack is not a usable pack', () => {
  const states: PackInstallState[] = ['not-installed', 'downloading', 'paused', 'verifying', 'unsupported', 'error'];
  for (const state of states) {
    const selection = selectGemmaPack({
      packs: bundledGemmaPacks(), installed: { 'gemma4-e2b': state }, profile: fullProfile(),
    });
    expect(selection.kind).toBe('unavailable');
  }
  expect(selectGemmaPack({
    packs: bundledGemmaPacks(), installed: { 'gemma4-e2b': 'ready' }, profile: fullProfile(),
  }).kind).toBe('ready');
});

test('M10: E4B needs an explicit opt-in and a passed memory check', () => {
  const unmeasured = fullProfile({ memoryCheck: {} });
  // An unmeasured device is not a passing device.
  expect(packEligibility(e4b(), unmeasured, { experimentalOptIn: ['gemma4-e4b'] }))
    .toEqual({ eligible: false, code: 'MEMORY_CHECK_REQUIRED' });
  expect(packEligibility(e4b(), unmeasured)).toEqual({ eligible: false, code: 'OPT_IN_REQUIRED' });
  expect(packEligibility(e4b(), fullProfile({ memoryCheck: { 'gemma4-e4b': 'fail' } }), { experimentalOptIn: ['gemma4-e4b'] }))
    .toEqual({ eligible: false, code: 'MEMORY_CHECK_FAILED' });
  expect(packEligibility(e4b(), fullProfile(), { experimentalOptIn: ['gemma4-e4b'] }).eligible).toBe(true);
  // A validated device profile does not need the experimental opt-in.
  expect(packEligibility(e4b(), fullProfile({ validatedPacks: ['gemma4-e4b'] })).eligible).toBe(true);
});

test('M10: an ineligible profile explains itself per pack instead of shrugging', () => {
  const selection = selectGemmaPack({
    packs: bundledGemmaPacks(),
    installed: { 'gemma4-e2b': 'ready', 'gemma4-e4b': 'ready' },
    profile: fullProfile({ memoryCheck: { 'gemma4-e2b': 'fail' } }),
  });
  expect(selection.kind).toBe('unavailable');
  if (selection.kind === 'unavailable') {
    expect(selection.code).toBe('NO_ELIGIBLE_PACK');
    expect(selection.rejected['gemma4-e2b']).toBe('MEMORY_CHECK_FAILED');
    expect(selection.rejected['gemma4-e4b']).toBe('OPT_IN_REQUIRED');
  }
});

test('the native asset and the JS catalogue are the same document', () => {
  // Two copies exist because native code must not take a model description
  // from JS (plan 02 s3) while the UI still needs to render the same list.
  // Drift would mean offering a model the downloader refuses, so it is a
  // build-time failure rather than a runtime surprise.
  const shared = path.join(__dirname, '../src/accountingV2/gemma/model-packs-v2.json');
  const asset = path.join(
    __dirname,
    '../modules/ledgr-native-ai/android/src/main/assets/model-packs-v2.json',
  );
  expect(fs.existsSync(asset)).toBe(true);
  const normalise = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  expect(normalise(asset)).toBe(normalise(shared));
});
