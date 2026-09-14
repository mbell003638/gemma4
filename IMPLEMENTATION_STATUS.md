# Gemma 4 + LiteRT-LM implementation status

> **2026-09-12 Android build closure:** Android SDK 36 and licenses are
> configured. Expo prebuild succeeds. Both the default Kotlin 2.1.20 arm64 APK
> and the opt-in Kotlin 2.4.0/KSP 2.3.10 Gemma arm64 APK build successfully.
> Both APKs contain the Needle JNI engine and tuned asset. The Gemma APK also
> contains LiteRT-LM but no downloadable model weights and adds 21.36 MiB over
> the matched legacy build. See [INTEGRATION_PROGRESS.md](INTEGRATION_PROGRESS.md)
> for hashes and current evidence. Statements below that say Gradle, bridge
> compilation, media wiring, UI wiring, or APK generation are incomplete are
> retained only as historical checkpoints and are superseded by that record.
> The remaining gates require a phone and downloaded model weights.

> Current source of truth: [2026-09-10 integration progress](INTEGRATION_PROGRESS.md).
> Host-side implementation now includes live scoped Ask reads, thirteen durable
> ID-confirmed write types with scoped reference preflight, model lifecycle UI,
> offline TTS hardening, and bounded image/PDF/audio normalization plus typed
> bridge wrappers wired into scan, transcription, and voice fallback routes.
> Current validation is 141 suites / 1,114 tests with
> TypeScript and zero-warning ESLint passing. Only phone/model runtime and
> audio/vision inference gates remain open; older stage tables below are history.

> Superseded in part by the 2026-09-08 independent [audit and fixes](AUDIT_REVIEW.md).
> Current validation: 129 suites / 1009 tests pass; TypeScript and scoped ESLint pass.
> The SDK dependency and native source tree now share a default-off build flag.
> P2-P5 remain components awaiting app/device integration. The prior report below
> is retained as historical evidence, including claims corrected by the audit.

Target: this isolated lab clone only (`codex/gemma4-p0-p3`). No remotes, no commits, no pushes.
Plan: `docs/plans/gemma4-litertlm/` (identical copy at `gemma4-litertlm/`).
Last updated: 2026-09-08.

Read this before re-deriving the design. Per plan 05 s2 this file records completed
gates and their exact evidence; it is not the place to redesign the architecture.

## Evidence vocabulary

| Term | Means |
|---|---|
| **unit-tested** | Jest assertions over real code in this repo |
| **host-compiled** | Kotlin type-checks against the real SDK classes on a desktop JVM, `-Werror` |
| **contract-checked** | Pure behavioural assertions on a desktop JVM: no Android, no JNI, no model |
| **not-run** | Not attempted here. Never report as passing. |

Nothing in this repo has been run on Android, in Gradle, or against real model
weights. "TypeScript passes" and "Kotlin compiles" are not "a model runs".

## Verification as of this update

```
frontend:  npx tsc --noEmit          clean
           npx jest                  127 suites / 990 tests passing
           npx eslint (new files)    clean, 0 warnings
root:      node spikes/gemma4/check-sdk.mjs      compile + contract checks pass
           node spikes/gemma4/check-native.mjs   compile + 4 contract groups pass
```

Pre-existing baseline before this work: **121 suites / 832 tests**. The Gemma work
adds **158 tests** and broke none. (An earlier "855" figure already included the
first new suite.)

## Stage status

| Stage | State | Evidence |
|---|---|---|
| P0 baseline | **done** | `ISOLATION.md`, `lab-baseline.json`; Needle asset `13,737,807` bytes, SHA-256 `24982abc…d140f` re-verified; clean test baseline recorded |
| P1 SDK feasibility | **host/build complete; device gate open** | Every SDK symbol was re-verified against 0.17.0 and both Android variants package. **Physical-device and real-model evidence: not-run** |
| P2 verified downloads | **done (host-verified)** | `GemmaPackStore.kt` host-compiled + contract-checked; `packCatalog.ts` 45 tests; schema-2 catalog bundled in native assets *and* TS, with a drift guard in both suites |
| P3 native host + bridge + lifecycle | **done; device gate open** | Host contract checks pass and the complete Expo bridge compiles/packages in the Gemma APK; JNI inference awaits a phone and weights |
| P4 scoped context + read adapters | **done** | `coreReadTools.ts` (12 tools), `scopeContext.ts`, `toolBundles.ts`; 25 + 14 tests |
| P5 proposals + exactly-once commit | **done** | Durable proposal confirmation and live transaction action ports are wired and tested against the shipped SQLite schema |
| P6 media / scan / voice / TTS | **implemented and Android-compiled; device gate open** | Bounded image/PDF/audio normalization, scan/transcription routes, native TTS, and capability guards are wired; modality inference awaits a phone |
| P7 feature coverage register | **done** | `coverage.ts` + 15 tests; all 19 `FeatureKey`s plus 2 always-on core areas resolved; build fails on a row that claims a tool that does not exist |
| P8 UI, legacy cleanup, release QA | **UI/build complete; device release QA open** | Advanced Settings lifecycle controls and Ask/voice routes are wired; matched Needle and Gemma arm64 APKs are preserved |

## Historical blockers (superseded by the build-closure record above)

### 1. Kotlin toolchain conflict — resolved by the conditional build variant

LiteRT-LM 0.17.0's classes carry Kotlin metadata **2.4.0**. This app's React
Native gradle plugin pins Kotlin **2.1.20**
(`node_modules/@react-native/gradle-plugin/gradle/libs.versions.toml`). A 2.1.20
compiler refuses to read 2.4.0 metadata.

The dependency line in `modules/ledgr-native-ai/android/build.gradle` is
therefore **present but commented out**, with the reasoning inline. Enabling it
today breaks the build. `-Xskip-metadata-version-check` and a blanket toolchain
bump for all four products are both ruled out by the plan.

The module's own Kotlin compiles cleanly against the real SDK classes, so the
code is not the blocker — the build toolchain is.

### 2. P1 device gate is still open

No Android device, and no model weights downloaded (2.5 GB E2B / 3.7 GB E4B,
not authorized). P2–P7 code is written and host-verified *behind* an unmet gate,
which plan 01 s8 permits as work-in-progress but which must not be reported as a
passing stage.

### 3. Hugging Face LFS redirect host is unconfirmed

`GemmaPackStore.connect()` allowlists `huggingface.co`, `hf.co` and `*.hf.co`
and follows redirects by hand, re-checking every hop. Weight downloads redirect
to an LFS CDN whose real host is **unverified on device**. If it falls outside
the allowlist the download fails closed with `MODEL_HOST_NOT_ALLOWED`. Confirm
the real chain on device and get the host approved explicitly — do not widen the
allowlist from a stack trace.

### 4. `applyAction` is still in the Ask screen

Transaction-scoped atomicity **is achievable on this branch** — the plan flagged
this as possibly blocking, and it is not. The codebase already uses `SAVEPOINT`
rather than `BEGIN`/`COMMIT` specifically so nested domain writes compose
(`V2SqlRepository.tx`, `bookConfigRepository`, `partyDomainService`), and
`proposalExecutor` follows that pattern. Test B7 proves a party materialized
during a failing apply is rolled back, against real SQLite.

What remains is wiring: the real domain write sits behind the `apply` port, and
`ask.tsx`'s `applyAction` switch has **not** been extracted into it yet. Per plan
04 s3 that extraction needs characterization tests for every switch case first.
Until it is done, P5 is proven as machinery, not as a live path.

### 5. Two composition roots are missing

`branchPorts.ts` (P4/P5 ports → `api.*`) and the Ask-screen wiring (P8). Every
module is port-injected and tested, but nothing is connected to the live app
yet, which is why no UI change exists and no feature flag has been flipped.

## Verified findings from the audit of the plan

All checked against this branch's source; all confirmed.

| Claim | Verdict |
|---|---|
| `onDeviceReadTools` reads `dashboard.sales`, but `getV2Dashboard` returns `totalSales` | **confirmed** — silently reports `0.00` sales |
| Its balance-sheet helper treats `assets` as a number | **confirmed** — `api.balanceSheet()` returns an object; renders `0.00` |
| Its trial-balance helper expects `debit`/`credit`/`balanced` | **confirmed** — facade returns `debits`/`credits` arrays; always renders "OUT OF BALANCE" |
| Date arguments ignored | **confirmed** |
| `cash_flow` relabels a dashboard summary | **confirmed** |
| Downloader: optional checksum, `File.exists()` as installed, broad `200..299`, rename→copy fallback, deletes partial on cancel | **confirmed** — all five; none carried into `GemmaPackStore` |
| Needle asset is 13,737,807 bytes | **confirmed** |
| Both packs public, Apache-2.0, HTTP 206, byte totals match pins | **confirmed** — re-verified live 2026-09-08 |
| `Conversation.cancelProcess()` and `maxOutputToken` exist (plan flagged uncertain) | **confirmed present** |

### Deviations from the plan's draft code

- `ToolCall.getArguments()` returns `Map<String, Any?>`, **not** a JSON string.
  The draft's `JSONObject(c.arguments)` was written for a string.
  `GemmaSessionHost.argumentsToJson` handles the real shape.
- The plan's `createAgent` returns from a `finally` block, which silently
  discards the real outcome. Restructured to compute the outcome, then run the
  native cancel/finish handshake, preserving the intended
  `NATIVE_RECOVERY_REQUIRED` behaviour.
- The plan's `pnlTool` maps `expenses → operatingExpenses`. On this branch
  `reports.ts` documents accrual `profitAndLoss.expenses` as *including* COGS,
  so that label would have been wrong. `read_profit_and_loss` reports
  `totalExpenses` plus an explicit
  `totalExpensesIncludeCostOfGoodsSold` flag instead.
- `api.pnl()` maps `cogs = totalPurchases` (purchases-as-COGS, test B10). No
  read tool sources from it.

### Defects found and fixed by the new tests

1. `coreReadTools` read paths did not independently re-check authorization —
   they relied entirely on the caller having asked (test A8). Now every tool is
   wrapped by `readOnly()`, which re-checks permission **and** re-validates
   arguments against the tool's own schema.
2. `read_trial_balance` accepted a payload claiming `balanced: true` while its
   own debit and credit totals disagreed. Now cross-checked.
3. Two `Json` typing holes in `coreReadTools` (union widening injecting
   `undefined` keys) that `tsc` rejected.

## Next bounded tasks, in order

1. Extract `ask.tsx`'s `applyAction` behind characterization tests, then wire it
   to `ExecutorPorts.apply` (finishes P5 as a live path).
2. Write `branchPorts.ts` and reconcile the P4 read tools against fixture books
   through real `api.*`/`buildPersistentV2Reports` (upgrades B1/B2 from
   port-level to fixture-level evidence).
3. Resolve the Kotlin toolchain question, then compile the bridge module and run
   the P1 device gate.
4. P6 media normalization; P8 UI behind an experimental flag.

## Reproducing the checks

```powershell
cd frontend
npx tsc --noEmit
npx jest                     # full suite
npx jest gemmaAgentCore gemmaPackCatalog gemmaReadTools gemmaScopeAndBundles gemmaProposals gemmaCoverage gemmaDocumentOutput

cd ..
$env:GEMMA_JDK = 'C:/Program Files/Android/Android Studio/jbr'
node spikes/gemma4/verify-isolation.mjs
node spikes/gemma4/check-sdk.mjs
node spikes/gemma4/check-native.mjs
```

`--download-tools` on the check scripts fetches compiler/SDK/org.json jars only.
No script here downloads model weights.
