import { expect, it, vi } from 'vitest';
import { renameSnapshot } from './store-rename.js';
const denied = (code: string) => Object.assign(Error('synthetic filesystem failure'), { code });
it.each(['EPERM','EBUSY'])('retries transient Windows %s only on the identical flushed snapshot', async code => {
  const rename = vi.fn().mockRejectedValueOnce(denied(code)).mockRejectedValueOnce(denied(code)).mockResolvedValue(undefined);
  const sleep = vi.fn(async () => {});
  await renameSnapshot('synthetic.pending', 'synthetic-state.json', { platform: 'win32', rename, sleep });
  expect(rename.mock.calls).toEqual(Array.from({ length: 3 }, () => ['synthetic.pending','synthetic-state.json']));
  expect(sleep.mock.calls).toEqual([[20],[40]]);
});
it('retains the original error after five Windows attempts and only 300 ms of bounded waits', async () => {
  const failure = denied('EPERM'); const rename = vi.fn().mockRejectedValue(failure); const sleep = vi.fn(async () => {});
  await expect(renameSnapshot('synthetic.pending', 'synthetic-state.json', { platform: 'win32', rename, sleep })).rejects.toBe(failure);
  expect(rename).toHaveBeenCalledTimes(5); expect(sleep.mock.calls).toEqual([[20],[40],[80],[160]]);
});
it.each(['EIO','EACCES','ENOENT','UNKNOWN'])('does not retry Windows %s', async code => {
  const failure = denied(code); const rename = vi.fn().mockRejectedValue(failure); const sleep = vi.fn(async () => {});
  await expect(renameSnapshot('synthetic.pending', 'synthetic-state.json', { platform: 'win32', rename, sleep })).rejects.toBe(failure);
  expect(rename).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
});
it('does not retry a non-Windows EPERM', async () => {
  const failure = denied('EPERM'); const rename = vi.fn().mockRejectedValue(failure); const sleep = vi.fn(async () => {});
  await expect(renameSnapshot('synthetic.pending', 'synthetic-state.json', { platform: 'linux', rename, sleep })).rejects.toBe(failure);
  expect(rename).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
});
