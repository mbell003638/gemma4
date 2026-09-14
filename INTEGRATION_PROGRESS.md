# Integration progress — 2026-09-12

This is the current state of the isolated Codex lab. No commit, push,
model-weight download, or Android-device run was performed. Both the default
legacy variant and the opt-in Gemma variant were compiled and packaged as
arm64 debug APKs.

## Completed without a phone

- The E2B/E4B catalog, verified resumable downloader, LiteRT-LM session host,
  manual tool bridge, cancellation/cleanup, and legacy Needle source-set
  isolation are implemented. The host compiles against real LiteRT-LM 0.17.0
  classes on the desktop JVM.
- Ask selects only a bridge-verified installed Gemma pack with tested text/tools.
  E4B is preferred when both are ready; Needle remains first for trained actions.
- Gemma reads use question-specific bundles over live scoped V2 SQLite adapters
  for reports, cash, parties, statements, entries, unpaid invoices, inventory,
  Business Accounts, and capabilities. It receives no whole-book snapshot.
- Scope is rechecked between tool steps and binds persisted book, local owner,
  app-lock/feature epochs, location, basis, currency, local date/timezone,
  journal revision, and sync entity revision. Synced identities fail closed
  until local role/location grants exist.
- Thirteen transaction-safe proposal operations are live behind durable ID-only
  confirmation. Write tools are selected by question family; supplier,
  customer, invoice, and Business Account references are resolved exactly in
  the current book and bound to revision checks. Exact-role debtor/customer and
  supplier creation are also live, with duplicate-party refusal. Credit sales,
  quotes, and edits/deletes retain Needle or the existing reviewed screen until
  their domain semantics can be represented without approximation.
- Advanced Settings exposes separate E2B/E4B lifecycle controls. TTS uses an
  installed offline voice, locale selection, chunking, cancellation, and the
  Android voice-data installer.
- Native image/PDF preparation now bounds bytes/pixels/pages, applies EXIF
  orientation, downsizes to 1280px, strips metadata by re-encoding, issues
  request-bound handles, and cleans up. Vision remains unadvertised pending a
  device test. Audio now uses Android MediaExtractor/MediaCodec decoding,
  bounded 60-second PCM, mono 16 kHz resampling, and a real WAV writer. Audio
  remains unadvertised until this compiled Android-only path passes a phone.
- JavaScript exposes the media bridge through bounded response parsers and
  refuses image/audio preparation unless native explicitly advertises a
  device-verified capability.
- The real scan/import and transcription API routes now call those bounded
  Gemma media tasks in explicit Android-device mode. Voice UI can use the Gemma
  fallback only when native reports a ready pack with verified audio support.
- The coverage register is constrained to the same live proposal allowlist used
  by Ask; guided-only operations cannot be accidentally advertised as automated.

## Current verification

- TypeScript: pass.
- ESLint with zero warnings: pass.
- Full Jest suite: **141 suites / 1,114 tests**, all pass.
- SDK and native-host contract checks: pass against real LiteRT-LM classes.
- Android API 36, NDK 27.1.12297006, CMake 3.22.1, command-line tools, and
  licenses: installed and accepted.
- Expo prebuild: pass with the tracked, idempotent Gemma toolchain plugin.
- Default arm64 APK (Kotlin 2.1.20): **145,072,645 bytes (138.35 MiB)**,
  SHA-256 `5CB2A5E49F3E5182FE4323DD73A75167CD80F41526A92C57FF2EF11B56311952`.
- Gemma arm64 APK (Kotlin 2.4.0 / KSP 2.3.10): **167,471,181 bytes
  (159.71 MiB)**, SHA-256
  `11FC781BF5C880D9F58AE8EA63CB81ED8C152697DEE3BEF2B64A0D2FDBE1ACC7`.
- Matched Gemma dependency overhead: **22,398,536 bytes (21.36 MiB)**.
- APK archive check: both variants contain `lib/arm64-v8a/libneedle_jni.so`,
  `assets/needle2.cact`, and `assets/model-packs-v2.json`; Gemma additionally
  contains `lib/arm64-v8a/liblitertlm_jni.so`. Neither APK contains
  downloadable `.litertlm` or `.task` model weights.
- Needle2 SHA-256 remains
  24982abc3ed97b36192a16b0ea2758698c1a300853c01ab69e9decb3852d140f.
- No .litertlm model file exists in this lab.

## Remaining device gates

The SDK, license, Kotlin metadata, Gradle compilation, and APK packaging gates
are closed. The solution keeps Kotlin 2.1.20/KSP 2.1.20-1.0.29 for ordinary
builds and conditionally selects Kotlin 2.4.0/KSP 2.3.10 only when
`ledgrGemmaEnabled=true`; it does not use
`-Xskip-metadata-version-check`. The tracked Expo config plugin reapplies that
selection after prebuild, while the source-set flag keeps LiteRT-LM out of the
default variant.

A phone and real weights are still required for model load and tool-template
round-trip, RAM/thermal/latency, Android download lifecycle, vision inference,
audio conversion/transcription, airplane-mode TTS, microphone feedback, and
process-death cleanup. Until those runtime gates pass, device-verified
capability advertisement remains correctly disabled.

Preserved APKs are under `artifacts/android/`. The historical all-ABI build is
retained as `codex-legacy-all-abi-pre-needle-debug.apk` and explicitly labelled
pre-Needle; use the matched arm64 pair for size comparisons and testing.
