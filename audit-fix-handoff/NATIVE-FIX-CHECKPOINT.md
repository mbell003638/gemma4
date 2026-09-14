# Native fix checkpoint — 2026-09-14

IMPLEMENTATION COMPLETE — source reads/edits only. No tests, typechecks, lint, compiles, builds, probes, downloads, commits or pushes executed.

Both existing dirty labs preserved: Codex `codex/gemma4-p0-p3`; Manus `codex/manus-gemma4-p0-p3`.

## Concrete source saved in both labs

- Production native `GemmaLifecycle.kt`: admission, shared management queue, request-local terminal acknowledgements, restart verification and failure cleanup.
- `LedgrOnDeviceLlmModule.kt`: delegates begin admission and management to that coordinator; shutdown stops downloads and retains uncertain teardown ownership.
- `GemmaSessionHost.kt`: saved real-runtime seam plus cancellation/close serialization.
- `GemmaAttachmentStore.kt`: deletion failure is no longer swallowed before a terminal acknowledgement.
- Existing `GemmaRuntime.kt`, `GemmaPackStore.kt` saved by the previous agent remain part of this implementation.
- `spikes/gemma4/check-production.mjs` and `check-native.mjs`, `check-host.mjs`, `check-downloads.mjs`: compile actual production sources, including Runtime/Lifecycle for host/native; all test dependencies explicitly listed; installed tools only; fresh class directory; source/dependency absolute paths and SHA-256 evidence. Every invocation invalidates all three prior report names before checking dependencies.
- `spikes/gemma4/tests/ProductionLifecycleContractCheck.kt`: new production coordinator admission, management exclusion/rejection/shutdown/staleness, queued acknowledgements, cleanup failure/poison, stale finish/recover and removal scenarios.
- `ProductionFixtures.kt`, `ProductionHostContractCheck.kt`: use production admission and live host state; corrected unknown-model expectation. Existing `ProductionPackContractCheck.kt` retained.

Protocol: gemmaFinish/gemmaRecover resolve JSON strings `{requestId,finished:true}` only after cleanup. A stale finish releases only its own request media and never closes another request; stale recovery rejects. Failed/unconfirmed native close requires restart.

## Final integration saved

Reviewed explicit driver dependencies and production fixture wiring. Both host and
native modes also compile/run NativeContractCheck against shipped classes, retaining
catalog pins/drift, private path/handle/expiry/release and request/schema-only-tool
guards. Codex retains its original src/NativeContractCheck.kt; Manus receives the
shared guard fixture under tests/, never its archived prototype implementations.
The media source assertions still match the normalizer: it reports excluded pages;
the JS extraction boundary rejects any exclusions before inference. No assertion
was removed or weakened.

ProductionHostContractCheck now uses the real private attachment store through the
injected runtime seam and production coordinator. Added request-A versus stale
finish-B ownership, successful cleanup and failed-initialization cleanup cases.
Added cancellation-during-close regression; production begin/resume recheck the
cancellation tombstone after frame construction/close, before returning an answer.
This complements cancellation/close locking and retained ownership on close failure.

Deferred commands, from this isolated lab root with GEMMA_JDK pointing to an installed
compatible full JDK and all listed .local-tools dependencies present:

```powershell
node spikes/gemma4/check-native.mjs
node spikes/gemma4/check-host.mjs
node spikes/gemma4/check-downloads.mjs
```

Each invocation invalidates the three old success report filenames, uses fresh class
output, and reports exact production/fixture/dependency paths and fingerprints.
Save the report from each mode before starting the next if all three are needed.
No dependency installation, model download or real network is part of these drivers.
They do not compile the Android/Expo module; that remains the separate Gradle gate.

## Acceptance deferred

All execution, Kotlin/Android/Expo compilation, regression runs, intentional guard-mutation checks, Gradle/APK acceptance, real SDK/JNI/model/device behavior remain unverified. Historical reports are not evidence for these changed sources. No generated report was produced or executed during this turn.
