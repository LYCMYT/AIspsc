import { expect, it, vi } from 'vitest';
import { parseAuthorizedArguments, runAuthorizedExperiment } from './b21c-authorized.js';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
it('accepts only explicit fixed create or readonly entry and refuses directory/reset overrides', () => {
  expect(parseAuthorizedArguments(['--execute-one-create'])).toBe('create');
  expect(parseAuthorizedArguments(['--observe'])).toBe('observe');
  for (const args of [[], ['--execute-one-create','--directory','other'], ['--reset'], ['--observe','--execute-one-create']]) expect(() => parseAuthorizedArguments(args)).toThrow('AUTHORIZED_ARGUMENTS_INVALID');
});
it('runner rejects CI before constructing resources or reading authorization/key', async () => {
  const start = vi.fn(); const read = vi.fn();
  await expect(runAuthorizedExperiment({ session: { mode: 'create', explicitOptIn: true, env: { CI: 'true' }, authorization: read, fetchImpl: vi.fn() }, start })).rejects.toThrow('REAL_PROVIDER_CALL_FORBIDDEN_IN_CI');
  expect(start).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it('the native Node CLI boots and denies CI before any fixed authorization/registry access', () => {
  const child = spawnSync(process.execPath, [resolve('packages/generation-api/scripts/b21c-authorized.ts'), '--execute-one-create'], {
    env: { ...process.env, CI: 'true', AGNES_API_KEY: '', AGNES_REAL_CREATE_ENABLED: 'false', PROVIDER_MODE: 'fake' }, encoding: 'utf8', windowsHide: true,
  });
  expect(child.status).toBe(1); expect(child.stdout).toBe(''); expect(child.stderr.trim()).toBe('AUTHORIZED_START_OR_RUN_REFUSED');
});
