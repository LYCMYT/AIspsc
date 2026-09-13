import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../contracts/src/index.js';
import { B21C_REQUEST } from '../../../domain/src/authorized-agnes.js';
import { openAuthorizedSession, assertAuthorizedSession, type AuthorizedSession, type AuthorizedSessionOptions } from './authorized-session.js';
import { AUTHORIZED_QUOTE, EXPERIMENT_ID, AUTHORIZED_AT } from './authorized-request.js';
import { IDEMPOTENCY_KEY } from './authorized-request.js';
import { GenerationApiService } from '../service.js';
import { GenerationWorker } from '../worker.js';
import { FixtureCatalog } from '../fixtures.js';
import { startGenerationApi } from '../server.js';
const opened: AuthorizedSession[] = [];
// The non-CI controlled branch is simulated with injected transport only; explicit CI=true rejection is tested below.
beforeEach(() => { vi.stubEnv('CI', 'false'); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const s of opened.splice(0)) await s.close(); });
async function setup() {
  await mkdir(resolve('.cache/authorized-tests'), { recursive: true });
  const worktree = await mkdtemp(resolve('.cache/authorized-tests/unit-'));
  const commonDir = join(worktree, 'private-git'); await mkdir(commonDir);
  const sourceSha = 'a'.repeat(40);
  const authorization = { version: 1, experimentId: EXPERIMENT_ID, authorizedAt: AUTHORIZED_AT, quote: AUTHORIZED_QUOTE, request: structuredClone(B21C_REQUEST), requestHash: createHash('sha256').update(canonicalJson(B21C_REQUEST)).digest('hex'), sourceSha };
  const options: AuthorizedSessionOptions = { mode: 'create', explicitOptIn: true, env: { PROVIDER_MODE: 'agnes', AGNES_REAL_CREATE_ENABLED: 'true', AGNES_API_KEY: 'synthetic-session-key' }, authorization: async () => authorization, location: { worktree, commonDir, sourceSha }, fetchImpl: vi.fn(async () => { throw Error('NO_DECLARED_TRANSPORT'); }) };
  return { options, worktree, commonDir, authorization, directory: join(worktree, '.ai/evidence/B21C/live'), registry: join(commonDir, 'aispsc-b21c', EXPERIMENT_ID) };
}
async function open(options: AuthorizedSessionOptions) { const s = await openAuthorizedSession(options); opened.push(s); return s; }
it('denies CI before reading authorization, credentials or location', async () => {
  const { options } = await setup(); const auth = vi.fn(options.authorization);
  const env = { CI: 'true', get AGNES_API_KEY(): string { throw Error('CREDENTIAL_READ'); } };
  await expect(open({ ...options, env, authorization: auth })).rejects.toThrow('REAL_PROVIDER_CALL_FORBIDDEN_IN_CI');
  expect(auth).not.toHaveBeenCalled();
});
it('rejects Git location overrides before reading authorization', async () => {
  const { options } = await setup(); const authorization = vi.fn(options.authorization);
  await expect(open({ ...options, env: { ...options.env, GIT_COMMON_DIR: 'synthetic-elsewhere' }, authorization })).rejects.toThrow('AUTHORIZED_GIT_OVERRIDE');
  expect(authorization).not.toHaveBeenCalled();
});
it('the original server rejects a forged capability before opening state', async () => {
  await expect(startGenerationApi({ directory: 'unused', fixtureRoot: 'unused', token: 'synthetic', port: 0, allowedOrigins: [], authorizedSession: {} as AuthorizedSession })).rejects.toThrow('INVALID_AUTHORIZED_SESSION');
});
it.each(['authorization', 'flags', 'key', 'opt-in', 'request', 'sha'] as const)('denies invalid %s without transport', async what => {
  const { options, authorization } = await setup();
  if (what === 'authorization') options.authorization = async () => undefined;
  if (what === 'flags') options.env.AGNES_REAL_CREATE_ENABLED = 'false';
  if (what === 'key') options.env.AGNES_API_KEY = '';
  if (what === 'opt-in') options.explicitOptIn = false;
  if (what === 'request') authorization.request.count = 2;
  if (what === 'sha') authorization.sourceSha = 'b'.repeat(40);
  await expect(open(options)).rejects.toThrow(); expect(options.fetchImpl).not.toHaveBeenCalled();
});
it('rejects forged capability and retains ready identity across readonly reopen without a key', async () => {
  expect(() => assertAuthorizedSession({})).toThrow('INVALID_AUTHORIZED_SESSION');
  const { options, directory } = await setup(); const first = await open(options);
  assertAuthorizedSession(first); const epoch = first.store.read().epoch; await first.close();
  expect(() => assertAuthorizedSession(first)).toThrow('INVALID_AUTHORIZED_SESSION');
  const next = await open({ ...options, mode: 'observe', env: {} });
  expect(next.store.read().epoch).toBe(epoch); expect(next.directory).toBe(directory);
});
it.each(['state', 'counters', 'partial', 'stale-lock', 'other-worktree'] as const)('refuses %s instead of resetting initialized state', async what => {
  const { options, directory, registry, worktree } = await setup(); const s = await open(options); await s.close();
  options.mode = 'observe'; options.env = {};
  if (what === 'state') await rm(join(directory, 'state.json'));
  if (what === 'counters') await rm(join(registry, 'counters.json'));
  if (what === 'partial') await writeFile(join(registry, 'registry.json'), '{');
  if (what === 'stale-lock') await writeFile(join(registry, 'session.lock'), 'old-owner');
  if (what === 'other-worktree') { const other = join(worktree, 'other'); await mkdir(other); options.location!.worktree = other; }
  await expect(open(options)).rejects.toThrow(what === 'stale-lock' ? 'AUTHORIZED_SESSION_LOCKED' : 'AUTHORIZED_STATE_INVALID');
});
it('refuses an orphan consumed marker when registry is missing', async () => {
  const { options, registry } = await setup(); await mkdir(registry, { recursive: true }); await writeFile(join(registry, 'create-budget.json'), '');
  await expect(open(options)).rejects.toThrow('AUTHORIZED_STATE_INVALID');
});
it('persists counters before dispatch and preserves interval, deadline and count on reopen', async () => {
  const { options, registry } = await setup(); let now = Date.now(); options.clock = () => now;
  const s = await open(options); await s.budget.reserve('get', 'safe-original');
  expect(JSON.parse(await readFile(join(registry, 'counter-receipts', '000001.json'), 'utf8')).counters.get).toBe(1);
  await expect(s.budget.reserve('get', 'safe-original')).rejects.toThrow('AUTHORIZED_POLL_INTERVAL');
  const deadline = s.budget.snapshot().deadline; await s.close();
  const next = await open({ ...options, mode: 'observe', env: {} });
  expect(next.budget.snapshot()).toMatchObject({ get: 1, deadline }); now += 5000;
  for (let i = 1; i < 120; i++) { await next.budget.reserve('get', 'safe-original'); now += 5000; }
  await expect(next.budget.reserve('get', 'safe-original')).rejects.toThrow('AUTHORIZED_GET_LIMIT');
  await next.budget.reserve('media', 'platform-outputs.agnes-ai.space'); await next.budget.reserve('media', 'platform-outputs.agnes-ai.space');
  await expect(next.budget.reserve('media', 'platform-outputs.agnes-ai.space')).rejects.toThrow('AUTHORIZED_MEDIA_LIMIT');
  now = deadline; await expect(next.budget.reserve('media', 'platform-outputs.agnes-ai.space')).rejects.toThrow('AUTHORIZED_DEADLINE');
});
it.each(['partial','gap','tamper','missing-ready','partial-ready'] as const)('rejects %s receipt/initialization without replenishing counters', async kind => {
  const { options, registry } = await setup(); const s = await open(options); await s.close();
  if (kind === 'partial') await writeFile(join(registry, 'counter-receipts', '000001.json'), '{');
  if (kind === 'gap') await writeFile(join(registry, 'counter-receipts', '000002.json'), '{}');
  if (kind === 'tamper') await writeFile(join(registry, 'counter-receipts', '000001.json'), JSON.stringify({ sequence: 1, previousHash: 'forged', counters: s.budget.snapshot() }));
  if (kind === 'missing-ready') await rm(join(registry, 'ready.json'));
  if (kind === 'partial-ready') await writeFile(join(registry, 'ready.json'), '{');
  await expect(open({ ...options, mode: 'observe', env: {} })).rejects.toThrow('AUTHORIZED_STATE_INVALID');
});
it('serializes concurrent registry initialization across synthetic worktrees', async () => {
  const { options, worktree } = await setup(); const other = join(worktree, 'other'); await mkdir(other);
  const results = await Promise.allSettled([open(options), open({ ...options, location: { ...options.location!, worktree: other } })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
});
it.each(['redirect', 'poll-failure', 'deadline', 'wrong-id'] as const)('pauses %s on the original attempt without retrying Create or releasing uncertain quota', async kind => {
  const { options } = await setup(); let now = Date.now(); options.clock = () => now; let calls = 0;
  options.fetchImpl = vi.fn(async (_input, init) => {
    calls++;
    if (init?.method === 'POST') {
      const response = new Response(JSON.stringify({ video_id: 'original-video', status: 'queued' }));
      if (kind === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }
    throw Error('SYNTHETIC_POLL_FAILURE');
  });
  const session = await open(options); const fixtures = await FixtureCatalog.open(resolve('apps/web/public/demo'));
  const service = new GenerationApiService(session.store, fixtures, () => now, fixtures, session.policy);
  expect((await service.create(B21C_REQUEST, IDEMPOTENCY_KEY)).ok).toBe(true);
  const worker = new GenerationWorker(session.store, session.provider, fixtures, undefined, () => now);
  now += 101; await worker.tick();
  if (kind === 'wrong-id') {
    const state = session.store.read(); const a = state.attempts[0]!; const item = state.items[0]!;
    const context = { request: structuredClone(B21C_REQUEST), itemId: item.id, itemIndex: 0, attemptId: a.attemptId!, externalIdempotencyKey: a.externalIdempotencyKey, submittedAt: a.submittedAt!, now, scenario: state.scenario, cancelRequested: false, recovery: false };
    expect(await session.provider.get('different-id', context)).toEqual({ status: 'unknown' });
  }
  now = kind === 'deadline' ? session.budget.snapshot().deadline : now + 5000;
  await worker.tick(); const state = session.store.read();
  expect(state.attempts[0]!.submissionState).toBe('needs_reconciliation');
  expect(state.credits.reservations[state.items[0]!.id]!.finalState).toBe('reserved');
  expect(state.pending[0]!.dueAt).toBe(Number.MAX_SAFE_INTEGER);
  expect(calls).toBe(kind === 'poll-failure' ? 2 : 1);
  await worker.tick(); expect(calls).toBe(kind === 'poll-failure' ? 2 : 1);
});
