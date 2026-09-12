# B2.1B Provider Worker Integration Design

Date: 2026-09-13. Baseline main: d9da7f6694b4dca0a7d52a148b1606d145326f4f. Scope authorized in the B2.1B task; self-review precedes implementation without another approval round.

## Current State Audit

Generation API already validates JSON, Origin/Host/Bearer, idempotency and optimistic versions. GenerationStore has private scheduling/memo/review forms, exclusive directory lock, serialized clone transactions, validation, fsync and atomic snapshots. FakeWorker directly maps scenario/phase into domain events. ProviderAttempt has itemId, binding, attemptNo, stable fake key/job and five submission states but no durable poll schedule or raw provenance. MediaFile refers only to verified read-only fixtures. Review and assets already have separate commands and digest-bound revision invalidation. Quota reserves one demo credit per item, commits success, releases definite failed/cancelled, retains unknown reservations.

Reuse the API and domain review/asset/quota contracts, single Store, FixtureCatalog, AgnesVideoClient request/status/error mapping, checkedMediaUrl/readBoundedMedia, and media-processing readMp4/probeVideo/decodeVideo/processDelivery. Do not instantiate DeliveryStore for generation: it has a separate task model.

Gaps: Worker knows fake outcomes; no ProviderPort; ambiguous submit/restart can currently advance fake acceptance; external IDs are fake-only; pending rather than ProviderAttempt owns scheduling; no provider raw/derivative persistence; media read/review/save only accept fixtures. No real Provider may be selected by normal routing. The existing reconcile outcome command is synthetic evidence, not authority to invent an Agnes outcome.

## Architecture and alternatives

Use one GenerationWorker and a small injected GenerationProvider. Keep FakeWorker as a backwards-compatible constructor/export if required by existing consumers, not a second algorithm. Worker owns business transitions and quota via pure domain functions. Adapter translates only create/get/download. This is smaller than a second provider-specific Worker and safer than an all-in-one generate function because submission and download failures remain distinguishable.

Flow: HTTP -> existing service/store -> durable claim -> ProviderPort.create -> persist external job -> ProviderPort.get -> finalizing -> ProviderPort.download -> raw persistence/inspection -> delivery-v1 -> durable result/COMMIT -> history -> review -> manual save.

No frontend contract or model selector is added. Default dev, all builds and Pages remain MockPlatform. Local HTTP service may inject a provider. Simulation uses the actual Agnes adapter with an injected transport, not a fake success returned by a mocked Store.

## ProviderPort

Server-side files live under packages/generation-api/src/provider. Types below define the contract; equivalent type aliases may share fields.

```ts
interface ProviderCreateRequest {
  request: CreateGenerationRequest;
  itemId: string;
  itemIndex: number;
}
interface ProviderContext extends ProviderCreateRequest {
  attemptId: string;
  externalIdempotencyKey: string;
  submittedAt: string;
  now: number;
  scenario: ScenarioName;
  lastPolledAt?: string;
  cancelRequested: boolean;
  recovery: boolean;
}
type ProviderStatus = 'queued' | 'running' | 'result_ready' | 'failed' | 'cancelled' | 'unknown';
interface ProviderCreateResult { externalJobId: string; status: ProviderStatus }
type ProviderResultReference =
  | { kind: 'https'; url: string; providerReportedSeconds?: number; providerReportedSize?: string }
  | { kind: 'fixture'; fixtureKey: string }
  | { kind: 'text'; text: string };
interface ProviderPollResult { status: ProviderStatus; result?: ProviderResultReference }
type ProviderDownloadedMedia =
  | { kind: 'media'; bytes: Uint8Array; sha256: string; mime: string;
      provenance: 'synthetic_provider_simulation'; fixtureMedia?: MediaFile }
  | { kind: 'text'; text: string };
interface GenerationProvider {
  readonly bindingId: string;
  create(request: ProviderCreateRequest, context: ProviderContext): Promise<ProviderCreateResult>;
  get(externalJobId: string, context: ProviderContext): Promise<ProviderPollResult>;
  download(result: ProviderResultReference, context: ProviderContext): Promise<ProviderDownloadedMedia>;
}
```

Context comes from durable request/attempt/pending, never an in-memory job registry. Fake scenarios belong exclusively to DeterministicFakeProvider. Its first poll can return running, subsequent poll completed to retain deterministic scheduling. Explicit fake recovery may override the simulated unknown/download-failure outcome. Fake cancel confirmation is a simulation result; Agnes has no cancel method and never invents one. Image/copy fixture behavior remains covered. Adapter rejects unsupported Agnes mode, references (no hosted-input resolver in B2.1B), audio or duration combinations before a send, without silently changing input.

ProviderOperationError contains a fixed code, one of invalid_request/unauthorized/not_found/rate_limited/transient/unknown and submission certainty not_submitted/rejected/unknown. It never retains raw exception messages, causes, URLs or transport bodies. A known pre-send rejection settles the failed item and a user retry creates new lineage; there is no automatic create retry.

## Attempt and state transitions

Extend the existing ProviderAttempt, not a duplicate entity. The legacy B1 projection remains compatible; HTTP attempts carry an explicit lifecycle version and attemptId plus providerBindingId, itemId, attemptNo, externalIdempotencyKey, externalJobId, submissionState, providerStatus, createdAt, updatedAt, submittedAt, lastPolledAt, nextPollAt, errorCategory and actualCost=null. Poll status is an allowlisted normalized enum; IDs and optional provider-reported numeric/size fields are bounded and sanitized. Raw and derivative evidence attach to this same attempt.

Pure domain transition validates these semantic states:

not_submitted -> submitting -> submitted -> polling -> result_ready -> downloading -> settled.

submitting -> needs_reconciliation on uncertain send; polling -> needs_reconciliation on unknown status; downloading -> downloading with a paused recoverable error; definite submission rejection or normalized Provider terminal failure -> failed. Existing outcome_unknown is a legacy synonym only. Illegal transitions fail without mutation. settled/failed are terminal and cannot initiate provider actions.

The claim and submittedAt must be persisted before create. A Create response with a known terminal status settles atomically with its external job ID; unknown pauses for reconciliation. Concurrent tick calls coalesce; a persisted claim also prevents two Worker instances using the same Store from sending twice. A lost create response preserves one attempt and reservation and pauses. Restart during submitting becomes needs_reconciliation; it never resumes POST. Provider response persistence must use the claimed attempt identity and current cancel state, so an intervening cancel cannot discard a received job ID and then cause a repeat create.

Polling uses a fixed bounded 100ms interval; lastPolledAt/nextPollAt are durable. queued/running and poll timeouts retain the original job and reservation. Unknown status cannot be treated as definite failed. Restart submitted/polling resumes GET; settled does nothing. Separate-process tests release the Store ownership lock before controlled exit and resume records in a new Node process; abrupt process kill/stale-lock and machine power-loss recovery are not claimed.

## Reconciliation and cancellation

Reuse POST /reconcile. Deterministic fake retains explicit synthetic outcome behavior. For an Agnes attempt with externalJobId, the command schedules GET of that same ID regardless of the UI's proposed synthetic outcome. Without externalJobId, return PROVIDER_OUTCOME_UNKNOWN and retain needs_reconciliation/manual investigation required. No invented idempotency lookup API.

Before submission, cancel releases quota. Once claimed/submitted, retain cancel_requested until an actual normalized terminal result arrives; unsupported provider cancel cannot be declared cancelled. A later completed result follows the existing success race policy. A later confirmed failure releases quota. Fake confirmed cancellation remains a deterministic simulation. Optimistic user commands retain their exact-version checks; asynchronous results reconcile against claim identity without overwriting unrelated changes.

Failed retry creates a new Item/Attempt and retryOfItemId. retry-download schedules only query/download/finalization for the original externalJobId. No path uses create after submitted, unknown or download failure.

## Raw result, media finalization and recovery

URLs are transient memory only. Persist reference kind, checked resultHost, retrievedAt, provider/binding and externalJobId, optional providerReportedSeconds/providerReportedSize, rawSha256, rawActualWidth/rawActualHeight/rawDuration/rawHasAudio/rawFps, downloadedAt, relative raw object key/size and decode verification. Store actualCost=null, not a website price. Public projection includes only safe diagnostic fields; no raw URL/error/token.

A private GenerationMediaRepository stores bytes below the already protected state root using generated relative keys, exclusive writes, hash checks and symlink/path containment. It is injected for service read/review/save and HTTP media responses, with fixture fallback only for verified fixture records. Preserve raw bytes and metadata before running postprocess. The finalizer reuses media-processing's bounded MP4 read, probe and full decode; delivery-v1 creates a distinct derivative in a unique operation directory. Success requires source hash stability and validated derivative metadata. On Linux, raw and derivative files and containing directory entries are synced. Windows Node cannot open directories for fsync, so Windows evidence covers controlled process restart rather than power-loss durability. State publication and quota commit happen only after durable files exist; an orphan file after crash is harmless and not public media until referenced by a committed snapshot.

Postprocess failure preserves raw evidence, remains finalizing, pauses with a stable error and permits retry-download as retry finalization. If raw bytes exist, verify their hash and process them again; if missing/corrupt, requery the original provider job to obtain a fresh URL. Never regenerate. Restart downloading/result_ready re-fetches the original result; restart after raw persistence resumes finalization using a fresh output operation directory. delivery-v1 accepts audio=false only and rejects excessive/short duration or unsupported geometry explicitly. Fake fixture media remains the existing verified path, not an excuse to bypass MP4 processing for simulated Agnes acceptance.

## Persistence compatibility

Keep public DemoSnapshot version 1. Add an explicit private store schema marker/version for HTTP lifecycle fields. Validate all new fields and cross-aggregate relations. On old B2.1A state, perform a deterministic minimal migration: preserve items/ledger/memo/reviews and settled outputs; migrate untouched fake work; treat in-flight submitting as ambiguous; retain known fake IDs for polling/download. Atomically write migrated state only after validation. Unsupported schema is rejected with a stable intelligible error; never reset historical data. Legacy B1 browser state is unchanged.

## Secret and network boundary

Only provider/composition.ts may read AGNES_API_KEY for this new runtime. PROVIDER_MODE defaults fake even if a key exists. agnes mode has a denied adapter by default: REAL_PROVIDER_CREATE_DISABLED, no fallback. B2.1B does not provide a switch that enables real network: true is rejected as outside this stage, and CI + AGNES_REAL_CREATE_ENABLED=true throws REAL_PROVIDER_CALL_FORBIDDEN_IN_CI immediately. Simulated Agnes requires explicit injected transport; no global fetch fallback. Transport accepts only declared Agnes API and synthetic output requests, rejects unknown URLs, and never delegates to network. Correct simulated Bearer is checked internally, never printed. Download has no credentials and rejects redirects/untrusted hosts.

Adapter sanitizes every externally sourced string (including IDs/status/size), not only error.message. Errors stored/public/logged are fixed codes/categories. Runtime-generated sentinel secret-echo tests inspect serialized state, public API, captured logs and sanitized reports. Artifacts whitelist screenshots/scalar reports only, not raw test reporter config or private state. Existing external smoke scripts are not invoked by any B2.1B gate. Real Agnes Create calls: 0.

## Test matrix and acceptance

TDD evidence records command, starting commit, time window, red/green exit, tests/fail/skips and raw log path under ignored .ai/evidence/B21B. Contract tests cover Port and every legal/illegal attempt transition. Actual Store/Worker tests cover ambiguous create and no second tick send; concurrent tick; stale cancel during create; known pre-send rejection/new lineage; queued/running restart; submitting restart; unknown/poll timeout; terminal failure/quota; download retry same job; malformed/hash-invalid MP4; raw-valid nonconformant derivative; postprocess failure/raw retained/restart; settled no actions. Existing HTTP/review/manual-save/invalidation regressions stay enabled.

Agnes adapter transport tests cover 400/401/429/503, malformed payload, create/poll timeout, unknown status, both result URL shapes, completed without usable URL, and secret echo. An actual HTTP -> Store -> Worker -> AgnesProvider -> injected transport -> synthetic MP4 -> real FFmpeg -> history/review/manual save/revision integration produces a safe report and browser screenshot. CI identifies Provider simulation / Real provider calls: 0.

Final Linux Actions on exact PR HEAD must run verify, B1 E2E, HTTP E2E, Delivery (unchanged symlink test), Delivery UI and Provider integration. Inspect actual artifacts, obtain independent high review and resolve all Critical/P1/P2, then guarded squash and observe main again. No skip/continue-on-error/ignored nonzero exit/assertion weakening.

## Non-goals

Real Agnes Create (B2.1C only), PostgreSQL, object storage, Redis, distributed queue, Auth/Workspace, payment/actual billing, multiple production providers, production routing, cloud/public deployment. Agnes remains smoke_tested and runtimeEligible=false. Synthetic media/score is not a real quality evaluation. Stop after B2.1B merge/acceptance.

## Self-review

Reviewed against task sections 0-62: concrete interfaces, all lifecycle/failure/media/security/restart boundaries assigned, no unresolved product-contract conflict, no real-call capability or placeholders. The fake-only reconcile contract is preserved for fake while provider reconciliation relies on original job evidence. Audio requests unsupported by delivery-v1 are rejected, not silently muted.
