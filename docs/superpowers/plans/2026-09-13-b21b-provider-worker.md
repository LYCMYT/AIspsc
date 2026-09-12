# B2.1B Provider Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Integrate a durable Provider-neutral Worker and simulated Agnes end-to-end, with zero real Provider calls.

**Architecture:** One Worker orchestrates a small injected create/get/download port. Existing Store/domain remain business authority; a private media repository bridges raw output and delivery-v1 into existing review/manual-save.

**Tech Stack:** Existing TypeScript/Node 24.19.0, pnpm 12.3.4, Vitest, Playwright, FFmpeg. No new dependency or runtime infrastructure.

**Spec:** docs/superpowers/specs/2026-09-13-b21b-provider-worker-design.md

## Execution checkpoint

Tasks 1–6 implemented and committed through 2995c8b. Independent scoped reviews approved after reproduced fixes. Local full gates: verify 492 passed; B1 E2E 74; HTTP E2E 11; Provider integration 20; Delivery UI one scenario/eight checks. Windows Delivery remains 9 passed/1 EPERM failed/0 skipped/exit 1; Linux validation is required. Final whole-branch review and final-head remote release are pending at this committed checkpoint; their evidence belongs to the final PR and ignored acceptance ledger.

Actual Provider integration contains real FFmpeg media/recovery, four HTTP/browser/secret cases and five controlled separate-process restart cases. No abrupt-kill or power-loss lock recovery claim. Report hashes bind delivery metadata to the private attempt; fixed branded errors preserve safe certainty across independent server module loaders.

## Global Constraints

Real Agnes Create calls: 0. Agnes remains smoke_tested / runtimeEligible=false. Existing MockPlatform production/default behavior unchanged. No automatic POST retry, no outcome invention, no signed URL/key persistence, no weakening existing tests. Scope excludes B2.1C. Use npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm when local global pnpm differs. All evidence stays ignored under .ai/evidence/B21B. Shared test/config changes are limited to adding named Provider integration and hard network guards.

## Task 1: Provider port and deterministic implementation

Files: create packages/generation-api/src/provider/{port.ts,types.ts,fake-provider.ts,port.test.ts}. Consume CreateGenerationRequest/MediaFile/ScenarioName and FixtureCatalog. Produce GenerationProvider, ProviderContext, ProviderOperationError and result DTOs exactly as specified.

- [x] Write port behavioral tests using actual FixtureCatalog and DeterministicFakeProvider; exercise copy/image/video, queued/running/result_ready/unknown/failure/cancel and explicit recovery. Demonstrate download verifies actual bytes.
```ts
const created = await provider.create({ request, itemId, itemIndex: 0 }, context);
expect(created.externalJobId).toBe(`fake-job-${itemId}`);
expect(await provider.get(created.externalJobId, { ...context, lastPolledAt: undefined })).toMatchObject({ status: 'running' });
const ready = await provider.get(created.externalJobId, { ...context, lastPolledAt: context.submittedAt });
expect(ready.status).toBe('result_ready');
```
- [x] Run `pnpm exec vitest run --project unit packages/generation-api/src/provider/port.test.ts`, preserve RED.
- [x] Implement only DTOs, stable errors and stateless fixture adapter; no Store/quota mutation in Provider.
- [x] Run GREEN, independent interface review, scoped commit.

## Task 2: Attempt lifecycle and store validation/migration

Files: modify packages/contracts/src/{generation.ts,http.ts}; create packages/domain/src/provider-attempt.ts and tests/provider-attempt.test.ts; extend packages/generation-api/src/store.ts and store.test.ts. Consume existing ProviderAttempt/GenerationState; produce pure checked transition and HTTP lifecycle normalization/validation. Keep browser version 1 and strict private schema version.

- [x] Write legal/illegal transition and old snapshot migration tests, including interrupted submitting, submitted IDs, settled history, unknown schema, malformed timestamps/IDs/status/provenance and invalid quota cross-relations.
```ts
expect(() => transitionAttempt(attempt, 'settled', now)).toThrow('INVALID_ATTEMPT_TRANSITION');
expect(attempt.submissionState).toBe('not_submitted');
```
- [x] Run focused contracts/domain/store tests RED, implement transitions and transactional migration, then GREEN.
- [x] Independent high review of transition/validation/duplicate-create boundaries; commit resolved task.

## Task 3: One Worker using the port

Files: packages/generation-api/src/worker.ts, packages/domain/src/provider-commands.ts, provider-worker.test.ts and worker-recovery.provider.test.ts, packages/domain/src/generation-commands.ts, targeted worker/domain tests. Preserve FakeWorker as compatible composition alias only. Consume port/context and transitions; produce injected GenerationWorker(store, provider, dependencies) with tick/start/stop/status, plus backward-compatible fixture constructor.

- [x] Write injected provider tests proving worker calls create/get/download without concrete fake scenario interpretation. Test coalesced concurrent ticks and two workers sharing the same Store.
```ts
await Promise.all([worker.tick(), worker.tick()]);
expect(createCalls).toBe(1);
expect(store.read().attempts).toHaveLength(1);
```
- [x] Write lost-response test before implementation: throw a submission-unknown ProviderOperationError after incrementing createCalls. Assert needs_reconciliation, reservation retained, one attempt; repeat tick/restart and assert createCalls still 1.
- [x] Implement durable claim-before-create, response publication against attempt identity, fixed error mapping and queued/running/poll scheduling. Tests must include cancellation during awaited create and preserve received job ID.
- [x] Write/reproduce restart during submitting/submitted/polling/settled and polling timeout/unknown. Implement resume GET or pause; never POST again. Persist nextPollAt with bounded interval.
- [x] Extend reconcile/retry-download to schedule original job only; no-ID Agnes remains unknown. Preserve fake explicit synthetic outcomes, failed retry lineage, existing quota/cancel race and review semantics.
- [x] Run focused GREEN, then `pnpm verify`, `pnpm test:http:e2e` as refactor safety gates; do not weaken existing races/timeouts. Independent high review and scoped commit.

## Task 4: Private raw and derivative media

Files: create packages/generation-api/src/media-repository.ts and media-repository.provider.test.ts; adjust service.ts/server.ts for injected media reader; use GenerationWorker finalization hook. Consume ProviderDownloadedMedia, ProviderResultReference, VideoFacts/processDelivery. Produce GenerationMediaRepository readMedia, captureRaw, finalize methods with typed immutable evidence.

- [x] RED: actual synthetic 1280x704, 121-frame, AAC MP4; hash/inspect/decode; assert raw retained and derivative 1280x720, 120 frames, 5s, no audio. Tampered hash and malformed MP4 must fail.
```ts
expect(raw.rawActualHeight).toBe(704);
expect(result.media.height).toBe(720);
expect(result.media.hasAudio).toBe(false);
expect(await readFile(rawPath)).toEqual(originalBytes);
```
- [x] RED: failed processing retains raw evidence/finalizing; restart and retry uses new derivative operation directory, unchanged job and createCalls=1. Result metadata and COMMIT only after durable derivative.
- [x] Implement contained relative files, no symlinks, bounded bytes, exclusive durable write and hash validation; reuse all media-processing tools. Add fixture fallback only for fixture records; verify generated reference/review/save digest checks still work.
- [x] GREEN actual-media integration; independent high review of durability and path boundary; commit.

## Task 5: Simulated Agnes and secret-safe composition

Files: provider/{agnes-provider.ts,composition.ts,agnes-provider.test.ts,composition.test.ts}; test utility FakeAgnesTransport. Reuse packages/provider-agnes client/helpers. Modify existing package only if a regression proves necessity. Composition root is sole new runtime env-key reader.

- [x] RED injected transport verifies Bearer/payload/GET video_id, queued/in_progress/completed/failed, both URL shapes, all 400/401/429/503, invalid body, timeout, unknown status, missing URL and malformed media. Unknown request rejects without network fallback.
- [x] RED environment cases fake+key, agnes+disabled, enabled outside stage, CI+enabled. Expected fixed denial and zero transport calls.
```ts
expect(() => composeProvider({ env: { CI: 'true', AGNES_REAL_CREATE_ENABLED: 'true' }, fixtures }))
  .toThrow('REAL_PROVIDER_CALL_FORBIDDEN_IN_CI');
```
- [x] RED secret echo in messages, status, job ID and result metadata; verify state/snapshot/captured logs contain no runtime sentinel. Preserve exact existing Agnes redaction behavior.
- [x] Implement wrapper with no global fetch fallback, bounded validated strings and fixed errors. get/download never contain business retry/quota decisions. GREEN and independent review; scoped commit.

## Task 6: Actual HTTP simulated Provider acceptance and CI

Files: packages/generation-api/tests/http-provider.provider.test.ts, worker-process-restart.provider.test.ts and helpers/worker-restart-child.mjs; package.json/vitest.config.ts/.github/workflows/provider.yml; scripts/provider-ci-guard.mjs if needed. Hook composition in server/start while protecting public builds. Consume actual startGenerationApi and simulated Agnes transport, private media repo and real FFmpeg.

- [x] RED real HTTP submit -> persisted attempt -> create/poll/download -> raw/derivative -> history. Browser reads local API, plays actual synthetic video, approves without asset, manually saves, revises hard failure and observes invalidation. Check page/console errors and storage token absence; do not mock persistence or postprocess success.
- [x] Implement `pnpm test:provider:e2e` with one named Vitest project (separate from unit/HTTP defaults), real FFmpeg and Playwright where appropriate. Safe JSON/screenshot artifact reports tested git HEAD, simulation label, realCalls=0, stage counts, raw/derived facts, review/save/invalidation/errors/storage observations.
- [x] Add CI guard to all ordinary gate entry paths and provider workflow. Exact PR-head checkout, Node 24.19.0, pnpm 12.3.4, frozen lockfile, real FFmpeg/Chromium. Only whitelisted safe artifacts; no raw state/reporter/token or ignored evidence in Git.
- [x] Run focused GREEN and independent integration/security review; commit.

## Task 7: Documentation, final review and remote release

Files: docs/15_B21B_PROVIDER_WORKER.md, concise README progress/navigation; update this plan status and actual scope if implementation names differ. Audit original required docs through delegated read-only report plus source review.

- [x] Write exact operation/recovery/schema/security and non-goal docs. No claim integrated or real AI quality; preserve actualCost null.
- [x] Run full local verify, B1 E2E, HTTP E2E, Delivery, Delivery UI, Provider integration with evidence metadata. Windows symlink EPERM remains failure, not skipped or concealed; Linux must pass unchanged.
- [ ] Independent final GPT-6 high full-branch review; fix each established Critical/P1/P2 with failing regression and rerun affected full gates.
- [ ] Check clean scoped diff, all introduced objects/paths for secrets/local data, commit final HEAD, normal push and PR to main. No force main.
- [ ] Wait for all six final-HEAD Linux gates. Download and actually inspect screenshots/reports/traces if present; record run IDs/counts/exit. Any code/config/test/workflow change requires fresh final-head gates.
- [ ] Guarded squash only after green gates, artifact inspection, no unresolved critical review and clean branch. Observe main workflows to completion, record merge SHA and final report sections 1-13. Stop; no B2.1C.

## Self-review

Task interfaces use the Spec's exact Port types. Tasks 2-3 own business lifecycle/store, Task 4 owns private media, Task 5 owns adapter and composition, Task 6 owns real simulated end-to-end and guards. Every requested fault has a test owner; no placeholder scope or real-call opt-in. Independent work may proceed after port signatures are committed, with disjoint file ownership. Plan validation is self-review, not falsely labeled independent review.
