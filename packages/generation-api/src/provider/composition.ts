import type { FixtureCatalog } from '../fixtures.js';
import { DeterministicFakeProvider } from './fake-provider.js';
import { ProviderOperationError, type GenerationProvider } from './port.js';

/** This runtime has no environment switch that enables real provider traffic. */
export function assertProviderStage(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AGNES_REAL_CREATE_ENABLED?.trim().toLowerCase() === 'true') {
    if (env.CI && env.CI !== 'false' && env.CI !== '0') throw Error('REAL_PROVIDER_CALL_FORBIDDEN_IN_CI');
    throw Error('REAL_PROVIDER_CALL_OUTSIDE_STAGE');
  }
}

export function composeProvider(options: { fixtures: FixtureCatalog; env?: NodeJS.ProcessEnv }): GenerationProvider {
  const env = options.env ?? process.env;
  assertProviderStage(env);
  const mode = env.PROVIDER_MODE ?? 'fake';
  if (mode === 'fake') return new DeterministicFakeProvider(options.fixtures);
  if (mode !== 'agnes') throw Error('INVALID_PROVIDER_MODE');
  // The sole runtime credential boundary deliberately does not pass it to any transport.
  void env.AGNES_API_KEY;
  const deny = async (): Promise<never> => { throw new ProviderOperationError('REAL_PROVIDER_CREATE_DISABLED', 'invalid_request', 'not_submitted'); };
  return { bindingId: 'agnes-disabled', create: deny, get: deny, download: deny };
}
