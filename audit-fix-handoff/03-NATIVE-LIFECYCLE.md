# Phase 3 — A03/A04/A10/A13

Apply lifecycle behavior independently to both labs. Production native directory is `frontend/modules/ledgr-native-ai/android/src/gemma/java/expo/modules/ledgrnativeai`. Primary files: `LedgrOnDeviceLlmModule.kt`, `GemmaPackStore.kt`, `GemmaSessionHost.kt`; JS: `frontend/src/utils/gemmaNative.ts`, Advanced Settings, agent recovery callers. Do not modify `src/legacy` to introduce Gemma dependencies.

Reference Kotlin below uses existing bridge fields `gemmaExecutor`, `gemmaAdmitted`, `gemmaShutdown`, `gemmaStore()`, `gemmaHostRef`, and `gemmaWork`. It must be integrated, not pasted as a separate parallel implementation. `gemmaWork` currently returns a JSON String through an Expo Promise; keep return types consistent across native/JS/tests.

## One ownership model

All model file verification, load, finish/unload and final removal must run on the inference executor or under an equally strict serialized ownership mechanism. Cancellation may request cancellation from the calling thread but must not free JNI objects there. Protect both scheduling-time admission and executor-time state; checking `activeRequestId()` alone misses admitted-but-not-started tasks.

Use management reservation tokens with `:` (not accepted as native inference request IDs). Reserve with compareAndSet BEFORE enqueueing. In `gemmaBegin`, validate the request ID pattern `[A-Za-z0-9_-]{1,80}` before compareAndSet, not merely that JSON contains a string. Otherwise a malicious/malformed request could collide with a management token. A stale finish/cancel for request A must never clear B's reservation.

## A03 — schedule local verification, not download

`GemmaPackStore.verifiedFile(id)` already rehashes final files. Do not call `download()` from status or runtime discovery. Add this bridge helper:

```kotlin
private fun scheduleInstalledVerification() {
  if (gemmaShutdown.get()) return
  val store = gemmaStore()
  val id = store.approvedIds().firstOrNull {
    store.state(it) == GemmaPackState.VERIFYING && store.installedBytes(it) > 0L
  } ?: return
  val token = "verify:$id"
  if (!gemmaAdmitted.compareAndSet(null, token)) return
  try {
    gemmaExecutor.execute {
      try {
        if (!gemmaShutdown.get() && gemmaAdmitted.get() == token) {
          store.verifiedFile(id)
        }
      } catch (_: GemmaPackException) {
        // Store records ERROR; a later status displays it. Never download here.
      } catch (_: Exception) {
        // Record a sanitized verification failure in the store/status contract.
        // Add recordVerificationFailure(id) below; do not leave a retry loop.
        store.recordVerificationFailure(id)
      } finally {
        gemmaAdmitted.compareAndSet(token, null)
      }
    }
  } catch (_: RejectedExecutionException) {
    gemmaAdmitted.compareAndSet(token, null)
  }
}
```

Add the store helper used above:

```kotlin
@Synchronized
fun recordVerificationFailure(id: String) {
  spec(id)
  verified.remove(id)
  states[id] = GemmaPackState.ERROR
}
```

Call `scheduleInstalledVerification()` near the start of getStatus, before constructing the status map. It queues work without hashing on the UI thread. After a task finishes, schedule the next remaining VERIFYING pack (outside the current token reservation) or ensure Settings/runtime polling does so; test two installed packs to prove both finish. Prevent automatic retries for ERROR. A user may explicitly retry verification or remove it. Preserve accurate NOT_INSTALLED/PAUSED states; a partial file is not a final file.

UI: show `Verifying downloaded model…` and poll while VERIFYING; do not display `download required` for that state. Expose managementBusy/operation separately so a verification token is not misrepresented as a running user request. Ask should tell the user verification is in progress, not start another model unexpectedly. Do not block the JS thread for a multi-GB hash.

Strengthen `verifiedFile`: store the stamp BEFORE reading, hash the bytes, then compare the AFTER stamp. On change, remove cached verification and throw a stable `MODEL_CHANGED_DURING_VERIFICATION` code rather than blessing the post-read file. A stamp alone is not an adversarial proof of content; all app writes/remove/load must use the same serialization and pinned expected SHA-256. No stamp is persisted as permanent trust across process restart.

Store test: tiny approved fixture -> verifiedFile READY -> instantiate new store VERIFYING -> invoke the actual production verification coordinator -> READY. Count transport calls: zero. Hash mismatch -> ERROR once; repeated status does not loop verification. Missing final with partial -> PAUSED, zero HTTP. Two packs, concurrent polling, shutdown/rejected executor, removal during verification must be deterministic. Upgrade `PackRestartAudit.kt` into an expected-correctness check; merely calling download to rehash does NOT close A03.

## A04 — unload and remove on owner executor

Replace the synchronous gemmaRemove bridge with an asynchronous operation. Reserve an exclusive management token before scheduling and recheck download activity inside it. A currently running request must be cancelled/finished through its own UI flow first; removal must not unexpectedly destroy another active request.

```kotlin
AsyncFunction("gemmaRemove") { modelId: String, promise: Promise ->
  val token = "remove:$modelId"
  if (gemmaShutdown.get() || !gemmaAdmitted.compareAndSet(null, token)) {
    promise.reject("MODEL_IN_USE", "Finish the current local-model task first.", null)
  } else {
    // IMPORTANT: enqueue via a management wrapper that releases the token on
    // shutdown/rejected execution as well as in the work block's finally.
    gemmaManagementWork(promise, token) {
      if (gemmaDownloadStops.containsKey(modelId)) throw GemmaPackException("MODEL_DOWNLOAD_BUSY")
      if (gemmaHostRef?.loadedModelId() == modelId) gemmaHostRef?.unloadEngine()
      val removed = gemmaStore().remove(modelId)
      org.json.JSONObject().put("removed", removed).toString()
    }
  }
}
```

Implement the referenced wrapper explicitly (do not route it through an early-return path that forgets the token):

```kotlin
private fun gemmaManagementWork(promise: Promise, token: String, work: () -> String) {
  try {
    gemmaExecutor.execute {
      try {
        if (gemmaShutdown.get()) throw GemmaPackException("GEMMA_SHUTDOWN")
        if (gemmaAdmitted.get() != token) throw GemmaPackException("STALE_SESSION")
        promise.resolve(work())
      } catch (error: GemmaPackException) {
        promise.reject(error.code, gemmaMessageFor(error.code), null)
      } catch (_: Exception) {
        promise.reject("GEMMA_FAILED", "The local model operation failed.", null)
      } finally {
        gemmaAdmitted.compareAndSet(token, null)
      }
    }
  } catch (_: RejectedExecutionException) {
    gemmaAdmitted.compareAndSet(token, null)
    promise.reject("GEMMA_SHUTDOWN", "The local model runtime is shutting down.", null)
  }
}
```

This is the normal-success/exception skeleton. **Before accepting it**, fix `unloadEngine()` to acknowledge close failure: it currently swallows exceptions and clears engine references. Failed/unconfirmed JNI close must set a poisoned/recovery-required native state and keep admission closed; neither a management finally nor gemmaWork's generic catch may reopen it. Introduce an explicit `gemmaPoisoned` AtomicBoolean checked by every begin/management call, and do not clear it without confirmed teardown (restart may be the only safe recovery). The finally may clear the reservation token only if poisoned state still prevents subsequent admission. Add a `requireHealthyRuntime` guard to all entry points. Never rely on a bare JS busy flag for this guarantee.

Update native return type in `GemmaManagementNative` to `gemmaRemove(modelId): Promise<string>` and parse the `{removed:boolean}` JSON in removeGemmaPack. Reject malformed replies or missing bridge functions instead of returning false-as-success. Bump bridge protocol version in both native/JS if necessary; version 2 older APKs must not be treated as implementing new string-returning management APIs. Missing/older bridge produces a clear rebuild-needed error, not silent model deletion failure.

Settings: offer Remove whenever `bytesOnDisk > 0`, including ERROR/VERIFYING/UNSUPPORTED, but disable while verification, download or active inference holds ownership; explain why. After verification fails the button must become usable. Keep discardPartial for `partialBytes > 0`, distinct from final removal. Catch and display operation errors; refresh status in finally. Test ready+warm engine removal, corrupt final, only partial, other model loaded, active turn, parallel download/remove, and failed close. Preserve the user's confirmation before deleting model bytes.

### Explicit recovery

Expose a versioned JS recovery wrapper only with request-aware semantics. Replace native blind `gemmaAdmitted.set(null)` with comparison against the failed request ID/maintenance generation. Cancel that ID from the caller thread; enqueue teardown behind inference; release only after confirmed close. Reject recovery for a different/current healthy request. A delayed recovery for A must not unload B. If JNI is hung, report restart-required rather than claim a timeout freed it. Manus's JS `agent.recover()` currently just flips flags: call it only after successful native recovery. Codex needs equivalent reset on its per-process coordinator, not a fresh coordinator over a still-busy native host.

## A10 native half — begin failure must end ownership safely

Current gemmaWork's GemmaPackException branch rejects without releasing admission. Do not simply add release in every catch: resume failure may still own a live conversation. At the begin/resume work boundary, catch failure, attempt request-scoped `finish(requestId)` on the executor, then release that ID only on confirmed cleanup. If finish/unload fails, set recovery-required and preserve rejection/admission. A busy rejection for B must never finish A. For shutdown-before-start and rejected executor, release that request's reservation explicitly. Test each exception branch, cancellation-before-begin, queue rejection and late finish.

The JS half is in Phase 4. Native must be safe even if JS crashes and never sends finish; JS must still attempt its cleanup handshake.

## A13 — Manus production native contract coverage

Do not report the existing `check-host.mjs`/`check-downloads.mjs` spike tests as production tests. They compile `spikes/gemma4/src/*` duplicates. Adapt their source lists and imports, not production code into the spike package:

```js
const production = path.join(root,
  'frontend/modules/ledgr-native-ai/android/src/gemma/java/expo/modules/ledgrnativeai');
const sources = [
  path.join(production, 'GemmaPackStore.kt'),
  path.join(root, 'spikes/gemma4/tests/ProductionPackContractCheck.kt'),
];
```

Place new test-only drivers under `spikes/gemma4/tests`. Import `expo.modules.ledgrnativeai` classes. Reuse the installed Kotlin compiler/real SDK JAR classpath and subprocess checking code. Record SHA-256 hashes and absolute paths of every compiled production source in the generated test report. A test must fail if a production guard is intentionally broken temporarily; never leave the intentional mutation behind.

For session behavior without a model/JNI, extract a narrow production runtime interface around the existing Engine/Conversation operations and inject a fake in tests; the real implementation continues using actual SDK types with automaticToolCalling disabled. Do not fabricate LiteRT classes with the same package names. Test the production admission/recovery/verification coordinator as a JVM-friendly component used by the Expo bridge; do not merely unit-test a second coordinator unused by the app. Bridge Android/Expo compilation remains a real Gradle gate, not a stubbed JVM success.

Port the production lifecycle regression drivers to Codex too where the new seams are shared. Keep spike feasibility checks labelled separately. Required groups: restart/hash/no-network, begin/resume/late-result/cancel, warm unload/removal/failed-close, stale recovery versus B, tool execution gate. No weights needed.
