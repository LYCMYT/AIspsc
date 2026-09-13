import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, type GenerationState } from '../../../contracts/src/index.js';
import { B21C_REQUEST, isB21cRequest } from '../../../domain/src/authorized-agnes.js';
import { buildAgnesVideoCreateBody, AGNES_API_BASE_URL, AGNES_VIDEO_MODEL } from '../../../provider-agnes/src/index.js';
import { checkedMediaUrl } from '../../../provider-agnes/src/download.js';
import { AgnesProvider } from './agnes-provider.js';
import { consumeCreateBudget } from './one-create-guard.js';
import { ProviderOperationError, type GenerationProvider, type ProviderContext, type ProviderResultReference } from './port.js';
import { assertControlledEnvironment, validateAuthorization, EXPERIMENT_ID, IDEMPOTENCY_KEY } from './authorized-request.js';
import { discoverAuthorizedLocation, openAuthorizedPersistence, privatePath, type AuthorizedLocation } from './authorized-persistence.js';
import type { StoreFileSystem } from '../store.js';

export interface ControlledServicePolicy {
  command(scope: string): boolean;
  create(state: GenerationState, body: unknown, key: string): boolean;
}
export interface AuthorizedSessionOptions {
  mode: 'create' | 'observe'; explicitOptIn: boolean; env: NodeJS.ProcessEnv;
  authorization: () => Promise<unknown>; fetchImpl: typeof fetch;
  /** Only the executable supplies its fixed worktree. Synthetic tests inject location. */
  worktree?: string; location?: AuthorizedLocation; clock?: () => number;
  /** Existing Store filesystem seam for synthetic faults; the executable never supplies this. */
  storeFileSystem?: StoreFileSystem;
}
type Persistence = Awaited<ReturnType<typeof openAuthorizedPersistence>>;
export interface AuthorizedSession {
  readonly mode: 'create' | 'observe'; readonly store: Persistence['store']; readonly budget: Persistence['budget'];
  readonly directory: string; readonly commonDir: string; readonly provider: GenerationProvider;
  readonly policy: ControlledServicePolicy;
  request(): typeof B21C_REQUEST;
  status(): { stopCode?: string; createInvocationsObserved: number };
  close(): Promise<void>;
}
const validSessions = new WeakSet<object>();
export function assertAuthorizedSession(value: unknown): asserts value is AuthorizedSession {
  if (!value || typeof value !== 'object' || !validSessions.has(value)) throw Error('INVALID_AUTHORIZED_SESSION');
}
const denied = () => new ProviderOperationError('REAL_PROVIDER_CREATE_DISABLED', 'unknown', 'unknown');
/** No ambient transport, key lookup or filesystem action occurs on import. */
export async function openAuthorizedSession(options: AuthorizedSessionOptions): Promise<AuthorizedSession> {
  assertControlledEnvironment(options.env);
  if (!options.explicitOptIn || !['create','observe'].includes(options.mode) || typeof options.authorization !== 'function' || typeof options.fetchImpl !== 'function') throw Error('AUTHORIZED_OPT_IN_REQUIRED');
  if (options.mode === 'create' && (options.env.AGNES_REAL_CREATE_ENABLED !== 'true' || options.env.PROVIDER_MODE !== 'agnes')) throw Error('AUTHORIZED_FLAGS_REQUIRED');
  const location = options.location ?? await discoverAuthorizedLocation(options.worktree ?? '');
  await privatePath(join(location.worktree, '.ai/evidence/B21C'));
  const auth = validateAuthorization(await options.authorization(), location.sourceSha);
  const secret = options.mode === 'create' ? options.env.AGNES_API_KEY?.trim() : undefined;
  if (options.mode === 'create' && !secret) throw Error('AUTHORIZED_KEY_REQUIRED');
  const clock = options.clock ?? Date.now;
  // Retain immutable configuration and transport identities; external option mutation grants nothing.
  options = { ...options, location: { ...location }, fetchImpl: options.fetchImpl, mode: options.mode };
  const persistence = await openAuthorizedPersistence(location, auth, options.mode, clock, options.storeFileSystem);
  const { store, budget, directory } = persistence;
  if (budget.snapshot().create || options.mode === 'observe') options.env.AGNES_REAL_CREATE_ENABLED = 'false';
  let stopCode: string | undefined; let closed = false; let attempted = false; let permit = false;
  let operation: 'create' | 'get' | 'media' | undefined; let context: ProviderContext | undefined;
  let currentResult: ProviderResultReference | undefined; let invocationObserved = 0;
  const stop = (code: string) => { stopCode ??= code; options.env.AGNES_REAL_CREATE_ENABLED = 'false'; permit = false; };
  const validateContext = (ctx: ProviderContext, creating = false): GenerationState => {
    const s = store.read(); const item = s.items[0]; const attempt = s.attempts[0]; const batch = s.batches[0];
    if (closed || options.mode !== 'create' || s.items.length !== 1 || s.batches.length !== 1 || s.attempts.length !== 1 || s.assets.length || s.evaluations.length || !item || !attempt || !batch
      || !isB21cRequest(batch.requestSnapshot) || !isB21cRequest(ctx.request) || ctx.itemId !== item.id || ctx.itemIndex !== 0 || ctx.attemptId !== attempt.attemptId || ctx.externalIdempotencyKey !== attempt.externalIdempotencyKey
      || ctx.submittedAt !== attempt.submittedAt || !attempt.submittedAt || item.routingSnapshot.bindingId !== 'agnes-authorized-real' || item.routingSnapshot.modelKey !== 'agnes-video-v2.0' || item.routingSnapshot.ruleVersion !== 'b21c-fixed-t2v-v1'
      || attempt.providerBindingId !== 'agnes-authorized-real' || item.reviewState !== 'pending' || item.libraryState !== 'not_saved'
      || (creating && (attempt.submissionState !== 'submitting' || s.credits.reservations[item.id]?.finalState !== 'reserved'))) throw denied();
    return s;
  };
  const guardedTransport: typeof fetch = async (input, init) => {
    if (closed || !context || !operation) throw denied();
    const url = new URL(String(input)); const headers = new Headers(init?.headers);
    if (url.username || url.password || url.hash || init?.redirect !== 'error') throw denied();
    if (operation === 'create') {
      if (!permit || url.href !== `${AGNES_API_BASE_URL}/v1/videos` || init.method !== 'POST' || headers.get('authorization') !== `Bearer ${secret}` || headers.get('content-type') !== 'application/json' || [...headers.keys()].some(k => !['authorization','content-type'].includes(k))
        || init.body !== JSON.stringify(buildAgnesVideoCreateBody({ prompt: B21C_REQUEST.prompt, ...B21C_REQUEST.video }))) throw denied();
      const s = validateContext(context, true);
      const disk: unknown = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
      if (canonicalJson(disk) !== canonicalJson(s)) throw denied();
      // Nothing asynchronous separates consuming the ephemeral permit and invoking transport.
      if (!permit) throw denied(); permit = false; options.env.AGNES_REAL_CREATE_ENABLED = 'false';
      invocationObserved++;
      let response: Promise<Response>;
      try { response = Promise.resolve(options.fetchImpl(url.href, { ...init, credentials: 'omit', redirect: 'error' })); }
      catch { await budget.invocation(); throw denied(); }
      // Attach the rejection handler immediately while persisting the observed callback entry.
      const result = response.then(value => ({ value }), () => ({ value: undefined }));
      await budget.invocation(); const completed = await result;
      if (!completed.value || completed.value.redirected) throw denied(); return completed.value;
    }
    validateContext(context);
    const original = budget.snapshot().originalId;
    if (!original || store.read().attempts[0]?.externalJobId !== original) throw denied();
    if (operation === 'get') {
      const expected = new URL(`${AGNES_API_BASE_URL}/agnesapi`); expected.search = new URLSearchParams({ video_id: original, model_name: AGNES_VIDEO_MODEL }).toString();
      if (url.href !== expected.href || init?.method !== 'GET' || init.body !== undefined || headers.get('authorization') !== `Bearer ${secret}` || [...headers.keys()].some(k => k !== 'authorization')) throw denied();
      await budget.reserve('get', original);
    } else {
      if (currentResult?.kind !== 'https' || url.href !== currentResult.url || checkedMediaUrl(url.href).href !== url.href || init?.method !== 'GET' || init.body !== undefined || init.credentials !== 'omit' || [...headers.keys()].length) throw denied();
      await budget.reserve('media', url.hostname);
    }
    const response = await options.fetchImpl(url.href, { ...init, credentials: 'omit', redirect: 'error' });
    if (response.redirected) throw denied(); return response;
  };
  const inner = options.mode === 'create' ? new AgnesProvider({ apiKey: secret!, fetchImpl: guardedTransport, executionKind: 'authorized-real', timeoutMs: 30000, maxResultBytes: 128 * 1024 * 1024 }) : undefined;
  const provider: GenerationProvider = {
    bindingId: 'agnes-authorized-real',
    async create(input, ctx) {
      if (attempted || !inner || closed || stopCode || budget.snapshot().create) throw denied();
      attempted = true;
      try {
        validateContext(ctx, true);
        if (!isB21cRequest(input.request) || input.itemId !== ctx.itemId || input.itemIndex !== 0) throw denied();
        await budget.bind(ctx.itemId, ctx.attemptId);
        await budget.reserve('create');
        await consumeCreateBudget(persistence.markerPath, { experimentId: EXPERIMENT_ID, itemId: ctx.itemId, attemptId: ctx.attemptId, sourceSha: auth.sourceSha, authorizedAt: auth.authorizedAt });
        context = ctx; operation = 'create'; permit = true;
        const accepted = await inner.create(input, ctx);
        if (accepted.externalJobId.includes(secret!)) throw denied();
        await budget.original(accepted.externalJobId);
        if (accepted.status === 'unknown') stop('AUTHORIZED_OUTCOME_UNKNOWN');
        return accepted;
      } catch { stop('AUTHORIZED_CREATE_STOPPED'); throw denied(); }
      finally { permit = false; operation = undefined; context = undefined; options.env.AGNES_REAL_CREATE_ENABLED = 'false'; }
    },
    async get(id, ctx) {
      if (!inner || closed || stopCode || operation) return { status: 'unknown' };
      try {
        validateContext(ctx);
        if (id !== budget.snapshot().originalId) throw denied();
        const lastGetAt = budget.snapshot().lastGetAt;
        // Timer jitter must not dispatch too early; this waits before the first dispatch, never retries it.
        if (lastGetAt !== null && clock() - lastGetAt < 5000) await new Promise(resolve => setTimeout(resolve, 5000 - (clock() - lastGetAt)));
        operation = 'get'; context = ctx;
        const result = await inner.get(id, ctx); currentResult = result.result;
        if (result.status === 'unknown') stop('AUTHORIZED_OUTCOME_UNKNOWN');
        return result;
      } catch {
        // Local observation exhausted/failed: retain the uncertain reservation and pause.
        stop('AUTHORIZED_POLL_STOPPED'); return { status: 'unknown' };
      } finally { operation = undefined; context = undefined; }
    },
    async download(result, ctx) {
      if (!inner || closed || stopCode || operation) throw denied();
      try { validateContext(ctx); operation = 'media'; context = ctx; return await inner.download(result, ctx); }
      catch { stop('AUTHORIZED_DOWNLOAD_STOPPED'); throw denied(); }
      finally { operation = undefined; context = undefined; }
    },
  };
  const policy: ControlledServicePolicy = Object.freeze({
    command: (scope: string) => options.mode === 'create' && (scope === 'create' || ['cancel/','reconcile/','retry-download/'].some(prefix => scope.startsWith(prefix))),
    create: (state: GenerationState, body: unknown, key: string) => options.mode === 'create' && !closed && !stopCode && !budget.snapshot().create && state.items.length === 0 && key === IDEMPOTENCY_KEY && isB21cRequest(body),
  });
  Object.freeze(provider);
  let closeJob: Promise<void> | undefined;
  const session: AuthorizedSession = Object.freeze({ mode: options.mode, store, budget, directory, commonDir: persistence.commonDir, provider, policy,
    request: () => structuredClone(B21C_REQUEST),
    status: () => ({ ...(stopCode ? { stopCode } : {}), createInvocationsObserved: invocationObserved }),
    close() { return closeJob ??= (async () => { closed = true; permit = false; validSessions.delete(session); options.env.AGNES_REAL_CREATE_ENABLED = 'false'; await persistence.close(); })(); },
  });
  validSessions.add(session); return session;
}
