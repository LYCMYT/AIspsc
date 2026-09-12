import { defineConfig, normalizePath, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const workspace = fileURLToPath(new URL('../..', import.meta.url));
// Preserve Vite 8.2.2's default deny list when adding persisted local state.
const deny = [
  '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
  `${normalizePath(workspace)}/artifacts/**`, `${normalizePath(workspace)}/.ai/**`,
];
export function privateFilesPlugin(directories: string[]): Plugin {
  const canonical = (path: string) => {
    const normalized = normalizePath(resolve(path));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const roots = directories.map(canonical);
  return { name: 'private-local-files', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      let path = (request.url ?? '').split('?')[0]!;
      try {
        // Reject encoded forms before Vite's SPA fallback can disguise a denied file as HTTP 200.
        for (let count = 0; count < 3; count++) {
          const decoded = decodeURIComponent(path);
          if (decoded === path) break;
          path = decoded;
        }
      } catch { response.writeHead(400); response.end(); return; }
      if (path.startsWith('/@fs/')) {
        const candidate = canonical(path.slice(5).replace(/^\/([A-Za-z]:\/)/, '$1'));
        if (roots.some(root => candidate === root || candidate.startsWith(root + '/'))) {
          response.writeHead(403, { 'Cache-Control': 'no-store' }); response.end('Forbidden'); return;
        }
      }
      next();
    });
  } };
}
export default defineConfig(({ command, isPreview }) => ({
  define: { 'import.meta.env.LOCAL_HTTP_SERVE': JSON.stringify(command === 'serve' && !isPreview) },
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [privateFilesPlugin([resolve(workspace, 'artifacts'), resolve(workspace, '.ai')]), vue()],
  server: { host: '127.0.0.1', strictPort: true, fs: { allow: [workspace], deny } },
  build: { target: 'es2022' },
}));
