import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixtureCatalog } from '../fixtures.js';
import { composeProvider } from './composition.js';
describe('provider composition denies real networking', () => {
  it('defaults fake even with a key', async () => {
    const fixtures = await FixtureCatalog.open(resolve('apps/web/public/demo'));
    expect(composeProvider({ fixtures, env: { AGNES_API_KEY: randomUUID() } }).bindingId).toBe('fake-local');
  });
  it('returns denied Agnes without any real fetch calls', async () => {
    const fixtures = await FixtureCatalog.open(resolve('apps/web/public/demo'));
    const provider = composeProvider({ fixtures, env: { PROVIDER_MODE: 'agnes', AGNES_API_KEY: randomUUID() } });
    expect(provider.bindingId).toBe('agnes-disabled');
    await expect(provider.create({} as never, {} as never)).rejects.toMatchObject({ code: 'REAL_PROVIDER_CREATE_DISABLED', submissionCertainty: 'not_submitted' });
  });
  it.each(['true', '1'])('rejects real flag in CI=%s before composition', async CI => {
    expect(() => composeProvider({ fixtures: {} as never, env: { CI, AGNES_REAL_CREATE_ENABLED: 'true' } })).toThrow('REAL_PROVIDER_CALL_FORBIDDEN_IN_CI');
  });
  it('rejects real enabling outside CI and unknown modes', () => {
    expect(() => composeProvider({ fixtures: {} as never, env: { AGNES_REAL_CREATE_ENABLED: 'true' } })).toThrow('REAL_PROVIDER_CALL_OUTSIDE_STAGE');
    expect(() => composeProvider({ fixtures: {} as never, env: { PROVIDER_MODE: 'unknown' } })).toThrow('INVALID_PROVIDER_MODE');
  });
});
