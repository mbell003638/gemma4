# Persistent task checkpoint

Updated: 2026-09-12. User requests saving progress after every step to conserve credits and support resumption.

## Current task

Prepare a full repair handoff, including code, for a lower-capacity agent to implement audit findings A01–A13. Documentation only in isolated labs; do not apply product repairs, commit or push.

## Completed steps

1. Re-read current scope/proposal, accounting/paging, native bridge/store/session, media, build configuration and test seams in both branches.
2. Saved master start file and copy-paste implementing-agent prompt: `00-START-HERE.md`.
3. Saved Phase 1 scope and confirmation types/replacement bodies/tests.
4. Saved Phase 2 branch-specific SQL/paging reference fixes and accounting agreement tests.
5. Saved Phase 3 native verification/removal/recovery/admission code and production-test migration requirements.
6. Saved Phase 4 bounded media lifecycle code, fail-closed document bounds and UI/test requirements.
7. Saved Phase 5 CMake/build/workflow/reference APK checks and final acceptance commands.
8. Saved Manus-specific entry point under `gemma4-manus-lab/audit-fix-handoff/00-START-HERE.md`.

9. Verified all five phase links exist, Markdown code fences are balanced, and A01–A13 are covered. PowerShell documentation validation exited successfully. Checked production remove return type and both AgentResult/Page interfaces against the reference code seams. Both expected lab branches remain selected; handoff folders are untracked local documentation.

## Current state / next exact step

2026-09-13 update: owner authorized implementation but explicitly deferred all testing to Luna. Applicable production/configuration edits from A01–A12 are saved in both labs; see branch-specific REPAIR_STATUS.md. No tests, lint, typechecks, builds, exports or artifact checks were run. A13 test-harness migration, regression/fixture work, verification and APK generation remain in LUNA-VERIFY-NEXT.md. Do not regenerate the handoff or infer untested edits are verified fixes. No commits/pushes.

## Important limits

Reference code is not compiled/applied. Some integration seams intentionally require implementation (native poisoned-state policy, production runtime injection, UI request token and test fixture adaptation); the phase text calls these out. No product tests/builds are claimed for this documentation-only turn. Existing audit findings remain unfixed. The previous audit's tests passed despite reproduced defects; do not call the app ready.

## Resume protocol

Read this file and `00-START-HERE.md` first. Do not repeat completed source exploration or regenerate the package from scratch. After every coherent edit/check, append or update completed steps, exact next action and command outcome here. During later implementation, keep `REPAIR_STATUS.md` in each lab with per-finding proof and pending gates. Never treat a checkpoint as a successful test.
