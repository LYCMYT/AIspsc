import { randomBytes } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, normalizePath, type ViteDevServer } from 'vite';
import type { startGenerationApi } from '../src/server.js';
import type { GenerationProvider } from '../src/provider/port.js';
import { privateFilesPlugin } from '../../../apps/web/vite.config.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
function port(value: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) throw Error('INVALID_LOCAL_PORT');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > 65535) throw Error('INVALID_LOCAL_PORT');
  return parsed;
}

export async function startLocalGeneration(options: { port?: number; apiPort?: number; directory?: string; token?: string; provider?: GenerationProvider } = {}) {
  const frontendPort = port(String(options.port ?? 5173));
  const apiPort = port(String(options.apiPort ?? 8788), true);
  const directory = resolve(root, options.directory ?? 'artifacts/local-generation');
  const within = relative(root, directory);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw Error('LOCAL_DATA_MUST_BE_IN_WORKSPACE');
  // Vite public files bypass fs.deny and are copied into builds; state must never live there.
  const publicRelative = relative(resolve(root, 'apps/web/public'), directory);
  if (!publicRelative || (!isAbsolute(publicRelative) && publicRelative !== '..' && !publicRelative.startsWith('..' + sep))) {
    throw Error('LOCAL_DATA_MUST_BE_PRIVATE');
  }
  const token = options.token ?? randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${frontendPort}`;
  const loader = await createServer({
    configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom', logLevel: 'error',
  });
  let api: Awaited<ReturnType<typeof startGenerationApi>> | undefined;
  let web: ViteDevServer | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await web?.close(); }
    finally { try { await api?.close(); } finally { await loader.close(); } }
  })();
  try {
    const module = await loader.ssrLoadModule('/packages/generation-api/src/server.ts') as { startGenerationApi: typeof startGenerationApi };
    api = await module.startGenerationApi({ directory, fixtureRoot: resolve(root, 'apps/web/public/demo'), token, port: apiPort, allowedOrigins: [origin], provider: options.provider });
    web = await createServer({
      configFile: resolve(root, 'apps/web/vite.config.ts'), mode: 'local-http',
      server: {
        host: '127.0.0.1', port: frontendPort, strictPort: true,
        fs: { deny: [`${normalizePath(directory)}/**`] },
        proxy: {
          '^/api/v1(?:/|$)': {
            target: api.url, changeOrigin: true, rewrite: path => path.slice(4),
            configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Authorization', `Bearer ${token}`)); },
          },
        },
      },
      plugins: [privateFilesPlugin([directory]), { name: 'local-api-boundary', configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/api/')) return next();
          if (request.headers.host !== `127.0.0.1:${frontendPort}`
            || (request.headers.origin !== undefined && request.headers.origin !== origin)
            || request.headers['sec-fetch-site'] === 'cross-site') {
            response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: '本地演示请求无法完成' } }));
            return;
          }
          next();
        });
      } }],
    });
    await web.listen();
    return { url: origin, apiUrl: api.url, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--port')) throw Error('INVALID_LOCAL_ARGUMENTS');
    const service = await startLocalGeneration({
      port: port(args[1] ?? '5173'), apiPort: port(process.env.GENERATION_API_PORT ?? '8788', true),
      directory: process.env.GENERATION_DATA_DIR, token: process.env.GENERATION_API_TOKEN,
    });
    console.log(`Local fake generation: ${service.url} (API ${service.apiUrl}); fixture outputs only.`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close().catch(() => { process.exitCode = 1; }); });
  } catch { console.error('Local generation startup failed; check ports, workspace data and operator lock.'); process.exitCode = 1; }
}
