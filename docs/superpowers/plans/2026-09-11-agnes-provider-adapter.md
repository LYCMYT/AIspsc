# Agnes Provider Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side Agnes Video V2.0 provider adapter and a manual, secret-safe real smoke-test path without enabling Agnes in production routing.

**Architecture:** Keep the existing B1 browser `MockPlatform` untouched. Agnes lives in an isolated server-side adapter module with deterministic fake-fetch tests. A separate manual GitHub Actions workflow reads `AGNES_API_KEY` from Repository Secrets and executes exactly one fixed smoke task; the runtime binding candidate remains disabled until smoke/evaluation gates are satisfied.

**Tech Stack:** TypeScript 6, Node.js 24 fetch, Vitest 5, GitHub Actions, existing pnpm workspace.

**Spec:** `docs/11_AGNES_PROVIDER_INTEGRATION.md`

## Global Constraints

- Never commit, log, screenshot, or persist a real Agnes API key.
- The Vue frontend must not receive the Provider key.
- Real provider execution is manual only; push/PR must remain deterministic and free of paid/external model calls.
- `POST /v1/videos` must not be automatically retried after ambiguous failures.
- Real routing eligibility stays false until smoke and later integration gates are completed.

---

### Task 1: Deterministic Agnes API mapping

**Files:**
- Create: `packages/provider-agnes/src/index.ts`
- Create: `packages/provider-agnes/src/index.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `buildAgnesVideoCreateBody`, `normalizeAgnesVideoStatus`, `AgnesVideoClient`, `AgnesProviderError`.

- [x] Write tests for documented request mapping and unsupported parameter rejection.
- [x] Verify tests fail while the adapter implementation is absent.
- [x] Implement request/status/error normalization.
- [x] Verify unit tests pass.

### Task 2: Provider secret safety

**Files:**
- Modify: `packages/provider-agnes/src/index.ts`
- Modify: `packages/provider-agnes/src/index.test.ts`

**Interfaces:**
- Consumes: `AgnesVideoClient`.
- Produces: secret-redacted provider errors.

- [x] Add a failing regression test where the provider echoes the configured dummy key.
- [x] Verify the regression test fails for the expected leaked message.
- [x] Redact the configured key from HTTP error text and failed-task error text.
- [x] Verify deterministic tests pass.

### Task 3: Manual real smoke runner

**Files:**
- Create: `packages/provider-agnes/scripts/smoke.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `AGNES_API_KEY` environment variable.
- Produces: `artifacts/agnes-smoke/smoke.json` and, on success, `result.mp4`.

- [x] Require `AGNES_API_KEY` without providing any fallback secret.
- [x] Submit one fixed 5-second 720p text-to-video task.
- [x] Freeze returned `video_id` and poll only that external task.
- [x] Download final result, compute SHA-256, and write sanitized evidence.
- [x] Keep smoke artifacts ignored by git.

### Task 4: Manual GitHub Actions smoke entrypoint

**Files:**
- Create: `.github/workflows/agnes-smoke.yml`

**Interfaces:**
- Consumes: GitHub Repository Secret `AGNES_API_KEY`.
- Produces: short-retention sanitized Actions artifact.

- [x] Use `workflow_dispatch` only.
- [x] Run deterministic `pnpm verify` before the provider call.
- [x] Fail explicitly when the Secret is absent.
- [x] Upload sanitized smoke evidence with seven-day retention.

### Task 5: Capability evidence and routing gate

**Files:**
- Create: `contracts/agnes-video-v20.binding-candidate.json`
- Create: `docs/11_AGNES_PROVIDER_INTEGRATION.md`
- Modify: `docs/09_MODEL_CAPABILITY_MATRIX.md`
- Create: `packages/provider-agnes/README.md`

**Interfaces:**
- Produces: documented, non-runtime Agnes binding candidate.

- [x] Record exact create/query/model/status contracts.
- [x] Limit candidate capabilities to the currently verified safe subset.
- [x] Keep `runtimeEligible=false` before real smoke evidence.
- [x] Keep Agnes outside the original Seedance/Kling 4×2 evaluation because the verified capability intersection differs.

### Task 6: Verification

- [x] `pnpm install --frozen-lockfile` succeeds without changing the existing dependency lock.
- [x] `pnpm verify` succeeds on GitHub Actions.
- [x] New Agnes unit tests pass, including the redaction regression.
- [x] Existing Playwright E2E suite succeeds.
- [ ] Real `agnes-smoke` succeeds after a rotated key is configured as GitHub Repository Secret `AGNES_API_KEY`.
