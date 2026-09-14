# Phase 5 — A05/A12 and final acceptance

## A05: Needle 16 KB build

Both saved APKs contain a Needle JNI library with 4 KB LOAD alignment; LiteRT's inspected library was 16 KB-aligned. Preserve the Needle model asset and API; repair the native binary, not the model file. Do not remove Needle to get a green artifact check.

In each lab's `frontend/modules/ledgr-native-ai/android/src/main/cpp/CMakeLists.txt`, after `add_library(needle_jni SHARED needle_jni.cpp)`, add:

```cmake
target_link_options(needle_jni PRIVATE
  "-Wl,-z,max-page-size=16384"
  "-Wl,-z,common-page-size=16384"
)
```

With the existing NDK27 setup, also add `"-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON"` alongside `-DANDROID_STL=c++_shared` in the native module build.gradle CMake arguments. Do not replace the pinned NDK with an arbitrary newest version. Regenerate only this lab's generated Android configuration if required; preserve existing edits, never use prebuild --clean casually.

[Official Android guidance](https://developer.android.com/guide/practices/page-sizes) requires checking ELF LOAD alignment and packaging; it also describes RELRO alignment and NDK-specific build options. Check all packaged arm64 libraries, not just Needle. A rebuilt shared library may still need vendor changes if the static library assumes a 4 KB page size internally; host ELF alignment is not a runtime guarantee.

## A12: explicitly opted-in, standalone build

The existing tracked plugin `frontend/plugins/withGemmaAndroidToolchain.js` already conditionally configures Kotlin 2.4.0/KSP 2.3.10 for `-PledgrGemmaEnabled=true`. Default remains Kotlin2.1.20. Keep it, with its tests. Never use skip-metadata-version-check. Do not claim this earlier conflict is still unresolved merely because old plan paragraphs describe it.

Build one lab at a time. From its frontend directory, inspect changes and run non-clean prebuild if native config was changed:

```powershell
$env:EXPO_OFFLINE = '1'
$env:CI = '1'
node node_modules/expo/bin/cli prebuild --platform android --no-install
if ($LASTEXITCODE -ne 0) { throw 'prebuild failed' }
```

Review generated build files afterwards. Do not commit/push generated files. Use existing local SDK/JDK configuration; verify the executable before build:

```powershell
$auditJdk = 'C:\Program Files\Android\Android Studio\jbr'
& "$auditJdk\bin\java.exe" -version
```

From that lab's `frontend/android` (replace Codex with Manus for the second run):

```powershell
# Release produces bundled JS, unlike the previous Metro-dependent debug APK.
# Existing local release signing may use debug signing: label it test-signed.
& .\gradlew.bat "-Dorg.gradle.java.home=C:\Program Files\Android\Android Studio\jbr" :app:assembleRelease -PledgrGemmaEnabled=true -PreactNativeArchitectures=arm64-v8a --no-daemon
if ($LASTEXITCODE -ne 0) { throw 'Gemma release build failed' }
```

If Gradle's launcher cannot locate Java, set a process-local JAVA_HOME to the verified JDK and restore the old value in finally; never alter global Java settings. Stop and inspect signing configuration before using any production signing credentials. Do not access/publish release secrets. A standalone bundled debug variant is acceptable if release signing cannot safely be used, but implement its bundling through a tracked conditional config plugin and test that prebuild reproduces it. An unbundled debug APK or a separate JS export is not a substitute.

Preserve the Gemma APK into a **new** lab-local artifact path before the default build can overwrite app-release.apk, e.g. `artifacts/audit-fixes/codex-gemma-arm64-standalone-testsigned.apk` and Manus equivalent. Do not overwrite audit baseline APKs. Then build the default variant:

```powershell
& .\gradlew.bat "-Dorg.gradle.java.home=C:\Program Files\Android\Android Studio\jbr" :app:assembleRelease -PledgrGemmaEnabled=false -PreactNativeArchitectures=arm64-v8a --no-daemon
if ($LASTEXITCODE -ne 0) { throw 'Default release build failed' }
```

### Workflow repair

In each lab only, update `.github/workflows/android-native-validation.yml` and the on-device build workflow so Gemma is exercised explicitly. Keep repository/product eligibility explicit; do not enable downloadable models for main or the non-downloadable AI product. Add a dedicated opt-in job or matrix after inspecting current triggers and branch inputs. Proposed Gradle step for an on-device-eligible validation job:

```yaml
strategy:
  fail-fast: false
  matrix:
    gemma: ['false', 'true']
# Keep the existing checkout/setup/install/prebuild steps in this job.
# Existing workflow permissions remain minimal; do not add secrets or publishing.
# Under steps:
# - name: Compile selected on-device runtime
#   working-directory: frontend/android
#   run: ./gradlew :app:assembleRelease -PledgrGemmaEnabled=${{ matrix.gemma }} -PreactNativeArchitectures=arm64-v8a --no-daemon
```

This is a merge fragment, not a complete workflow. Select only eligible on-device branches using the repo's verified branch/input routing; do not guess actual remote names from lab names or user dictation. If routing cannot be inferred safely, make the new job manual/opt-in and document how it is selected, while keeping default jobs unchanged. Add source-contract tests proving the Gemma job includes its property and that defaults remain off. No workflow dispatch or remote push during repair.

## Artifact inspection code

Implement a local read-only verifier; minimum required assertions:

1. Non-empty app JS/Hermes bundle inside APK (`assets/index.android.bundle` or actual configured name), not only external export files.
2. `lib/arm64-v8a/libneedle_jni.so`, the existing Needle model asset, LiteRT JNI and native catalog present in Gemma package; default package contains no LiteRT JNI/classes.
3. Correct distinct package IDs (baseline Codex `com.ahem.ledgrai.codexsol`, Manus `com.ahem.ledgrai`), min/target/ABI, declared native assets, SHA-256 and size recorded.
4. Every arm64 `.so` LOAD alignment >=16384, load offsets compatible, plus RELRO and ZIP alignment checks. Do not assume a good zipalign result proves good ELF alignment.

The following PowerShell read-only ZIP inspection starter does not extract or overwrite files; set $apk to the NEW artifact path and fail if missing:

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$apk = 'C:\Users\just2\Downloads\Ledger AI Codex\gemma4-lab\artifacts\audit-fixes\codex-gemma-arm64-standalone-testsigned.apk'
$archive = [IO.Compression.ZipFile]::OpenRead($apk)
try {
  $entries = @($archive.Entries)
  $bundle = @($entries | Where-Object { $_.FullName -match '^assets/.*\.(bundle|hbc)$' -and $_.Length -gt 0 })
  if ($bundle.Count -eq 0) { throw 'APK has no bundled JavaScript' }
  foreach ($required in @('lib/arm64-v8a/libneedle_jni.so','lib/arm64-v8a/liblitertlm_jni.so','assets/needle2.cact')) {
    if (-not ($entries | Where-Object { $_.FullName -eq $required -and $_.Length -gt 0 })) { throw "Missing $required" }
  }
  $bundle | Select-Object FullName,Length
} finally { $archive.Dispose() }
Get-FileHash -LiteralPath $apk -Algorithm SHA256
& 'C:\Users\just2\AppData\Local\Android\Sdk\build-tools\36.0.0\zipalign.exe' -c -P 16 4 $apk
if ($LASTEXITCODE -ne 0) { throw 'APK ZIP alignment failed' }
& 'C:\Users\just2\AppData\Local\Android\Sdk\build-tools\36.0.0\aapt2.exe' dump badging $apk
if ($LASTEXITCODE -ne 0) { throw 'APK metadata inspection failed' }
```

For ELF checks, safely extract ONLY `.so` entries to a newly created lab-local directory, validating each resolved output path is within it, then invoke installed `llvm-readelf.exe -Wl` on every library. Assert LOAD and RELRO numerically, save output in artifacts/audit-fixes. Use the actual packaged .so, not an intermediate binary from a different variant. Never run recursive cleanup against computed broad paths. Preserve baseline Needle asset hash and compare the new asset bytes independently of the JNI binary, which is expected to change.

## Final commands (each lab independently)

From frontend, after focused tests pass:

```powershell
node node_modules/jest/bin/jest.js --runInBand
if ($LASTEXITCODE -ne 0) { throw 'Jest failed' }
node node_modules/typescript/bin/tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw 'TypeScript failed' }
node node_modules/expo/bin/cli lint --no-cache --max-warnings 0
if ($LASTEXITCODE -ne 0) { throw 'Expo lint failed' }
$env:EXPO_OFFLINE = '1'
$env:CI = '1'
node node_modules/expo/bin/cli export --platform android --output-dir ../artifacts/audit-fixes/android-export --max-workers 2
if ($LASTEXITCODE -ne 0) { throw 'Android export failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Whitespace check failed' }
```

Run production native tests from Phase 3 with the existing GEMMA_JDK local-tool mechanism. Codex currently has `spikes/gemma4/check-native.mjs`; Manus's old spike-only scripts are NOT sufficient until replaced/extended. Record exact updated command names in REPAIR_STATUS.md. Do not enable broad network/tool downloads as a test shortcut; report missing dependencies separately. Existing dependencies may need ordinary Gradle resolution; no model weights are part of these builds.

Focused JS starting command (adjust if a branch lacks a named test rather than inventing a green result):

```powershell
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath __tests__/gemmaAgentCore.test.ts __tests__/gemmaLiveDataPorts.test.ts __tests__/gemmaMediaTasks.test.ts __tests__/gemmaProposals.test.ts
```

## Final status table to fill with evidence

| Finding | Codex | Manus | Required proof |
|---|---|---|---|
| A01 scope | Pending | Pending | Cleanup/staging/late-UI races, zero wrong-book writes |
| A02 confirmation | Pending | Pending | Exact classifier plus actual handlers, zero conditional writes |
| A03 restart | Pending | Pending | Production status verification scheduler, zero HTTP |
| A04 management | Pending | Pending | Warm unload/remove; corrupt file; failed close; stale recovery |
| A05 alignment | Pending | Pending | Rebuilt APK ELF/RELRO/ZIP checks; Needle asset preserved |
| A06 cash cursor | Pending | Not audited same defect | Unique journal-line traversal |
| A07 named cursor | Not applicable audited defect | Pending | Full ordered traversal, roles, stale cursor |
| A08 role ledger | Pending | Not applicable audited defect | Real SQLite, authoritative statement agreement |
| A09 capital | Pending | Not applicable audited defect | Period carry-forward/profit/member mapping agreement |
| A10 media | Pending | Pending | Failed/hung begin, cancellation, safe attachment ownership |
| A11 truncation | Pending | Pending | Oversized pages/rows rejected, zero partial import |
| A12 build | Pending | Pending | Standalone Gemma and default compile; correct workflow flag |
| A13 production tests | Preserve/extend | Pending | Tests compile shipped source paths, not spike duplicates |

Leave `Device acceptance: NOT RUN` even if every host row passes. No model capability/performance claims, Play-ready claim, commit, push or publication. Supply both artifact paths/hashes and the exact manual device checklist from PRE_PHONE_AUDIT.md. A constrained environment may block a build, but code-only changes do not close that build gate.
