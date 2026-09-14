# Codex on-device — independent audit and fixes

> **Current build update (2026-09-12):** the Android SDK/Kotlin/Gradle/APK items
> described below as pending have since been completed in this isolated lab.
> See [INTEGRATION_PROGRESS.md](INTEGRATION_PROGRESS.md) for current build
> evidence. Phone/model runtime validation remains pending; the original audit
> text is retained as historical evidence of the gaps found at audit time.

> Historical audit snapshot. The current source of truth is
> [INTEGRATION_PROGRESS.md](INTEGRATION_PROGRESS.md); the live adapters, durable
> action port, media routes, and coverage allowlist described as missing below
> have since been implemented and verified.

Branch: `codex/gemma4-p0-p3`
Baseline: `badb3c738abda0ac70c875c44ccdbe078dcf02c2`

## Result

The other AI added substantial tested components, but its completion labels
overstated end-to-end readiness. P4 has no live branchPorts adapter and P5 has
no real action adapter. P2/P3 were not protected by an actual native build gate:
the module imported LiteRT classes from main while its dependency was commented
out, so the default native source tree had unresolved references.

## Repairs in this audit

- Moved the experimental bridge and Gemma classes to android/src/gemma/java.
  Preserved this branch's original Needle/MediaPipe bridge in src/legacy/java
  and confirmed it matches the original source, ignoring line endings.
  The ledgrGemmaEnabled property defaults off and selects the bridge and
  SDK dependency together. A source-configuration regression guards this.
- Fixed simultaneous proposal confirmations, cross-scope applied-result replay,
  expiry during async checks, weak preview digest and reset retention.
- Passed the transaction's SqlRunner to the domain port and joined the existing
  global sync mutation lock; nested-savepoint availability alone was insufficient.
- Added independent schema validation to direct proposal preparation and checked
  balance-sheet reconciliation against its actual figures.
- Bounded the whole agent turn, including permission checks, and native cleanup.
  Cleanup timeout returns NATIVE_RECOVERY_REQUIRED and keeps admission closed.
- Preserved cancellation before lazy host creation, rejected queued work after
  shutdown, and deferred attachment cleanup until after native close. These
  Expo bridge changes are source-reviewed, not Android-compiled.
- Stopped advertising vision/audio through the bridge before a normalizer exists.
  Native attachment handles now reject reuse, invalid TTL and files enlarged
  after staging. The JVM attachment contract executes these regressions.

## Current validation

- Full Jest: **129 suites / 1009 tests passed** (previous implementation: 127/990).
- TypeScript and ESLint over the Gemma code/tests and reset integration: passed.
- check-native.mjs: real SDK compilation under -Werror and all four contract
  groups passed, including the new attachment checks.
- verify-isolation.mjs and tracked git diff --check: passed.
- Expo bridge compilation, Gradle/APK and device inference: not run.

## Branch-specific outstanding items

P2 still needs actual bridge download/status/pause/remove operations and Android
workflow wiring; its current checks cover catalog/integrity guards, not a full
HTTP transfer suite equivalent to Manus's loopback harness. P3 still needs an
Android-compiled bridge and device lifecycle validation. P4 needs branchPorts.ts
connected to this branch's reconciled reports and scoped repository queries.
P5's sixteen-operation domain adapter remains unimplemented. Its coverage
register describes available components, not live access to all app features.

The original module path now appears deleted in Git because its two preserved
variants live in src/legacy and src/gemma. Neither the trained weights nor the
Needle CMake implementation were removed.

## Scope and evidence

Reviewed the two independent lab clones separately on 2026-09-08. Shared
confirmation infrastructure was adapted into separate files; neither source
branch was merged into the other. Main, Ledger-Ai and the original on-device
checkouts received no edits from this audit. No commit or push was made.
The isolation checks passed in both labs: separate Git repositories, no remotes,
zero commits since their baselines, and unchanged Needle model SHA-256
`24982abc3ed97b36192a16b0ea2758698c1a300853c01ab69e9decb3852d140f`.

The device/model test was deferred by the owner. No full model was downloaded,
no APK was built, and no Gemma inference was run. A standard Android SDK was
not found and adb was unavailable on PATH. Published-model license/download
claims in the previous reports were not independently rechecked online in this
audit; the native download check described below uses small loopback fixtures.

## Confirmation boundary now implemented

Both labs have a durable proposal store and confirmation executor. They serialize
confirmation transactions with the existing global sync mutation lock, reload
state after admission, pass the same SqlRunner to the apply port, and use a
savepoint for the domain effect and applied receipt. The preview digest now uses
SHA-256. Confirmation rechecks scope, permissions, entity revisions, period and
expiry; a replay stays within the same book/actor/location/permission boundary
but tolerates the data revision advanced by the original post.

Tests cover simultaneous confirmations, a concurrent sync mutation, rollback,
tampering, replay isolation, and proposal deletion during book deletion,
accounting reset and factory reset. Reset tests use temporary SQLite databases,
not the owner's accounting data.

This proves infrastructure, not the complete live posting path. The real apply
adapter must use the supplied runner and lock-aware sync helpers such as
withSyncOperationLocked/enqueueSyncOperation. Calling a public api.* method that
reacquires the global lock can deadlock. Domain changes and the sync outbox must
remain inside the same outer savepoint. The screen's current applyAction switch
has not been extracted or connected. Before doing so, characterize each branch's
actual cases, entity resolution, idempotency and rollback behavior.

## Remaining work shared by both products

1. Validate a Kotlin/AGP/D8/R8 combination with Expo, React Native and Needle.
   The current SDK metadata/compiler mismatch is still unresolved for an
   enabled Gemma Android build. Host compilation does not validate the Expo
   bridge, Android org.json behavior, R8, ABI packaging or GPU loading.
2. Connect the download core to real native operations, persisted progress and
   foreground/background lifecycle. Run interruption, redirect, disk-full and
   process-death checks on Android. A passing catalog test is not a working
   in-app download button.
3. Run P1 on a physical phone with the approved E2B weights: text, a manual
   tool-result round trip, image input and audio input. Record device/RAM,
   backend, timing and artifact hash. This remains explicitly deferred.
4. Finish scoped live read/query and action adapters, including actual fixture
   books and the branch-specific permission source. Add book-switch, lock,
   logout, restore and settings/model-switch lifecycle hooks before wiring UI.
5. Implement image/PDF/audio normalization, reviewed scan/transcription flows
   and offline TTS selection. Test media reaches the real encoder. The current
   parser and attachment helpers do not constitute complete multimodal support.
6. Connect Ask and Settings behind the experimental gate and complete P8.
   Prevent Gemma and the legacy multi-GB engine from being resident together,
   schedule idle expiry/recovery, and validate all teardown paths on device.
   Do not retire existing downloads or claim complete feature automation yet.

## Reproduction

From this lab's frontend directory:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/accountingV2/gemma src/accountingV2/resetBook.ts src/utils/gemmaNative.ts "__tests__/gemma*.test.ts" --no-cache --max-warnings 0
node node_modules/jest/bin/jest.js --runInBand --no-cache --json --outputFile ../spikes/gemma4/build/audit-tests.json
```

The word gemma alone matches every test's absolute path because this checkout
itself is named gemma4-lab/gemma4-manus-lab. For focused runs use
`--runTestsByPath __tests__/gemmaConfirmationPersistence.test.ts`, not a bare
`gemma` pattern.

From this lab's root, set GEMMA_JDK to the full JDK and run the native scripts.
verify-isolation.mjs may need permission to spawn Git outside the sandbox;
its checks are read-only.
