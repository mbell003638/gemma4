# Pre-phone integration audit — 12 September 2026

## Verdict

**Not all clear. Non-phone work remains.** Passing existing tests did not establish correctness of the integrated paths. This audit reproduced authorization, confirmation, accounting, paging, restart, and media defects. Findings below are **unfixed**; this was an audit, not an implementation pass. No commits, pushes, model downloads, or changes to the other products were made.

Six specialist agents were dispatched, but all stopped at the usage limit without delivering reports. The coordinating agent completed the checks and reproductions described here directly; this is not six independent completed reviews.

## Exact scope

| Lab | Local branch | Baseline HEAD |
|---|---|---|
| `gemma4-lab` (Codex) | `codex/gemma4-p0-p3` | `badb3c738abda0ac70c875c44ccdbe078dcf02c2` |
| `gemma4-manus-lab` (Manus) | `codex/manus-gemma4-p0-p3` | `5b00321e6a90e9016d59c0179bec16cdc6a7a33c` |

These are separate dirty implementation worktrees, not interchangeable branches. Review covered the Gemma integration and its accounting, UI, media, native download/session, and packaging boundaries. It is not proof that every unrelated application feature is defect-free. Main and the non-downloadable AI product were outside the mutation scope.

## Current validation, not historical claims

| Check | Codex | Manus |
|---|---|---|
| Full Jest | 141 suites / 1,114 tests passed | 148 suites / 1,271 tests passed |
| TypeScript `tsc --noEmit` | Passed | Passed |
| Standard Expo lint, no cache, zero warnings | Passed | Passed |
| Android JavaScript export | Passed: 1,956 modules | Passed: 1,981 modules |
| Production Kotlin restart probe | Reproduced A03 | Reproduced A03 |
| Targeted JavaScript/SQLite probes | Reproduced A01/A02/A06/A08/A09/A10/A11 | Reproduced A01/A02/A07/A10/A11 |
| `git diff --check` | Passed (CRLF notices only) | Passed (CRLF notices only) |

The broader `eslint . --no-cache --max-warnings 0` check failed: Codex 23 errors / 81 warnings; Manus 23 errors / 76 warnings. Errors were in unchanged Jest configuration and vendored command-guard code; this is broader repository lint debt, not a demonstrated Gemma regression. Standard Expo lint covers a narrower set.

Android exports initially encountered sandbox process restrictions and then succeeded with approved execution. Both emitted a nonblocking `@noble/hashes/crypto.js` package-export fallback warning. Export output lives in each lab's `artifacts/audit-2026-09-12/android-export`. Those exports have **not** been packaged into the saved APKs.

No fresh Gradle build was performed in this audit. Existing APKs were inspected, not regenerated. No real LiteRT inference, model download, JNI execution, rendered Android UI test, or phone performance measurement occurred.

## Findings and required fixes

Priority P1 means fix before calling the integration ready; P2 means a concrete functional or assurance defect that also needs resolution, but may be behind an intentionally disabled feature.

### A01 — P1 — Both: a draft can be rebound to a different book

Locations: `frontend/src/accountingV2/gemma/agentCore.ts` (Codex draft check around 347, cleanup 411–418; Manus cleanup 331–339), and `liveProposalController.ts` (Codex 19–29; Manus 18–24).

The agent checks the scope before producing a draft, then awaits cleanup. The returned draft does not retain its originating scope. Staging subsequently captures the current scope again. The probe changes Book A to Book B during cleanup: a draft prepared for A is successfully stored with B's scope. Confirmation checks against that newly assigned scope cannot discover the original mismatch. An expense without referenced entity IDs is an especially direct case.

Fix: preserve immutable originating scope and request epoch through the outcome and staging contract; recheck after cleanup and before staging. Reject mismatches rather than assigning a fresh scope. Ensure the screen rejects stale results too. Add an end-to-end regression for book, permission, feature, and location changes at every await boundary, including cleanup.

### A02 — P1 — Both: correction or cancellation can be treated as confirmation

Locations: `frontend/app/ask.tsx:301` (Codex), `frontend/app/ask.tsx:330` (Manus).

The durable-proposal confirmation regex only anchors the beginning. It accepts `yes, but make it 500 instead`, `okay cancel it`, and `proceed only after I check`. The confirmation branch runs before cancellation or clarification. The audit extracted the actual source regex and reproduced those matches; it did not simulate taps in a rendered screen.

Fix: prefer the explicit Apply control. If textual confirmation remains, accept only exact, whole-message confirmations and route revised, conditional, or contradictory text to clarification. Test that every ambiguous example produces zero domain writes.

### A03 — P1 — Both: installed models become indefinitely VERIFYING after restart

Locations: production `GemmaPackStore.kt`, `state()` around 155–170; native bridge status path; `installedGemmaRuntime.ts:146`.

Verification readiness is process-local. A fresh store sees an existing model but reports VERIFYING, while status polling does not schedule verification. Runtime selection requires READY, so it never reaches loading. The Kotlin probe compiled the actual production store in each lab: READY before restart, repeated VERIFYING after recreation. Calling download on the already complete file rehashes it and restores READY without HTTP; this is a workaround, not automatic startup recovery.

Fix: schedule bounded asynchronous verification at startup or expose an explicit lazy verification operation used by runtime discovery. Test restart, tamper, interruption, concurrent status calls, and successful transition to READY. Do not replace verification with `File.exists()`.

### A04 — P2 — Both: normal model removal/recovery paths are incomplete

Locations: native bridge `gemmaRecover` around 321 and remove guard around 390; session host `finish`; Advanced Settings Remove controls (Codex around 707, Manus around 823).

Finishing a conversation leaves the model engine loaded, but removal refuses a loaded model. Recovery can unload it natively, yet the JavaScript interface does not expose that operation. The UI only offers Remove for READY files, excluding a corrupt final model or restart-stuck VERIFYING file. Discarding partial download data does not remove that corrupt final file.

Fix: provide a serialized cancel/finish/unload/remove lifecycle, expose appropriate recovery, and offer removal for installed bytes in error/verifying states. Surface failures in the UI. Test remove after inference and after failed verification without requiring process termination.

### A05 — P1 compatibility — Both: Needle library is not 16 KB ELF-aligned

Locations: native module `android/build.gradle` CMake arguments and `android/src/main/cpp/CMakeLists.txt`; actual saved Gemma APKs.

Every inspected arm64 shared library had LOAD alignment at least 16,384 except `libneedle_jni.so`, whose three LOAD segments have alignment 4,096. LiteRT-LM's library has 16,384 alignment. Thus preserving Needle's model asset alone does not prove native compatibility on 16 KB devices. This is not a claim that all phones fail; 4 KB devices differ and compatibility modes are not general readiness evidence.

Fix: use the appropriate NDK/linker configuration for 16 KB support, rebuild Needle, and check every ELF LOAD segment plus APK ZIP alignment. Retest Needle and Gemma together on the relevant device class. [Android's official 16 KB page-size guidance](https://developer.android.com/guide/practices/page-sizes) explains the required alignment and NDK-version differences.

### A06 — P2 — Codex only: cash-movement paging repeats rows

Location: `frontend/src/accountingV2/gemma/liveDataPorts.ts:223`.

The output cursor uses a composite `journalId:sourceId`, but filtering compares it to a raw journal ID. The production adapter probe gets the same `z:source-z` movement on consecutive pages. Multiple cash lines in one journal also need unique row identity.

Fix: use one stable ordering and cursor tuple, including a unique journal-line ID. Test equal dates, multiple lines per journal, and full traversal with no repeated or missing rows.

### A07 — P2 — Manus only: name-sorted paging filters by ID alone

Location: `liveDataPorts.ts:95`; analogous inventory and business-account paging around 213 and 231.

Rows are sorted by name and ID but paged using `id > anchor`. Alpha with ID z followed by Beta with ID a reproduces an advertised next page that is empty. Expanded customer/supplier roles also need distinct cursor identity.

Fix: align the sort and cursor tuple, including normalized name, ID, and role where applicable. Test non-monotonic IDs, duplicate names, dual roles, and full traversal of each affected tool.

### A08 — P1 — Codex only: customer statements include supplier credits

Location: `liveDataPorts.ts:114` and the role-specific debit mapping that follows.

Credit aggregation combines receivables, payables, and customer advances before respecting the requested party role. A real SQLite fixture with a customer receivable of 100 and supplier payable of 70 for the same party produces a customer closing balance of 30 instead of 100. Manus rejects the dual-role ambiguity, so this specific finding does not apply there.

Fix: derive the statement from the authoritative role-specific ledger projection. Handle advances and reversals with the correct signs. Add agreement tests against the ordinary statement screen for customer, supplier, dual-role, advances, and reversals.

### A09 — P1 — Codex only: business capital double-counts closed-period movements

Location: `liveDataPorts.ts:276`; compare the period-bound authoritative investor ledger service.

The adapter adds all historical injections/drawings to already carried-forward `current_capital`, without the current period bounds. A SQLite fixture with carried capital 150, including an old 50 deposit, reports 200 with no current-period activity. Manus applies date bounds and is not affected by this specific defect.

Fix: reuse authoritative current-period calculations or reproduce their exact date, profit-allocation, and rounding semantics. Test closed/reopened periods and historical movements, not only a new empty book.

### A10 — P2 — Both: failed media begin skips session cleanup

Location: `mediaTasks.ts:45–63`; native begin admission/error handling.

The started flag is assigned only after awaiting begin. If begin rejects, neither cancel nor finish is called; the probe observes zero calls to both, although attachment cleanup runs. A native pack failure after admission can therefore leave the session busy. Media requests also lack the bounded cancellation/deadline machinery used by the main agent path.

Fix: define lifecycle ownership before begin, clean up admitted requests even on begin failure, and bound preparation/inference/cleanup. Native failure paths must release admission safely for the correct request. Add failed-load, hung-begin, cancellation, and subsequent-request recovery tests. Keep unverified media capabilities disabled meanwhile.

### A11 — P2 — Both: document extraction silently drops pages and rows

Location: `mediaTasks.ts:107–113`.

Extraction limits PDF processing to five pages and slices combined output to 50 rows without exposing omitted-page or truncation metadata. The probe supplies an eight-page PDF: five calls produce 150 rows, but only 50 reach the result with no omission marker. The native normalizer's excluded-page count is not preserved.

Fix: either reject oversized input clearly or propagate counts and an explicit incomplete-result warning into review. Never present partial accounting imports as complete. Test page and row boundaries separately and together.

### A12 — P2 — Both: saved APK and CI checks do not prove standalone Gemma readiness

Locations: saved `artifacts/android/*gemma*debug.apk`; `.github/workflows/build-apk.yml:183`; `.github/workflows/android-native-validation.yml:67`.

Both saved APKs contain Needle, LiteRT-LM, and the catalog but no JavaScript `.bundle` or `.hbc`. They are debug/Metro-dependent artifacts, not standalone offline test packages. Successful exports during this audit do not update those APKs. Workflow Gradle invocations also omit `-PledgrGemmaEnabled=true`, while the native dependency defaults off; passing the default build need not compile the Gemma path.

Fix: add an explicit on-device build matrix/flag without changing the other products' defaults. Produce and inspect a standalone test-signed package containing the new JavaScript and both engines, with recorded hashes. Do not infer release-signing or Play readiness from a debug build.

### A13 — P2 — Manus only: native contract scripts test spike copies

Locations: `spikes/gemma4/check-downloads.mjs:47–48`, `check-host.mjs:82–83`.

The scripts compile files in `spikes/gemma4/src`, not the production Kotlin source set. The spike and production pack stores have different hashes and implementations. Those positive contract counts cannot stand in for production lifecycle coverage. This audit's restart probe deliberately compiled the production store instead.

Fix: make production core code testable with injected transport/runtime seams and compile the actual shipped sources in regression checks. Keep spike checks only as clearly labelled feasibility evidence.

## Reproduction artifacts

The executable audit probes live in `artifacts/audit-2026-09-12/reproduce-findings.cjs` and `PackRestartAudit.kt` in the Codex lab. JavaScript probes transpile production modules with controlled ports; accounting examples execute production SQL against small in-memory SQLite fixtures. They intentionally assert the currently incorrect behavior. **Exit 0 means defects reproduced, not readiness passed.** Convert them to expected-correctness regression tests when implementing fixes.

From `C:\Users\just2\Downloads\Ledger AI Codex`:

```powershell
node gemma4-lab/artifacts/audit-2026-09-12/reproduce-findings.cjs 'C:\Users\just2\Downloads\Ledger AI Codex\gemma4-lab'
node gemma4-lab/artifacts/audit-2026-09-12/reproduce-findings.cjs 'C:\Users\just2\Downloads\Ledger AI Codex\gemma4-manus-lab'
```

The Kotlin probe uses a synthetic five-byte temporary file, not model weights, and removes its temporary fixture. It compiles each lab's production `GemmaPackStore.kt` with the local Kotlin 2.4 compiler and runs `audit.PackRestartAuditKt`; compiled probe classes remain under the audit artifacts folder.

Saved APK SHA-256 evidence:

- Codex, 167,471,181 bytes: `11FC781BF5C880D9F58AE8EA63CB81ED8C152697DEE3BEF2B64A0D2FDBE1ACC7`
- Manus, 167,471,245 bytes: `2502F9E961D72FD0C517DFC9025DD855053DDE8BA7D70E30B3F95C6DE548A68B`

## Recommended repair order

1. A01/A02: originating scope and unambiguous confirmation, with zero-write negative tests.
2. A08/A09, then A06/A07: branch-specific accounting correctness and exhaustive paging.
3. A03/A04/A10: restart, unload/removal, and failure-safe session lifecycle.
4. A11: honest partial-document handling before enabling media.
5. A13: production native regression coverage; A05/A12: rebuilt, standalone, explicitly Gemma-enabled packages and artifact inspection.
6. Rerun both complete suites, types, lint, production native checks, Android exports and actual Gradle builds. Repeat the negative probes as expected-correctness tests.
7. Only then perform phone validation: installation/restart, downloads/resume/tamper, model loading, scoped read tools, confirmation-gated writes, Needle coexistence, vision/audio, cancellation, offline TTS, RAM, heat and latency. No host-only test replaces these measurements.

The earlier statement that only external validation remained is superseded by this audit.
