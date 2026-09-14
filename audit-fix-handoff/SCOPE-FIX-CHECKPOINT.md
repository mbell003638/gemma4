# Scope owner checkpoint — 2026-09-14

Implementation only. NO tests, typecheck, lint, builds, probes, downloads,
validation scripts, commits or pushes executed by this owner.
Existing dirty changes preserved. Only this lab's assigned scope files changed.

## Step 1 saved

- agentCore.ts: readonly host origin metadata, frozen origin scope on drafts,
  cancellation observed after native cleanup without overriding cleanup failure.
- liveProposalController.ts: clone all draft fields before awaiting scope;
  preserve original request ID; reuse the same store for cancellation; stale
  staging remains terminal even when cancellation fails.
- liveGemmaAsk.ts: capture trusted scope before runtime discovery and enforce it
  when discovery completes and when the agent reads current scope.
- confirmationIntent.ts and app/ask.tsx: one exact-message dispatcher used by
  both pending proposal paths; corrections preserve input and request clarification;
  token checked after asynchronous scope lookup as well as before it.

## Step 2 saved

Screen scope watcher invalidates the epoch and pending proposals when the trusted
scope changes; cancellation/unmount/new asks also invalidate requests. Legacy
Apply checks the proposal's held scope; receipt proposal admission captures the
same scope. Consent completion is rechecked, and stale completion cannot clear a
new request's loading flag. Both pending paths now clarify ambiguous text without
invoking domain handlers. Removed unreachable legacy revision routing.
No commands executing application/test code were run.

## Step 3 saved

Regression code added (NOT EXECUTED):
gemmaScopeBoundaryRegression.test.ts, gemmaConfirmationIntent.test.ts,
gemmaProposalStagingRegression.test.ts, gemmaTerminalFallbackRegression.test.ts.
Cases cover origin retention, changed scope across agent boundaries, stopped
answers, lock/sign-out, cancellation, cleanup failure, staging snapshots,
cancel failure, exact confirms, zero apply calls on ambiguous messages, late
screen epochs and terminal versus unavailable fallback routing.
onDeviceAskProse.test.ts now explicitly mocks unavailable Gemma for its
legacy-only prose cases.

## Resume checkpoint saved

- Source-read both checkpoints, Codex PRE_PHONE_AUDIT and scope handoff.
- Confirmed expected lab branches; preserved other owners' dirty edits.
- Changed agent/staging/onDeviceAsk to the required nested
  proposal: { draft, scope, requestId } contract, with no unscoped fallback.
- Added epoch checks at Apply admission and durable completion; receipt
  processing now rejects stale OCR/analysis/navigation/error/loading updates.
- Added fail-closed requestIsCurrent and revision-aware post-write scope checks.
- Remaining: finish Apply/cancel completion guards, update envelope fixtures,
  add bounded integration regressions, source-review and save final file list.
- No application/test/validation code executed. Main reports bridge/media/build
  integration complete; those files remain outside this owner's edits.

## Final integration saved — 2026-09-14

The preceding resume notes are historical; their remaining implementation is now
saved. Both agent APIs retain their branch-specific callable versus .run forms.
All proposal consumers and identified fixtures use proposal: {draft,scope,requestId}.
Apply completion checks its original request and authority; unmount prevents UI
updates. Cancel cannot race an admitted Apply. Clearing history invalidates the
request, clears both proposal kinds, and ignores stale asynchronous completion.
Receipt processing, delayed speech and pending confirmations retain scope guards.

Additional authored regressions: gemmaDiscoveryScopeRegression.test.ts,
post-write authority checks in gemmaProposalStagingRegression.test.ts, fail-closed
epoch checks in gemmaConfirmationIntent.test.ts, and migrated Manus agent/branch/UI
fixtures. Existing scope-boundary and terminal-fallback suites remain in place.
These are source-level integration/behavior fixtures, not proof of rendered UI
or phone behavior. Run them and the existing UI acceptance checks in the later
validation pass; nothing was executed here.

Scope implementation complete for this handoff; all validation remains UNVERIFIED.
Native matching acknowledgement implementation is saved; see NATIVE-FIX-CHECKPOINT.md.
