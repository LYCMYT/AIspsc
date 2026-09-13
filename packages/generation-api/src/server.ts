import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { DomainErrorCode, Result } from '../../contracts/src/index.js';
import { validateHttpBody } from '../../contracts/src/index.js';
import { GenerationStore } from './store.js';
import { GenerationApiService } from './service.js';
import { FixtureCatalog } from './fixtures.js';
import { GenerationWorker } from './worker.js';
import { GenerationMediaRepository } from './media-repository.js';
import { assertProviderStage, composeProvider } from './provider/composition.js';
import type { GenerationProvider } from './provider/port.js';
import { assertAuthorizedSession, type AuthorizedSession } from './provider/authorized-session.js';
import { assertControlledEnvironment } from './provider/authorized-request.js';

const limit = 64 * 1024;
class TransportError extends Error {
  constructor(readonly status: number, readonly code: DomainErrorCode) { super(code); }
}
function statusFor(code: DomainErrorCode): number {
  if (code === 'STORAGE_UNAVAILABLE') return 503;
  if (code === 'NO_COMPATIBLE_MODEL') return 422;
  if (code === 'TASK_NOT_READY' || code === 'MEDIA_UNAVAILABLE' || code === 'ASSET_NOT_FOUND') return 404;
  if (code === 'FORBIDDEN' || code === 'ASSET_FORBIDDEN') return 403;
  if (['INVALID_PARAMETERS', 'PROMPT_REQUIRED', 'REFERENCE_ROLE_DUPLICATE', 'REFERENCE_TYPE_MISMATCH'].includes(code)) return 400;
  return 409;
}
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
function failure(response: ServerResponse, status: number, code: DomainErrorCode, field?: string) {
  // Transport owns fixed messages: neither exception text nor untrusted input is echoed.
  json(response, status, { ok: false, error: { code, message: '本地演示请求无法完成', ...(field ? { field } : {}) } });
}
function result(response: ServerResponse, value: Result<unknown>, success = 200) {
  if (value.ok) json(response, success, value);
  else failure(response, statusFor(value.error.code), value.error.code);
}
function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new TransportError(400, 'INVALID_PARAMETERS');
  const declared = request.headers['content-length'];
  if (declared && Number(declared) > limit) {
    request.resume();
    throw new TransportError(413, 'INVALID_PARAMETERS');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        // Keep draining instead of destroying the socket, so the client receives JSON 413.
        reject(new TransportError(413, 'INVALID_PARAMETERS'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new TransportError(400, 'INVALID_PARAMETERS')); }
    });
    request.on('error', () => { if (!settled) { settled = true; reject(new TransportError(400, 'INVALID_PARAMETERS')); } });
  });
}

export async function startGenerationApi(options: {
  directory: string; fixtureRoot: string; token: string; port: number;
  allowedOrigins: string[]; workerIntervalMs?: number; provider?: GenerationProvider; authorizedSession?: AuthorizedSession;
}): Promise<{ url: string; store: GenerationStore; service: GenerationApiService; worker: GenerationWorker; close(): Promise<void> }> {
  const session = options.authorizedSession;
  if (session) {
    assertControlledEnvironment(process.env); assertAuthorizedSession(session);
    if (options.directory !== session.directory || options.provider || (options.workerIntervalMs !== undefined && options.workerIntervalMs !== 5000)) throw Error('INVALID_AUTHORIZED_SESSION');
  } else {
    assertProviderStage();
    if (options.provider?.bindingId === 'agnes-authorized-real') throw Error('INVALID_AUTHORIZED_SESSION');
  }
  if (!options.token || /[\r\n]/.test(options.token) || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw Error('INVALID_API_CONFIGURATION');
  const origins = new Set(options.allowedOrigins);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw Error('INVALID_API_CONFIGURATION');
  }
  const fixtures = await FixtureCatalog.open(options.fixtureRoot);
  const provider = session?.provider ?? options.provider ?? composeProvider({ fixtures });
  const store = session?.store ?? await GenerationStore.open(options.directory);
  const closeStore = () => session ? session.close() : store.close();
  let repository: GenerationMediaRepository;
  try { repository = await GenerationMediaRepository.open(options.directory, fixtures); }
  catch (error) { await closeStore(); throw error; }
  const reader: Pick<FixtureCatalog, 'readMedia'> = { readMedia: media => repository.readMedia(media,
    store.read().attempts.find(attempt => attempt.derivativeEvidence?.media.id === media.id)?.derivativeEvidence) };
  const service = new GenerationApiService(store, fixtures, Date.now, reader, session?.policy);
  const worker = new GenerationWorker(store, provider, fixtures, repository);
  const expectedAuth = Buffer.from(`Bearer ${options.token}`);
  let host = '';
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      request.resume();
      if (!response.headersSent) {
        if (error instanceof TransportError) failure(response, error.status, error.code);
        else failure(response, 503, 'STORAGE_UNAVAILABLE');
      } else response.end();
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== host || (request.headers.origin !== undefined && !origins.has(request.headers.origin))) throw new TransportError(403, 'FORBIDDEN');
    const auth = Buffer.from(request.headers.authorization ?? '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) throw new TransportError(401, 'FORBIDDEN');
    const rawPath = request.url ?? '';
    if (!rawPath.startsWith('/') || rawPath.includes('?') || rawPath.includes('#')) throw new TransportError(404, 'TASK_NOT_READY');
    let path: string;
    try { path = decodeURIComponent(rawPath); } catch { throw new TransportError(400, 'INVALID_PARAMETERS'); }
    if (request.method === 'GET') {
      const snapshot = service.snapshot();
      let value: unknown;
      if (path === '/v1/snapshot') value = snapshot;
      else if (path === '/v1/generation-batches') value = snapshot.batches;
      else if (path === '/v1/assets') value = snapshot.assets;
      else if (path === '/v1/quota') value = snapshot.credits;
      else {
        const match = /^\/v1\/(generation-batches|generation-items|media)\/([^/\\]+)(\/file)?$/.exec(path);
        if (!match || (match[3] && match[1] !== 'media')) throw new TransportError(404, 'TASK_NOT_READY');
        if (match[1] === 'media') {
          const media = snapshot.mediaMetadata.find(row => row.id === match[2]);
          if (!media) throw new TransportError(404, 'MEDIA_UNAVAILABLE');
          try {
            const verified = await reader.readMedia(media);
            if (match[3]) {
              response.writeHead(200, { 'Content-Type': verified.media.mime, 'Content-Length': verified.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
              response.end(verified.bytes);
              return;
            }
            value = verified.media;
          } catch { throw new TransportError(404, 'MEDIA_UNAVAILABLE'); }
        } else {
          value = (match[1] === 'generation-batches' ? snapshot.batches : snapshot.items).find(row => row.id === match[2]);
          if (!value) throw new TransportError(404, 'TASK_NOT_READY');
        }
      }
      json(response, 200, { ok: true, value });
      return;
    }
    if (request.method !== 'POST') throw new TransportError(404, 'TASK_NOT_READY');
    const match = /^\/v1\/generation-items\/([^/\\]+)\/(cancel|retry|reconcile|retry-download|reviews|assets)$/.exec(path);
    if (!match && !['/v1/generation-batches', '/v1/fixtures', '/v1/scenario'].includes(path)) throw new TransportError(404, 'TASK_NOT_READY');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new TransportError(400, 'INVALID_PARAMETERS');
    const body = await readJson(request);
    if (path === '/v1/generation-batches') { result(response, await service.create(body, key), 202); return; }
    const action = match?.[2];
    const id = match?.[1] ?? '';
    if (path === '/v1/fixtures') {
      const v = validateHttpBody('fixture', body); result(response, v.ok ? await service.loadFixture(v.value, key) : v); return;
    }
    if (path === '/v1/scenario') {
      const v = validateHttpBody('scenario', body); result(response, v.ok ? await service.setScenario(v.value, key) : v); return;
    }
    if (action === 'reviews') {
      const v = validateHttpBody('review', body); result(response, v.ok ? await service.review(id, v.value, key) : v); return;
    }
    if (action === 'assets') {
      const v = validateHttpBody('save', body); result(response, v.ok ? await service.saveAsset(id, v.value, key) : v); return;
    }
    if (action === 'reconcile') {
      const v = validateHttpBody('reconcile', body); result(response, v.ok ? await service.reconcile(id, v.value, key) : v); return;
    }
    const v = validateHttpBody('version', body);
    if (!v.ok) { result(response, v); return; }
    if (action === 'cancel') result(response, await service.cancel(id, v.value, key));
    else if (action === 'retry') result(response, await service.retry(id, v.value, key), 202);
    else result(response, await service.retryDownload(id, v.value, key), 202);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('API_START_FAILED');
    host = `127.0.0.1:${address.port}`;
    if (session?.mode !== 'observe') worker.start(session ? 5000 : options.workerIntervalMs);
  } catch {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.stop();
    await closeStore();
    throw Error('API_START_FAILED');
  }
  let closing: Promise<void> | undefined;
  return { url: `http://${host}`, store, service, worker, close() {
    closing ??= (async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      try { await worker.stop(); } finally { await closeStore(); }
    })();
    return closing;
  } };
}
