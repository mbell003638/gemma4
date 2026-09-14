# Audit repair handoff: start here

Current status, 2026-09-14: the implementation below has been integrated in the
isolated labs, with regression sources authored but not executed. Start with
FINAL-IMPLEMENTATION-HANDOFF.md for the current finding map and deferred validation.
The original plan and prompt below are historical; they do not override the owner's
latest instruction not to run tests/builds or to commit/push.

Prepared 2026-09-12. This package is a **plan with reference implementation code**, not applied fixes. Code fences are not compiled application code. The implementation agent must integrate each block at the named seam, run its regression tests, and record evidence. Do not mark a finding fixed just because a snippet was pasted.

## Copy this prompt to the implementing agent

> Implement the audit repairs specified in `C:\Users\just2\Downloads\Ledger AI Codex\gemma4-lab\audit-fix-handoff\00-START-HERE.md`. Read that file and its phase documents first. Work only in the two existing isolated labs, preserving their different APIs and accounting semantics. Complete all host-verifiable phases, including standalone Gemma-enabled APK builds if the installed toolchain permits. Do not connect a phone, download model weights, commit, push, publish, change main/the non-downloadable AI product, disable tests, bypass metadata checks, or weaken model integrity/permission checks. Use the supplied audit probes as evidence to convert into correctness regressions, not as passing readiness tests. Do not silently substitute an unrelated fallback model after a stale-scope or cancelled request. Update `REPAIR_STATUS.md` after each phase with exact commands, outcomes, files and remaining blockers. Finish with separate Codex and Manus results; phone acceptance remains explicitly pending.

## Paths and branch safety

| Product | Working directory | Expected local branch | Audit baseline HEAD |
|---|---|---|---|
| Codex downloadable AI | `C:\Users\just2\Downloads\Ledger AI Codex\gemma4-lab` | `codex/gemma4-p0-p3` | `badb3c738abda0ac70c875c44ccdbe078dcf02c2` |
| Manus downloadable AI | `C:\Users\just2\Downloads\Ledger AI Codex\gemma4-manus-lab` | `codex/manus-gemma4-p0-p3` | `5b00321e6a90e9016d59c0179bec16cdc6a7a33c` |

The dirty worktree includes the implementation being repaired. **Do not reset, stash, clean, check out another branch, copy whole trees, or recreate either worktree from HEAD.** A new branch from HEAD alone loses the uncommitted integration. If HEAD or the working files changed, inspect the delta and adapt; a changed hash is not permission to discard another agent's work. Coordinate if another agent is writing the same files. No root checkout edits. Do not install more SDKs or accept new license terms without the owner handling any required consent.

## Reading order and batches

1. Read each lab's `PRE_PHONE_AUDIT.md`; the Codex report contains the full A01–A13 evidence.
2. [01 — Scope and confirmation](01-SCOPE-AND-CONFIRMATION.md): A01/A02, both labs.
3. [02 — Accounting and paging](02-ACCOUNTING-AND-PAGING.md): A06/A08/A09 Codex, A07 Manus.
4. [03 — Native lifecycle](03-NATIVE-LIFECYCLE.md): A03/A04/A10 native half, both labs; A13 production checks, Manus.
5. [04 — Media lifecycle and document limits](04-MEDIA.md): A10 JavaScript half/A11, both labs.
6. [05 — Build and acceptance](05-BUILD-AND-ACCEPTANCE.md): A05/A12 and all final gates.

Work one phase in one lab at a time. Port a fix to the other lab only after understanding its different interfaces. Run focused tests before moving on. Final all-suite validation is mandatory in both. Never parallelize two writers to `agentCore.ts`, `gemmaNative.ts`, `mediaTasks.ts`, or the native bridge in the same lab.

## Architectural decisions already made for you

- Bind a **host-generated proposal envelope** to the original scope/request; do not make tool/model output authoritative for scope.
- Use exact whole-message confirmations, or the existing explicit Apply button. Corrective/conditional text cannot post.
- For paging, retain existing output contracts and scope-bound outer cursor validation. Use stable unique row identities; do not compare cursor IDs to a different identity.
- Account role projections use only that role's receivable/payable and advances accounts. Keep location and book predicates.
- Reject oversized PDFs/combined extraction outputs explicitly for now; do not build a complex partial-import UI or silently slice.
- Keep one native execution owner and fail closed on uncertain cleanup. A JavaScript timeout is **not** proof that JNI stopped.
- Reverify existing installed files locally; never initiate a network download as a side effect of status lookup.
- Preserve Needle and legacy packs. Keep media capabilities disabled until their later device gates pass.
- Keep the current conditional Kotlin/LiteRT toolchain. Do not restart the already resolved metadata investigation or bump all products globally.

## Fresh audit baseline (not future acceptance)

Codex: 141 Jest suites / 1,114 tests. Manus: 148 / 1,271. Types, standard Expo lint, Android JS export passed in both. Broader `eslint .` has historical configuration/vendor failures. Saved Gemma APKs are Metro-dependent debug packages. No real model/device test passed. Six audit subagents stopped at usage limits; the coordinating auditor performed the reported probes.

## Reproduction and status discipline

Audit probes: `gemma4-lab/artifacts/audit-2026-09-12/reproduce-findings.cjs` and `PackRestartAudit.kt`. The JS script loads either lab when supplied its absolute path. Its exit 0 currently means **bad behavior reproduced**. Preserve it as historical evidence and add expected-correctness tests under each branch's `frontend/__tests__`. Do not weaken the reproduction to make it green.

Create `REPAIR_STATUS.md` in this folder before implementation; mirror a Manus-specific record in the Manus handoff folder. **The owner requires a persistent save after every coherent step**, not only at phase completion: record the exact files changed, command/result, pending work and next action before moving on. Resume from these records rather than repeating completed exploration. For each A01–A13 record: applicable lab, failing regression before fix, files changed, focused test command/result, final gate result, and host/device limitations. A failure to compile/run is BLOCKED, not PASS. A snippet that has not been integrated is PLANNED, not DONE. No field should say fixed without a corresponding correctness test or artifact inspection.

## Completion definition

All applicable A01–A13 have implementation and host evidence; both branches compile/test independently; explicitly opted-in standalone APKs include the new JS, Needle and LiteRT; default builds still compile without LiteRT; no source files outside these labs were changed; nothing committed/pushed. Device inference, downloads on real storage/network, memory/heat/performance, 16 KB runtime, media quality and offline TTS remain honestly unverified until owner connects a phone.
