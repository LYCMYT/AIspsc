# B2.1A Controlled HTTP Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local HTTP implementation of the existing DemoPlatform backed by persistent generation state and an autonomous deterministic fake worker, through review and explicit manual save.

**Architecture:** Keep production/default B1 on MockPlatform. A development-only HttpPlatform reaches a guarded loopback Node HTTP service through a same-origin Vite proxy; pure domain reducers operate on serial, atomic file snapshots containing tasks, quota and durable fake work. A separate worker module runs its own timer in the same server process.

**Tech Stack:** Existing pinned Node.js 24.19.x, pnpm 12.3.4, TypeScript, Vite, Ajv, Vitest and Playwright; no new runtime dependencies. Use the repository lockfile and record actual environment versions in evidence.

**Spec:** `docs/superpowers/specs/2026-09-12-b21a-design.md`.

## Global Constraints

- Scope authority is supplied takeover specification sections 30–32: B2.1A only; no Agnes Create or other paid call.
- `runtimeEligible=false` and `smoke_tested` remain unchanged.
- Public Pages and production builds always select MockPlatform; HttpPlatform requires `import.meta.env.DEV && import.meta.env.MODE === 'local-http'`.
- Formal project name: 多模型 AI 营销视频生产平台; no model/reference-strength frontend selectors.
- Trimmed prompt is required; duration is an integer 5–15 seconds; reject unsupported parameters without mutation or fallback.
- Review approval never saves automatically; revisions invalidate saved assets; subsequent approval still requires manual save.
- No new dependencies; exact existing lockfile versions remain authoritative.
- Operator token lives only in local server/proxy memory, never browser storage, bundles, logs or API bodies.
- Keep `pnpm verify`, `pnpm test:e2e`, `pnpm test:delivery` and `pnpm test:delivery:ui`; add HTTP coverage without weakening existing checks.
- Current main has no `docs/02_UI_CONTRACT.md`: preserve existing Chinese UI text and use actual DOM controls; no invented contract document or screenshot-based UI.
- No changes to delivery/provider/media-processing runtime; no public deployment, git push or merge in this plan.
- User authorized self-review followed by implementation; do not add a plan approval pause. If no independent review is available, record `SELF_REVIEW` honestly.
- Commands below use `pnpm` as shorthand. On this machine the global pnpm is 9.15.9: execute each as `npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm <arguments>` (or an equivalently verified pinned executable), including nested launcher/Playwright subprocesses.

---

## File Structure and Responsibility

| Files | Responsibility |
|---|---|
| `packages/contracts/src/http.ts`, `http.test.ts`; modify `index.ts` | Exact HTTP DTOs, private persisted state shape, strict runtime command validators, canonical serialization |
| `packages/domain/src/generation-state.ts`, `generation-commands.ts`, `generation-review.ts`; modify `index.ts`; test `tests/http-generation.test.ts` | Initial state/snapshot and create; lifecycle/retry/worker transitions; review/library reducers |
| `packages/generation-api/src/store.ts`, `fixtures.ts`, `worker.ts`, `service.ts` | Durable serial transactions; safe hash-verified fixture lookup; timer worker; orchestration of IO and pure commands |
| `packages/generation-api/src/server.ts`, `server.integration.test.ts`, `store.test.ts`, `worker.test.ts` | Thin authenticated HTTP routing and executable persistence/worker/API coverage |
| `packages/http-platform/src/index.ts`, `index.test.ts` | Browser-only DemoPlatform, transport mapping, version cache and retained command retries |
| `packages/generation-api/scripts/start.ts` | Development API+Vite launcher, secret memory and clean shutdown |
| `apps/web/src/services/platform.ts`, `apps/web/vite.config.ts` | Composition and opt-in guarded local proxy |
| `apps/web/playwright.http.config.ts`, `apps/web/e2e-http/generation.spec.ts` | Isolated local HTTP browser acceptance, preserving B1 suite |
| Root `package.json`, `vitest.config.ts`, `tsconfig.base.json`; `.github/workflows/e2e.yml` | New runner commands, actual test registration and HTTP browser CI integration; existing `.github/workflows/verify.yml` inherits HTTP integration through `pnpm verify`, and `.github/workflows/delivery.yml` stays preserved |
| `README.md`, `docs/14_B21A_HTTP_PLATFORM.md` | Accurate operating boundary, commands, known limits and API mapping |

New directories use relative imports like the existing delivery slice; no unnecessary package manifests/workspace dependency changes. `.ai/evidence/B21A-T{1..4}.md` and `.ai/evidence/B21A-acceptance.md` are ignored local evidence. Create no claims about pre-existing task cards: this branch has no tracked `.ai` task graph.

## Shared Interfaces (all tasks use these names)

Task 1 defines these in `packages/contracts/src/http.ts`; import existing entity types rather than duplicating them:

```ts
export interface ItemVersionInput { expectedVersion: number }
export interface ItemReviewInput extends ItemVersionInput { form: ReviewInput; reason: string }
export interface ItemSaveInput extends ItemVersionInput { evaluationId: string }
export interface ItemReconcileInput extends ItemVersionInput {
  outcome: 'success' | 'failure' | 'cancelled';
}
export interface FixtureLoadInput { key: string }
export interface ScenarioInput { name: ScenarioName }
export interface PendingGeneration {
  itemId: string;
  dueAt: number;
  scenario: ScenarioName;
  phase: 'submit' | 'accept' | 'complete' | 'download';
  downloadRetry: boolean;
}
export interface GenerationState extends DemoSnapshot {
  sequence: number;
  pending: PendingGeneration[];
  memo: Record<string, { hash: string; value: unknown }>;
  reviewForms: Record<string, { form: ReviewInput; reason: string; resultSha256: string }>;
}
export interface GenerationContext { now: number; manifest: DemoManifest }
export type WorkerEvent =
  | { kind: 'submitting'; itemId: string; expectedVersion: number }
  | { kind: 'submitted'; itemId: string; expectedVersion: number }
  | { kind: 'complete'; itemId: string; expectedVersion: number; media?: MediaFile }
  | { kind: 'download_failed'; itemId: string; expectedVersion: number };
export interface HttpCommandBodies {
  version: ItemVersionInput;
  review: ItemReviewInput;
  save: ItemSaveInput;
  reconcile: ItemReconcileInput;
  fixture: FixtureLoadInput;
  scenario: ScenarioInput;
}
export function validateHttpBody<K extends keyof HttpCommandBodies>(
  kind: K, value: unknown,
): Result<HttpCommandBodies[K]>;
export function canonicalJson(value: unknown): string;
```

`canonicalJson` only accepts JSON values, rejects nonfinite numbers/undefined/prototype surprises, recursively sorts object keys and preserves array order. Generation normalization is explicit: trim prompt before hashing. Keep request schema validation in existing `validateGenerationRequest`; HTTP review schemas validate shape before `decideReview` validates semantics. Idempotency digest uses SHA-256 in the server, not a source-text test. `GenerationState` is never returned directly to the browser.

Task 1 domain functions operate on the transaction-owned clone and return `Result<T>`; no IO or hidden clock:

```ts
createGenerationState(epoch: string, now: number): GenerationState;
projectGenerationSnapshot(state: GenerationState): DemoSnapshot;
createBatch(state: GenerationState, input: unknown, key: string,
  requestHash: string, context: GenerationContext, retryOfItemId?: string): Result<GenerationBatchSnapshot>;
cancelItem(state: GenerationState, id: string, input: ItemVersionInput, now: number): Result<GenerationItem>;
retryItem(state: GenerationState, id: string, input: ItemVersionInput,
  key: string, requestHash: string, context: GenerationContext): Result<GenerationBatchSnapshot>;
reconcileItem(state: GenerationState, id: string, input: ItemReconcileInput, now: number): Result<GenerationItem>;
retryItemDownload(state: GenerationState, id: string, input: ItemVersionInput, now: number): Result<GenerationItem>;
applyWorkerEvent(state: GenerationState, event: WorkerEvent, context: GenerationContext): Result<GenerationItem>;
saveItemReview(state: GenerationState, id: string, input: ItemReviewInput,
  resultSha256: string, now: number): Result<Evaluation>;
saveItemAsset(state: GenerationState, id: string, input: ItemSaveInput,
  resultSha256: string, now: number): Result<Asset>;
```

Export reducer argument types with the function declarations. `createBatch` checks manifest output support and existing assets before quota mutation. If a reducer fails after touching its input, the enclosing store discards the complete clone. Reducer tests likewise invoke failures on detached state and assert the repository behavior separately.

## Task 1: Explicit contracts and pure generation rules

**Files:** Create the contracts/domain files in the first two rows above. Modify `packages/contracts/src/index.ts`, `packages/domain/src/index.ts` to export new units. Existing contracts test and domain unit globs already cover the new tests.

**Interfaces:** Consumes existing request, routing, state, quota and review contracts. Produces every shared interface above. No browser, filesystem, timers or Provider imports.

- [ ] **Step 1: Write failing runtime-contract tests.** In `http.test.ts`, table-test every body kind with valid input, null/array, missing version, negative/fractional version and extra keys. Build all eleven applicability fields for review; reject missing/extra dimensions, wrong rubric, score types and unsupported hard failure tags. Assert key order canonicalization and array order preservation.

```ts
it('requires version on reviews and forbids unexpected properties', () => {
  expect(validateHttpBody('review', { form: basicForm, reason: '' }).ok).toBe(false);
  expect(validateHttpBody('review', {
    expectedVersion: 0, form: basicForm, reason: '', modelId: 'injected',
  }).ok).toBe(false);
});
it('canonicalizes object order but not reference order', () => {
  expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']));
});
```

Define `basicForm` in the test as `{rubricVersion:'basic-media-review-v1', humanDecision:'approved', readable:true, followsTask:true}` typed `ReviewInput`.

- [ ] **Step 2: Run red.** `pnpm exec vitest run --project contracts packages/contracts/src/http.test.ts`. Require a nonzero exit caused by missing new exports or missing validation, and record that output.
- [ ] **Step 3: Implement the strict DTO validators and canonical JSON.** Reuse the installed Ajv and existing generation schema; compile command-specific schemas with `additionalProperties:false`. No `as ReviewInput` trust boundary without a preceding successful schema validation.
- [ ] **Step 4: Run green.** Repeat the exact focused command; then `pnpm test:contracts`.
- [ ] **Step 5: Write failing pure-domain cases.** `http-generation.test.ts` uses explicit `now`, fixture manifest and initial state. Cover invalid prompt/support/quota, all modalities, partial status, duplicate terminal event protection, stale versions on *each* exported item reducer, retry rejection for unknown, review hard failures, revisions and explicit save. Use real fixture manifest metadata but no fixture IO at this layer.

```ts
it('rejects a stale review before replacing the current evaluation', () => {
  const state = createGenerationState('test-epoch', 1000);
  // createBatch + successive applyWorkerEvent calls produce one succeeded copy item.
  const batch = createBatch(state, copyRequest, 'one', 'hash-one', context);
  expect(batch.ok).toBe(true);
  if (!batch.ok) throw new Error('fixture setup failed');
  const id = batch.value.items[0]!.id;
  for (const kind of ['submitting', 'submitted', 'complete'] as const) {
    const item = state.items.find(value => value.id === id)!;
    expect(applyWorkerEvent(state, {kind, itemId:id, expectedVersion:item.version}, context).ok).toBe(true);
  }
  const item = state.items.find(value => value.id === id)!;
  const version = item.version;
  expect(saveItemReview(state, id, {expectedVersion:version, form:basicForm, reason:''}, 'text-digest', 2000).ok).toBe(true);
  expect(state.assets).toHaveLength(0);
  expect(saveItemReview(state, id, {expectedVersion:version, form:basicForm, reason:'stale'}, 'text-digest', 2001))
    .toMatchObject({ok:false, error:{code:'VERSION_CONFLICT'}});
});
```

Define `copyRequest` as `{mode:'copy',prompt:'几何商品演示',references:[],count:1,copy:{language:'zh-CN',maxCharacters:100}}`; `context={now:1000,manifest}`. Repeat the same explicit setup in helper functions inside this test file for the additional cases; do not import a mock repository.

- [ ] **Step 6: Run red.** `pnpm exec vitest run --project unit packages/domain/tests/http-generation.test.ts`; inspect actual failure.
- [ ] **Step 7: Implement state/create, lifecycle and review reducers.** Use `state.sequence` and epoch to make stable ids; grant 1286 demo credits once; call existing routing validation before creation. First item version is 0. Each accepted reducer command increments exactly once, including review/save/retry source. Lifecycle transitions reuse existing domain transition rules, with an explicit version precheck before no-op handling. Fake `complete` may perform finalizing and success atomically but the command publishes only one increment. Review revisions invalidate all prior assets and reset library state even if the new decision is approved; manual save requires the newest approved digest-bound evaluation.

```ts
if (item.version !== input.expectedVersion) {
  return {ok:false, error:{code:'VERSION_CONFLICT', message:'子项版本已变化，请刷新后重试'}};
}
// On a new review, update the transaction clone only after decideReview succeeds.
for (const asset of state.assets.filter(value => value.originItemId === item.id)) {
  asset.reviewValidity = 'review_invalidated';
}
item.libraryState = 'not_saved';
item.version += 1;
```

- [ ] **Step 8: Run green/review/commit.** Run the focused domain test, `pnpm test:unit`, `pnpm typecheck`. Review diff for domain side effects/duplicate rules and save red/green evidence. Commit explicit files with `feat: define controlled HTTP generation contracts and reducers`.

## Task 2: Atomic server state, fixture IO and autonomous fake worker

**Files:** Create `packages/generation-api/src/store.ts`, `fixtures.ts`, `worker.ts`, `service.ts`, `store.test.ts`, `worker.test.ts`. Modify `vitest.config.ts` unit include to add `packages/generation-api/**/*.test.ts` and maintain integration exclusion. No dependency additions.

**Interfaces:** Consumes Task 1 reducers/types. Produces:

```ts
class GenerationStore {
  static open(directory: string): Promise<GenerationStore>;
  read(): GenerationState;
  transact<T>(work: (state: GenerationState) => Result<T>): Promise<Result<T>>;
  close(): Promise<void>;
}
class FixtureCatalog {
  static open(root: string): Promise<FixtureCatalog>;
  readonly manifest: DemoManifest;
  readFixture(key: string): Promise<{ media: MediaFile; bytes: Buffer }>;
  readMedia(media: MediaFile): Promise<{ media: MediaFile; bytes: Buffer }>;
}
class GenerationApiService {
  constructor(store: GenerationStore, fixtures: FixtureCatalog, clock?: () => number);
  snapshot(): DemoSnapshot;
  create(input: unknown, key: string): Promise<Result<GenerationBatchSnapshot>>;
  cancel(id: string, input: ItemVersionInput, key: string): Promise<Result<GenerationItem>>;
  retry(id: string, input: ItemVersionInput, key: string): Promise<Result<GenerationBatchSnapshot>>;
  reconcile(id: string, input: ItemReconcileInput, key: string): Promise<Result<GenerationItem>>;
  retryDownload(id: string, input: ItemVersionInput, key: string): Promise<Result<GenerationItem>>;
  review(id: string, input: ItemReviewInput, key: string): Promise<Result<Evaluation>>;
  saveAsset(id: string, input: ItemSaveInput, key: string): Promise<Result<Asset>>;
  loadFixture(input: FixtureLoadInput, key: string): Promise<Result<Asset>>;
  setScenario(input: ScenarioInput, key: string): Promise<Result<null>>;
}
class FakeWorker {
  constructor(store: GenerationStore, fixtures: FixtureCatalog, clock?: () => number);
  start(intervalMs?: number): void;
  tick(): Promise<void>;
  stop(): Promise<void>;
}
```

`GenerationApiService` computes canonical SHA-256, performs scoped memo replay, resolves fixture IO, then invokes reducers in `store.transact`; memo is part of the same successful state commit. Store creation generates epoch once. `readMedia` checks current bytes and manifest SHA-256 every time, and returns metadata derived from the catalog rather than trusting incoming/browser metadata.

- [ ] **Step 1: Write store failure tests.** Use fresh directories under the workspace `.cache`; ensure cleanup paths remain in that root. Assert independent second `open()` fails lock acquisition, corrupt JSON fails startup, rollback leaves no batch/ledger change, close/reopen preserves complete state, and persistence failure leaves last committed memory/disk state intact. Inject write failures with a module spy around `rename` or a filesystem adapter, not platform-dependent symlink permission tricks.

```ts
it('does not publish a rejected transaction', async () => {
  const before = store.read();
  const result = await store.transact(state => {
    state.sequence += 99;
    return {ok:false, error:{code:'QUOTA_INSUFFICIENT', message:'测试额度不足'}};
  });
  expect(result.ok).toBe(false);
  expect(store.read()).toEqual(before);
});
```

- [ ] **Step 2: Run red.** `pnpm exec vitest run --project unit packages/generation-api/src/store.test.ts`.
- [ ] **Step 3: Implement store and catalog.** Queue transactions through one promise chain; clone before reducers; fsync a unique temporary snapshot then rename; publish memory only after success. Use exclusive lock ownership and validate loaded complete state. Catalog accepts only manifest-relative paths with realpath containment, verifies SHA-256 and reads actual file size/MIME metadata. No arbitrary request paths or URLs are accepted.

```ts
const next = structuredClone(this.state);
const result = work(next);
if (!result.ok) return result;
await persistAtomic(next);
this.state = next;
return structuredClone(result);
```

`persistAtomic` is a private store helper writing/closing/fsyncing the temporary file before rename and cleaning only its owned temporary path on failure.

- [ ] **Step 4: Run green.** Repeat focused store tests and `pnpm typecheck`.
- [ ] **Step 5: Write autonomous-worker and idempotency tests.** Test `service.create` returns queued before worker completion. With injected clock and explicit `tick()`, test success, partial failure, cancel before submit, cancel-race after submit, unknown holds credits, explicit reconcile, failure retry creates a new item, finalizing download recovery keeps attempt identity, and close/reopen while queued/running/finalizing. Separately start a real short-interval worker and prove it finishes without browser, `pump()` or HTTP GET. Concurrent identical create must leave one batch and one reserve; reordered keys/trimmed prompt replay; same key/different payload conflicts; stale new-key review/save/retry/recovery all conflict; same-key accepted replay is safe after version advances.

```ts
const [first, replay] = await Promise.all([
  service.create(copyRequest, 'same-key'),
  service.create({...copyRequest, prompt:'  几何商品演示  '}, 'same-key'),
]);
expect(first).toEqual(replay);
expect(store.read().batches).toHaveLength(1);
expect(store.read().ledger.filter(entry => entry.action === 'RESERVE')).toHaveLength(1);
worker.start(5);
await vi.waitFor(() => expect(service.snapshot().items[0]?.status).toBe('succeeded'));
await worker.stop();
expect(service.snapshot().assets).toHaveLength(0);
```

Use actual fixture bytes for at least one video and one image completion, tamper a copied fixture to assert hash failure blocks review/save, and keep tests Provider-free.

- [ ] **Step 6: Run red.** `pnpm exec vitest run --project unit packages/generation-api/src/worker.test.ts`.
- [ ] **Step 7: Implement service and worker.** Persist pending outcome at submission. The worker claims/submits/completes separate phases, checks captured version before applying, never overlaps ticks and resumes existing fake attempts after restart. Read/verify fixture IO outside state transaction, then recheck item/version/digest inside it. Retry-download resets pending download scheduling, not attempt count. Successful item/quota/pending settlement is atomic. Service review/save verifies bytes on every operation before the reducer. Make unexpected persistence errors stop further worker progress and surface sanitized storage status rather than swallowing them into a spin loop.
- [ ] **Step 8: Run green/review/commit.** Focused worker/store tests, `pnpm test:unit`, `pnpm typecheck`; inspect no missing durable scheduling, no signed URLs/base64, no browser-dependent ticking. Record results and commit `feat: persist generation state and run deterministic local worker`.

## Task 3: Guarded HTTP routes and the existing DemoPlatform over HTTP

**Files:** Create `packages/generation-api/src/server.ts`, `server.integration.test.ts`, `packages/http-platform/src/index.ts`, `index.test.ts`. Modify `vitest.config.ts` to add unit adapter coverage and a separate `http` project matching `packages/generation-api/**/*.integration.test.ts`; modify root `package.json` to add `test:http` and include it in `verify` after contract tests.

**Interfaces:** Consume `GenerationApiService`, `GenerationStore`, `FixtureCatalog`, `FakeWorker` and all Task 1 HTTP DTOs. Produce:

```ts
startGenerationApi(options: {
  directory: string; fixtureRoot: string; token: string; port: number;
  allowedOrigins: string[]; workerIntervalMs?: number;
}): Promise<{
  url: string; store: GenerationStore; service: GenerationApiService;
  worker: FakeWorker; close(): Promise<void>;
}>;
class HttpPlatform implements DemoPlatform {
  constructor(options?: {baseUrl?: string; fetcher?: typeof fetch});
  // Implements every existing DemoPlatform member without signature changes.
}
```

Default browser `baseUrl` is `/api`; route paths then append `/v1/...`. Server route/method/DTO names exactly match the spec table. Export no token or node-side module from the browser package.

- [ ] **Step 1: Write real HTTP red tests.** Use port 0, local fixture root, a temp state directory and injected synthetic token. Assert missing token=401, hostile Host/Origin=403, malformed/oversize JSON, unexpected fields, unknown route and all version omissions. POST then poll actual HTTP until completion; GET never triggers worker execution. Verify raw media bytes hash correctly. Test same-key create conflict, concurrent item mutation version conflicts, partial failure, cancel-race, reconciliation, review hard failures and save/review invalidation.

```ts
const response = await fetch(`${app.url}/v1/generation-batches`, {
  method:'POST', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'Idempotency-Key':'http-create'},
  body:JSON.stringify(copyRequest),
});
expect(response.status).toBe(202);
const accepted = await response.json();
expect(accepted).toMatchObject({ok:true, value:{status:'queued'}});
expect((await fetch(`${app.url}/v1/snapshot`, {headers:{Origin:'https://hostile.invalid', Authorization:`Bearer ${token}`}})).status).toBe(403);
```

- [ ] **Step 2: Run red.** `pnpm test:http` (actual tests must be discovered, not an empty successful run).
- [ ] **Step 3: Implement thin server.** Check exact Host, bearer and configured Origin before reading bodies; cap JSON at 64 KiB and require application/json. Validate every command using shared validators; handlers delegate to service. Return only public snapshot projection and safe fixed error envelopes. Binary routes verify catalog hashes and never expose arbitrary filesystem paths. Worker lifecycle begins at start and drains before store.close.
- [ ] **Step 4: Run green.** `pnpm test:http`.
- [ ] **Step 5: Write HttpPlatform red tests.** Inject an executable fetch stub returning real response objects and capture URL/body/header. Verify every facade method maps correctly; unexpected/malformed server body becomes safe `NETWORK_ERROR`, supported domain failures preserve code/field. A no-op `pump()` sends no HTTP. Adapter never creates IndexedDB/Mock state. Unsupported members explicitly fail. Test stale cached review version remains stale and a 409 is surfaced with no automatic rebase. Test an ambiguous network failure retains exact mutation key+version+body even if a later snapshot updates the cache; after a definite result a new action gets a new key. Test snapshot responses resolving in reversed order do not regress versions.

```ts
await platform.snapshot(); // fake response contains item version 4
await platform.review.save(itemId, basicForm.rubricVersion, basicForm);
expect(JSON.parse(requests.at(-1)!.body)).toMatchObject({expectedVersion:4, form:basicForm, reason:''});
const before = requests.length;
await platform.pump();
expect(requests).toHaveLength(before);
expect(await platform.upload(new Blob(['x']), 'x.txt')).toMatchObject({ok:false, error:{code:'FORBIDDEN'}});
```

`requests` is a local array populated by the injected `fetcher`; each fixture response is a `Response` with JSON Result envelopes and the exact contract entities established in Task 1 tests.

- [ ] **Step 6: Run red.** `pnpm exec vitest run --project unit packages/http-platform/src/index.test.ts`.
- [ ] **Step 7: Implement HttpPlatform.** A private JSON transport validates Result envelopes and sanitizes exceptions. Keep observed item version map and outstanding mutation map. For save/review/mutation responses that do not carry the updated item, refresh snapshot only after accepting the mutation; never change the captured version inside an outstanding retry. `generation.create/retry` honor provided keys. `media.get` loads metadata and Blob and verifies response MIME/size/hash where available. `snapshot` projects only a validated snapshot, `ready` awaits it, `pump` resolves. Implement peripheral method errors directly with `Result`, no silent backend substitution.
- [ ] **Step 8: Run green/review/commit.** Focused adapter tests, `pnpm test:http`, `pnpm verify`. Inspect browser dependency graph and all item command preconditions. Record counts/exits and commit `feat: expose guarded generation HTTP API and HttpPlatform adapter`.

## Task 4: Development composition, browser proof and accurate delivery documentation

**Files:** Create `packages/generation-api/scripts/start.ts`, `apps/web/playwright.http.config.ts`, `apps/web/e2e-http/generation.spec.ts`, `docs/14_B21A_HTTP_PLATFORM.md`. Modify `apps/web/src/services/platform.ts`, `apps/web/vite.config.ts`, root `package.json`, `tsconfig.base.json`, `README.md` and `.github/workflows/e2e.yml`. Existing `.github/workflows/verify.yml` invokes the extended verify command without a workflow edit; preserve `.github/workflows/delivery.yml`.

**Interfaces:** Consume `startGenerationApi` and `HttpPlatform`. Produce `pnpm http:dev`, `pnpm test:http:e2e`, and opt-in `local-http` Vite mode. Production/default `platform` stays typed `DemoPlatform`.

- [ ] **Step 1: Write a failing browser test for the real HTTP mode.** New Playwright config uses `pnpm http:dev -- --port 4174` (launcher parses numeric `--port`, default 5173), its own testDir/outputDir and no reused unrelated server. Use existing UI labels/selectors after inspecting the current B1 tests. Create a video, close its page, wait using HTTP observation from another page/request, reopen history, inspect “演示视频”, assert `video.readyState >= 2`, positive duration and advancing currentTime after play. Approve via all applicable real DOM rubric controls; assert no asset before clicking save. Save, revise/reject, assert invalidation; approve again and assert a second manual action is required. Add one image/copy flow or parameterized cases through API+adapter to verify all modalities.

```ts
const video = page.locator('video').first();
await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
await video.evaluate(async el => { const media=el as HTMLVideoElement; media.muted=true; await media.play(); });
await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
expect(await page.evaluate(() => ({local:{...localStorage}, session:{...sessionStorage}})))
  .not.toHaveProperty('local.AISPSC_OPERATOR_TOKEN');
```

Strengthen the secret check by capturing browser requests/storage/config responses and comparing with the synthetic launcher token in the test harness without printing it. A production build verification must inspect actual built dependency/module graph or run the built app and assert Mock behavior; do not assert source text contains an if statement.

- [ ] **Step 2: Run red.** `pnpm test:http:e2e`; missing launcher/HTTP composition is the expected red cause, not a bypassed assertion.
- [ ] **Step 3: Implement local launcher and composition.** The Node launcher imports existing Vite, creates a middleware-mode Vite loader for SSR server entry, generates a random memory-only token, calls `startGenerationApi`, then starts frontend Vite in `local-http` mode. Pass server-only proxy configuration directly in process, never via `VITE_*`. Proxy guard verifies loopback Host, matching allowed Origin and cross-site Fetch Metadata before overwriting any incoming Authorization with the operator token. Proxy forwards only `/api/v1`, strips `/api`, rewrites Host to API authority and retains allowed original Origin. CLI logs URLs and synthetic-mode boundary only. Signal cleanup closes Vite, worker/API and SSR loader.

```ts
export const platform: DemoPlatform = import.meta.env.DEV && import.meta.env.MODE === 'local-http'
  ? new HttpPlatform({baseUrl:'/api'})
  : new MockPlatform({fetcher:createDemoFetcher(import.meta.env.BASE_URL)});
```

Do not scatter HTTP calls through pages. Unsupported operations already return explanatory errors. Set data directory to ignored workspace `artifacts/local-generation`; test runner uses its own ignored directory. Include the new Playwright config/test paths in typecheck. Keep API listening on `127.0.0.1`, with test ports configurable through launcher arguments.

- [ ] **Step 4: Run green.** `pnpm test:http:e2e`. Capture a successful playing demo video, review awaiting manual save and invalidated asset screenshot to local ignored evidence.
- [ ] **Step 4a: Exercise the proxy boundary.** Send actual requests to the frontend proxy with a hostile Origin, unexpected Host, cross-site Fetch Metadata and an injected Authorization header. Assert hostile requests are rejected before reaching the API; valid same-origin requests receive the proxy's operator identity without any secret being returned to browser JavaScript. Verify default development and a production build using `--mode local-http` still execute Mock behavior.
- [ ] **Step 5: Document and register acceptance.** README says “B2.1A local HTTP contract with deterministic fake worker”, not real Provider integration or production backend. Document API table, launch/stop/restart, lock recovery, mode distinction, all unsupported members, copied fixtures and hash validation, server-only token proxy, local limitations, later Nest/Postgres and actual billing still absent. Keep old B1/Delivery instructions. CI adds HTTP E2E after Chromium installation while preserving all existing jobs and no Provider secrets.
- [ ] **Step 6: Full acceptance, review and commit.** Run `pnpm verify`, `pnpm test:e2e`, `pnpm test:http:e2e`, `pnpm test:delivery`, `pnpm test:delivery:ui`; report each exit code and actual counts. Existing Windows delivery symlink permission failure must be recorded as a baseline environmental failure unless a supported environment runs it successfully; never mark the failed command passed or skip its test. Review `git diff --check`, changed file scope and production build behavior. Save command/commit/count/screenshot evidence. Commit `feat: enable local HTTP demo mode with browser acceptance` only with truthful verification reporting.

## Plan Self-review — SELF_REVIEW

- [x] User B2.1A items 1–10 are assigned: HttpPlatform/API (T3), state/idempotency/version (T1–T3), history/cancel (T1/T3), review/save (T1–T4), autonomous fake worker (T2).
- [x] Acceptance includes partial success, failure, cancel race, unknown, conflicts and review invalidation, plus retry/download/restart and playable video.
- [x] Every item mutation includes expectedVersion; cache-based adapter preserves stale intent; replay is checked before current version and retained network retries use exact original bodies.
- [x] Generation creation and completion persist quota and pending work in the same atomic store transaction; duplicate settlement is tested.
- [x] Provider/Agnes imports and paid calls are absent from scope; production B1 and delivery capabilities remain unchanged.
- [x] Fixture availability/hash is checked for actual reads, success, review and manual save; unsupported media never silently changes parameters.
- [x] Shared DTO names and service/reducer method names match between tasks; server paths match the spec table.
- [x] No new dependencies, no native Node resolution assumption, no broad backend framework migration.
- [x] Tests are executable behavior tests with red/green commands and exact paths; existing gates remain present.
- [x] No unapproved public deployment/push/merge or additional permission pause; plan author has not executed implementation or baseline tests.
- [x] Current baseline reported by coordinating agent: verify passed (189 unit, 28 contracts, lint/typecheck/build); delivery had 9 passes and one existing Windows EPERM symlink setup failure. These are baseline evidence, not this plan's future completion results.
- [x] Coordinating agent verified Vite SSR loading of the existing domain graph and whitespace-prompt rejection (exit 0), and baseline delivery browser verification (exit 0). Pinned pnpm invocation is documented above.

The remaining risks are explicitly scoped in the spec. This self-review validates plan coverage, not implementation correctness. Execute tasks sequentially, review each diff, and update the checklist only with actual work/evidence.
