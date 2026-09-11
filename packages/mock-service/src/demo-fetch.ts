/** Scope only the mock service's root-relative fixture paths to the host app's base.
 * Keeps the domain/mock package independent of Vite and browser location globals.
 */
export function createDemoFetcher(basePath: string, fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)): typeof fetch {
  const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return (input, init) => fetchImpl(
    typeof input === 'string' && input.startsWith('/demo/') ? `${prefix}${input.slice(1)}` : input,
    init,
  );
}
