import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const script = resolve('scripts/provider-ci-guard.mjs');
describe('ordinary gate process Provider call guard', () => {
  it('fails before a gate can run when real Create is enabled in CI', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { CI: 'true', AGNES_REAL_CREATE_ENABLED: 'true' } });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('REAL_PROVIDER_CALL_FORBIDDEN_IN_CI');
    expect(result.stdout).toBe('');
  });
  it('also refuses the real opt-in outside CI during B2.1B', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { AGNES_REAL_CREATE_ENABLED: 'true' } });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('REAL_PROVIDER_CREATE_DISABLED');
  });
  it('allows ordinary simulation without printing environment values', () => {
    const output = execFileSync(process.execPath, [script], { encoding: 'utf8', env: { CI: 'true', AGNES_REAL_CREATE_ENABLED: 'false' } });
    expect(output).toBe('');
  });
});
