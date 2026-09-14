# Phase 1 — A01/A02, both labs

## Files to read/change

Within each lab: `frontend/src/accountingV2/gemma/agentCore.ts`, `liveProposalController.ts`, `liveGemmaAsk.ts`, `frontend/src/accountingV2/onDeviceAsk.ts`, `frontend/app/ask.tsx`, and their Gemma tests. Inspect `proposalStore.ts` and `proposalExecutor.ts` before adding locking; their existing database mutex/SAVEPOINT machinery must not be nested into a non-reentrant deadlock.

Codex `createAgent(engine)` returns a callable run function. Manus returns `{run,isBusy,recover}`. Preserve each public API. Do not transplant one agent core over the other.

## A01: originating-scope envelope

Keep `Draft` as the preparation DTO so all proposal tools do not need to invent scope. Add this complete type next to it:

```ts
export type ScopedDraft = {
  draft: Draft;
  scope: Scope;
  requestId: string;
};
```

Change the proposal member of `AgentResult` from `{kind:'proposal'; draft:Draft; evidence:Observation[]}` to include `proposal: ScopedDraft` instead of `draft`. Update all consumers and fixtures; no compatibility fallback to an unscoped `Draft` is allowed.

At the actual proposal return in `turn`, replace the return expression with:

```ts
return {
  kind: 'proposal',
  proposal: {
    draft: JSON.parse(JSON.stringify(draft)) as Draft,
    scope: { ...scope },
    requestId: options.requestId,
  },
  evidence,
};
```

The JSON clone is valid here because normalized values use the validated JSON types; it isolates mutable preparation data. Scope is captured by trusted host code, never copied from native output. Freeze the original scope at capture (`Object.freeze({...value})`) if compatible with types; Scope has only primitive fields.

### Check the boundary after cleanup, including plain answers

Capture one `originScope` inside the run's existing try block, under its AbortSignal/deadline, BEFORE entering `turn`. Extend the internal `turn` signature to receive this scope instead of recapturing it internally. All existing `assertCurrent` calls compare against that same copy. Keep origin outside the try as `let originScope: Scope | undefined` for final validation.

After successful native cleanup, before returning any answer/proposal/clarification, use this logic (adapt Codex's final ternary and Manus's explicit return):

```ts
if (!originScope) return { kind: 'stopped', code: 'STALE_SCOPE' };
if (options.signal?.aborted || controller.signal.aborted) {
  return { kind: 'stopped', code: 'CANCELLED' };
}
try {
  // Reuse bounded cleanupStep to bound this final trusted lookup too.
  let finalScope: Scope | undefined;
  await cleanupStep(async () => { finalScope = await options.currentScope(); });
  if (!finalScope || !sameScope(originScope, finalScope)) {
    return { kind: 'stopped', code: 'STALE_SCOPE' };
  }
} catch {
  return { kind: 'stopped', code: 'STALE_SCOPE' };
}
return outcome;
```

Do not let this override NATIVE_RECOVERY_REQUIRED when cleanup failed. Preserve the branch's busy/recovery policy. Leave cancellation observable during cleanup: check the original signal after cleanup even if its event handler/timer was removed earlier. A delayed successful scope lookup must not cause a later stale outcome to become visible.

### Staging replacement

Change controller import to `type ScopedDraft`. Replace its staging function with this reference body; it fits both branches' existing `db()`, `currentScope()`, `ProposalStore`, and `cancelProposal` helpers:

```ts
export async function stageLiveProposal(input: ScopedDraft): Promise<DurableProposalPreview> {
  const { draft, requestId } = input;
  const scope = { ...input.scope };
  if (!LIVE_GEMMA_PROPOSALS.has(draft.operation)) throw new Error('PROPOSAL_NOT_LIVE');
  if (!requestId || !sameScope(scope, await currentScope())) throw new Error('STALE_SCOPE');
  const store = new ProposalStore(db());
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const stored = await store.create({
    id: `proposal-${nonce}`, requestId,
    operation: draft.operation, normalized: draft.normalized,
    scope, entityVersions: draft.entityVersions,
  });
  try {
    if (!sameScope(scope, await currentScope())) throw new Error('STALE_SCOPE');
  } catch (error) {
    // Even if this cancellation fails, the row stays scoped to its ORIGINAL
    // book and confirm-time checks must reject it in a different context.
    await cancelProposal(store, stored.id);
    throw error;
  }
  return { id: stored.id, preview: draft.preview, destructive: draft.destructive };
}
```

This does not pretend an asynchronous UI scope can be locked by a SQLite savepoint. It prevents reassignment, validates before/after persistence, and retains independent confirmation-time checking. Do not change `proposalExecutor` to trust preview/UI authorization. Retain its mutex, digest, expiry, permissions, entity revisions, period checks, and exactly-once transaction.

Update `onDeviceAsk.ts` to call `stageLiveProposal(gemma.proposal)`. Treat STALE_SCOPE, CANCELLED, and NATIVE_RECOVERY_REQUIRED as terminal outcomes with a safe message, not triggers for a legacy optional-model fallback. Its current broad catch must distinguish unavailable runtime from these terminal boundary failures. Do not expose native paths/stack traces in messages. Add a monotonically increasing screen request token; increment on scope change, unmount, cancellation and new ask, then compare before appending assistant messages or setting pending proposal. Read the same trusted book/permission context as liveScopePorts/liveBookContext; do not infer scope from labels.

## A02: exact confirmation classifier

Add `frontend/src/accountingV2/gemma/confirmationIntent.ts` in each lab:

```ts
export type ConfirmationIntent = 'confirm' | 'cancel' | 'other';
const confirmations = new Set([
  'yes', 'y', 'i confirm', 'confirm', 'apply', 'proceed', 'ok', 'okay',
  'please apply', 'please record', 'please enter', 'please save',
]);
const cancellations = new Set(['no', 'n', 'cancel', 'stop', 'discard', 'never mind', 'nevermind']);
export function confirmationIntent(value: string): ConfirmationIntent {
  // Remove terminal punctuation only; never discard meaningful words.
  const text = value.trim().toLowerCase().replace(/[.!]+$/, '').trim().replace(/\s+/g, ' ');
  if (cancellations.has(text)) return 'cancel';
  if (confirmations.has(text)) return 'confirm';
  return 'other';
}
```

In `ask.tsx`, replace both durable AND legacy proposal prefix regexes with this classifier. Do not accidentally leave the legacy write branch permissive. Use existing cancel handlers for `cancel`; existing durable confirm-by-ID handler for `confirm`. While a proposal is pending, `other` must not execute it: show a clarification or route an explicit edit flow that invalidates the old proposal before creating a new one. Keep typed corrections intact. Disable duplicate Apply while applying; backend exactly-once remains required.

New executable test file `frontend/__tests__/gemmaConfirmationIntent.test.ts`:

```ts
import { confirmationIntent } from '../src/accountingV2/gemma/confirmationIntent';
test.each(['yes', 'YES!', 'i confirm', 'okay.', 'please apply'])('exact confirmation %s', text => {
  expect(confirmationIntent(text)).toBe('confirm');
});
test.each(['no', 'cancel', 'never mind'])('explicit cancellation %s', text => {
  expect(confirmationIntent(text)).toBe('cancel');
});
test.each(['yes, but make it 500 instead', 'okay cancel it', 'proceed only after I check',
  'yes please change the book', '"yes"', 'do not apply', 'not okay', 'yes?', 'apply?'])('not authority: %s', text => {
  expect(confirmationIntent(text)).toBe('other');
});
```

## Required integration regressions

- Production agent prepares Book A expense, `finish` changes to B: stopped/STale, no staging under B, no fallback model call.
- Direct staging receives an A envelope while B is current: zero `store.create` calls.
- Scope changes during create: row remains under A, cancellation attempted, no preview shown.
- Successful same-scope envelope retains ORIGINAL request ID and scope in storage.
- Actor, location, feature epoch, permission epoch, revision changes during cleanup and lock/sign-out reject results.
- Plain answer arriving after scope change is not displayed.
- `okay cancel it`, conditional and amount-edit messages cause zero apply/domain writes in BOTH pending proposal paths. Test handlers, not only regex source strings.
- Existing replay/expiry/digest/SAVEPOINT rollback tests remain passing. Do not delete tests because AgentResult changed; update fixtures to construct host envelopes.

Reuse `gemmaAgentCore.test.ts`, `gemmaDurableUi.test.ts`, `gemmaConfirmationPersistence.test.ts` and `gemmaProposals.test.ts` fixtures. Test signatures differ across labs; keep the Codex callable and Manus `.run()` forms.
