import { readFile, lstat, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startAuthorizedLocalGeneration } from './start.ts';
import type { AuthorizedSessionOptions } from '../src/provider/authorized-session.js';

export function parseAuthorizedArguments(args: string[]): 'create' | 'observe' {
  if (args.length === 1 && args[0] === '--execute-one-create') return 'create';
  if (args.length === 1 && args[0] === '--observe') return 'observe';
  throw Error('AUTHORIZED_ARGUMENTS_INVALID');
}
const denyCI = (env: NodeJS.ProcessEnv) => { if (env.CI && env.CI !== 'false' && env.CI !== '0') throw Error('REAL_PROVIDER_CALL_FORBIDDEN_IN_CI'); };
type Started = Awaited<ReturnType<typeof startAuthorizedLocalGeneration>>;
export interface AuthorizedRunOptions {
  session: AuthorizedSessionOptions; port?: number; apiPort?: number; signal?: AbortSignal;
  /** Test dependencies never replace Worker, Store, provider adapter or FFmpeg. */
  start?: typeof startAuthorizedLocalGeneration; httpFetch?: typeof fetch;
  onStarted?: (app: Started) => Promise<void>;
}
export async function runAuthorizedExperiment(options: AuthorizedRunOptions): Promise<{ code: string; itemId?: string; evidenceFile: string }> {
  denyCI(options.session.env);
  if (options.session.mode !== 'create') throw Error('AUTHORIZED_ARGUMENTS_INVALID');
  const app = await (options.start ?? startAuthorizedLocalGeneration)({ session: options.session, port: options.port, apiPort: options.apiPort });
  let code = 'AUTHORIZED_STOPPED';
  const timeline: Array<{ at: string; itemStatus: string; submissionState: string }> = [];
  let previous = '';
  const evidenceFile = `session-summary-${randomUUID()}.json`;
  try {
    const request = app.session.request();
    const response = await (options.httpFetch ?? fetch)(app.url + '/api/v1/generation-batches', {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'idempotency-key': 'b21c-2026-09-13-one' }, body: JSON.stringify(request),
    });
    if (response.status !== 202) throw Error('AUTHORIZED_HTTP_REFUSED');
    await options.onStarted?.(app);
    for (;;) {
      if (app.workerStatus().errorCode === 'STORAGE_UNAVAILABLE') {
        options.session.env.AGNES_REAL_CREATE_ENABLED = 'false';
        code = 'AUTHORIZED_STORAGE_STOPPED'; break;
      }
      const state = app.session.store.read(); const item = state.items[0]; const attempt = state.attempts[0];
      if (state.items.length !== 1 || !item || !attempt || state.assets.length || state.evaluations.length || item.reviewState !== 'pending' || item.libraryState !== 'not_saved') throw Error('AUTHORIZED_STATE_INVALID');
      const current = `${item.status}/${attempt.submissionState}`;
      if (current !== previous) { timeline.push({ at: new Date().toISOString(), itemStatus: item.status, submissionState: attempt.submissionState }); previous = current; }
      if (item.status === 'succeeded') {
        if (!attempt.rawMedia || !attempt.derivativeEvidence || attempt.derivativeEvidence.media.isDemo !== false || !item.resultAvailable) throw Error('AUTHORIZED_MEDIA_INVALID');
        // Reading the original verified media route independently rechecks the finalized bytes/report.
        const media = await (options.httpFetch ?? fetch)(app.url + '/api/v1/media/' + encodeURIComponent(item.resultMediaId!) + '/file', { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000) });
        if (!media.ok) throw Error('AUTHORIZED_MEDIA_INVALID'); await media.arrayBuffer();
        code = 'AUTHORIZED_SUCCEEDED_PENDING_REVIEW'; break;
      }
      if (options.signal?.aborted || app.session.status().stopCode || Date.now() >= app.session.budget.snapshot().deadline || item.errorCode || ['failed','cancelled','needs_reconciliation'].includes(item.status) || attempt.submissionState === 'needs_reconciliation') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } catch { code = 'AUTHORIZED_STOPPED'; }
  finally {
    await app.stopWorker();
    try {
      const state = app.session.store.read(); const attempt = state.attempts[0];
      const summary = { version: 1, code, productTarget: app.session.request(),
        providerRequest: { model: 'agnes-video-v2.0', prompt: app.session.request().prompt, width: 1280, height: 720, num_frames: 121, frame_rate: 24 },
        counters: app.session.budget.snapshot(), observation: app.session.status(), workerStatus: app.workerStatus(), timeline,
        ...(state.items[0] ? { itemId: state.items[0].id, itemStatus: state.items[0].status, reviewState: state.items[0].reviewState, libraryState: state.items[0].libraryState } : {}),
        ...(attempt?.reported ? { reported: attempt.reported } : {}), ...(attempt?.rawMedia ? { raw: attempt.rawMedia } : {}), ...(attempt?.derivativeEvidence ? { derivative: attempt.derivativeEvidence } : {}),
        evaluationCount: state.evaluations.length, assetCount: state.assets.length, actualCost: null,
      };
      const handle = await open(join(app.session.directory, evidenceFile), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(summary)); await handle.sync(); } finally { await handle.close(); }
    } finally { await app.close(); }
  }
  return { code, ...(app.session.store.read().items[0] ? { itemId: app.session.store.read().items[0]!.id } : {}), evidenceFile };
}

// Real transport is only constructed in this explicitly executed CLI branch.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    denyCI(process.env);
    const mode = parseAuthorizedArguments(process.argv.slice(2));
    const worktree = fileURLToPath(new URL('../../..', import.meta.url));
    const authorizationPath = join(worktree, '.ai/evidence/B21C/authorization.json');
    const session: AuthorizedSessionOptions = { mode, explicitOptIn: true, env: process.env, worktree,
      authorization: async () => {
        const info = await lstat(authorizationPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw Error('AUTHORIZED_RECORD_INVALID');
        return JSON.parse(await readFile(authorizationPath, 'utf8'));
      },
      fetchImpl: mode === 'create' ? (input, init) => globalThis.fetch(input, init) : async () => { throw Error('AUTHORIZED_READONLY'); },
    };
    if (mode === 'observe') {
      const app = await startAuthorizedLocalGeneration({ session });
      console.log('AUTHORIZED_READONLY http://127.0.0.1:5173');
      for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
    } else {
      const controller = new AbortController();
      for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => controller.abort());
      const result = await runAuthorizedExperiment({ session, signal: controller.signal });
      console.log(JSON.stringify(result));
      if (result.code !== 'AUTHORIZED_SUCCEEDED_PENDING_REVIEW') process.exitCode = 1;
    }
  } catch { console.error('AUTHORIZED_START_OR_RUN_REFUSED'); process.exitCode = 1; }
}
