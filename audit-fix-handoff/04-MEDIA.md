# Phase 4 — A10/A11, both labs

Files: `frontend/src/accountingV2/gemma/mediaTasks.ts`, `documentOutput.ts`, `frontend/src/utils/gemmaNative.ts`, existing media/scan UI callers and tests. Phase 3 native ownership must also be implemented. Keep vision/audio capability gates OFF until device acceptance; fake injected runtime tests may exercise these functions without enabling production capabilities.

## A10: bounded work and mandatory cleanup

The existing started flag skips cleanup if begin fails. Replace it with request ownership that starts before begin is attempted; cancel/finish are request-ID scoped and must be safe even if this request was never admitted. A rejected B cannot tear down active A. Do not discard attachments underneath running JNI after a timeout: queued native release must occur only after that request's confirmed finish, or be retained until explicit recovery/restart.

Add this complete deadline helper (new `mediaDeadline.ts` is a suitable home):

```ts
export async function bounded<T>(work: () => Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function remaining(deadlineAt: number): number {
  const ms = deadlineAt - Date.now();
  if (ms <= 0) throw new Error('GEMMA_MEDIA_TIMEOUT');
  return ms;
}
```

Replace mediaTurn with this reference body, adding the parameters and imports at its call sites:

```ts
async function mediaTurn(
  runtime: InstalledGemmaRuntime,
  id: string,
  mode: 'extract' | 'transcribe',
  system: string,
  input: string,
  attachment: { imageHandle?: string; audioHandle?: string },
  deadlineAt: number,
  markRecoveryRequired: () => void,
): Promise<Frame> {
  let result: Frame | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await bounded(() => runtime.engine.begin({
      requestId: id, modelId: runtime.modelId, mode, system, input, tools: [], ...attachment,
    }), remaining(deadlineAt), 'GEMMA_MEDIA_TIMEOUT');
    if (result.requestId !== id || result.calls.length !== 0) throw new Error('INVALID_MEDIA_MODEL_FRAME');
  } catch (error) {
    failed = true;
    failure = error;
  }
  // Always attempt both, even when begin rejected or never settled.
  try { await bounded(() => runtime.engine.cancel(id), 5000, 'NATIVE_CLEANUP_TIMEOUT'); }
  catch { /* finish acknowledgement is still required */ }
  try {
    await bounded(() => runtime.engine.finish(id), 5000, 'NATIVE_CLEANUP_TIMEOUT');
  } catch {
    markRecoveryRequired();
    throw new Error('NATIVE_RECOVERY_REQUIRED');
  }
  if (failed) throw failure;
  if (!result) throw new Error('INVALID_MEDIA_MODEL_FRAME');
  return result;
}
```

This handles deadline/cleanup but does not itself implement an external AbortSignal. Extend public media input options with an optional signal without changing existing callers (third options argument is fine). Add a listener before preparation, issue request-scoped cancel on abort, reject work with CANCELLED, remove listener in finally, and test pre-abort and mid-begin. Use the existing agentCore abortable pattern or extract a shared equivalent; do not omit the rejection handler on a promise that can settle after timeout.

### Required surrounding wiring

1. One overall `deadlineAt = Date.now() + 60_000` per document/audio request, not a renewed 60 seconds per PDF page. Bound runtime lookup, image/PDF/audio preparation and every mediaTurn using remaining(deadlineAt). Cleanup gets its separate bounded allowance.
2. Add `markRecoveryRequired` to MediaDeps. Production implementation latches an unavailable/recovery-required state shared with installedGemmaRuntime and its consumers; fake tests can inject a spy. Only successful request-aware native recovery or process restart clears it. Do not recreate an engine wrapper to bypass it. Expose a safe UI retry/restart explanation.
3. Track request IDs for every prepared page. Native attachment release/discard must be queued behind usage on the inference executor, not `release(requestId)` from a calling thread while inference is still running. A late preparation completion after JS timeout must be followed by a queued release even if its handle was never returned. Put attachment ownership and queued cleanup into the same production lifecycle seam from Phase 3.
4. Replace `.catch(() => 0)` cleanup swallowing where it hides an unrecovered state. If teardown is uncertain, return NATIVE_RECOVERY_REQUIRED and retain safe ownership; do not return a normal successful document or transcript.
5. If begin was rejected GEMMA_BUSY because another request owns native state, no request-wide recovery may target that other request. Request-local finish/discard for the rejected ID must be harmless.

### Tests

Use fake timers plus deferred promises, not long real sleeps. Test begin rejection -> cancel+finish each attempted; hung begin -> bounded return plus cleanup; failed finish -> recovery latch set, next runtime denied; successful explicit recovery clears latch only after acknowledgement; frame ID mismatch; model tries media tool calls; late preparation/result after abort; cancel B while A runs; zero attachment deletion while A owns its JNI input. Real native cleanup cannot be certified by a JavaScript fake—Phase 3 production coordinator tests and final Gradle build are separate gates.

## A11: reject incomplete PDFs/oversized extraction

Chosen behavior: **no partial document is returned**. The user gets a clear error asking them to split the input. Limits remain five pages and 50 entries. This is deliberately simpler and safer than adding implicit truncated imports.

Add `MAX_DOCUMENT_PAGES = 5` to documentOutput or a shared bounds module and use it in native preparation limits where configuration permits. Validate prepared pageCount (PDF must be >=1) and excludedPages (>=0). Native preparePdfPage knows total pages: fail before returning a handle/inference if pageCount exceeds the limit, using `GEMMA_PDF_TOO_MANY_PAGES`. Also enforce it in JS as defense in depth.

In extractDocumentWithGemma after first page preparation/extraction:

```ts
if (input.mimeType === 'application/pdf' &&
    (first.pageCount > MAX_DOCUMENT_PAGES || first.excludedPages > 0)) {
  throw new Error('GEMMA_PDF_TOO_MANY_PAGES');
}
if (input.mimeType !== 'application/pdf' || first.pageCount <= 1) return first.document;
const documents = [first.document];
for (let page = 1; page < first.pageCount; page += 1) {
  const next = await extractPage(runtime, input.uri, input.mimeType, page, deps);
  if (next.pageCount !== first.pageCount || next.excludedPages !== 0) {
    throw new Error('GEMMA_DOCUMENT_CHANGED');
  }
  documents.push(next.document);
}
const setups = documents.map(doc => doc.setup).filter(value => value !== undefined);
if (setups.length > 1) throw new Error('GEMMA_MULTI_PAGE_SETUP_REVIEW_REQUIRED');
const entries = documents.flatMap(doc => doc.entries as unknown[]);
if (entries.length > MAX_DOCUMENT_ENTRIES) throw new Error('GEMMA_DOCUMENT_TOO_MANY_ENTRIES');
return {
  docType: String(documents.find(doc => doc.docType !== 'other')?.docType || first.document.docType),
  summary: documents.map((doc, index) => `Page ${index + 1}: ${String(doc.summary)}`).join(' '),
  entries,
  ...(setups.length === 1 ? { setup: setups[0] } : {}),
};
```

Thread the deadline/signal parameters from A10 through extractPage; the snippet shows the document logic only. Better reject too many pages immediately after prepare, BEFORE mediaTurn, to avoid wasting one inference. Keep the JS outer check even when native rejects earlier.

UI error mapping: `GEMMA_PDF_TOO_MANY_PAGES` -> “This PDF exceeds the five-page limit. Split it into smaller PDFs; nothing has been imported.” `GEMMA_DOCUMENT_TOO_MANY_ENTRIES` -> “This document exceeds 50 entries. Split it and review each part; nothing has been imported.” Propagate these as terminal review errors through scan/Ask callers. Do not silently fall back to a path that also truncates or claims complete extraction. Never run an accounting write from this error path.

Tests: pages 1/5 succeed if within entry limit; pages6/8 reject, no partial output/import; rows49/50 succeed; rows51/150 reject; multiple setups reject; page count changes midway reject; each staged attachment released after ownership ends. Preserve parsed-document schema protections and transcription-as-data-only behavior.
