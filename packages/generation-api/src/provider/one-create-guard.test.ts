import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { consumeCreateBudget } from './one-create-guard.ts';

const identity = {
  experimentId: 'B21C-2026-09-13', itemId: 'item-test', attemptId: 'attempt-test',
  sourceSha: '0'.repeat(40), authorizedAt: '2026-09-13T00:00:00Z',
};
let markerPath: string;
beforeEach(async () => {
  const parent = resolve('.cache/generation-tests/one-create-unit');
  await fs.mkdir(parent, { recursive: true });
  markerPath = join(await fs.mkdtemp(join(parent, 'case-')), 'create-consumed.json');
});
afterEach(() => vi.restoreAllMocks());

it('persists consumed intent and refuses a second attempt, even with a different identity', async () => {
  await consumeCreateBudget(markerPath, identity);
  const bytes = await fs.readFile(markerPath, 'utf8');
  expect(JSON.parse(bytes)).toEqual({ version: 1, createBudgetConsumed: 1, ...identity });
  await expect(consumeCreateBudget(markerPath, { ...identity, attemptId: 'other' }))
    .rejects.toThrow('CREATE_BUDGET_EXHAUSTED');
  expect(await fs.readFile(markerPath, 'utf8')).toBe(bytes);
  if (process.platform !== 'win32') expect((await fs.stat(markerPath)).mode & 0o777).toBe(0o600);
});

it('allows exactly one concurrent consumer on an actual filesystem', async () => {
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => consumeCreateBudget(markerPath, identity)));
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(11);
});

it.each(['', '{broken', 'null'])('fails closed for pre-existing marker bytes %j', async bytes => {
  await fs.writeFile(markerPath, bytes);
  await expect(consumeCreateBudget(markerPath, identity)).rejects.toThrow('CREATE_BUDGET_EXHAUSTED');
  expect(await fs.readFile(markerPath, 'utf8')).toBe(bytes);
});

it('redacts filesystem paths when exclusive open fails', async () => {
  await expect(consumeCreateBudget(join(markerPath, 'sensitive-location'), identity))
    .rejects.toThrow(/^CREATE_BUDGET_EXHAUSTED$/);
});

it.each(['writeFile', 'sync', 'close'] as const)('retains the marker and redacts a %s failure', async operation => {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === markerPath) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, operation).mockImplementation(async () => {
        if (operation === 'close') await close();
        throw Error('private-path-and-sensitive-error');
      });
    }
    return handle;
  });
  await expect(consumeCreateBudget(markerPath, identity)).rejects.toThrow(/^CREATE_BUDGET_PERSIST_FAILED$/);
  expect((await fs.stat(markerPath)).isFile()).toBe(true);
  await expect(consumeCreateBudget(markerPath, identity)).rejects.toThrow(/^CREATE_BUDGET_EXHAUSTED$/);
});

it('finishes file sync before permitting dispatch and syncs the parent directory on Linux', async () => {
  const open = fs.open.bind(fs);
  const events: string[] = [];
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      await sync();
      events.push(args[0] === markerPath ? 'file-sync' : 'directory-sync');
    });
    return handle;
  });
  await consumeCreateBudget(markerPath, identity);
  events.push('dispatch-permitted');
  expect(events).toEqual(process.platform === 'win32'
    ? ['file-sync', 'dispatch-permitted']
    : ['file-sync', 'directory-sync', 'dispatch-permitted']);
});

it.each(['throw', 'timeout'] as const)('cannot dispatch again after simulated create %s', async failure => {
  let observedInvocations = 0;
  const create = async () => {
    await consumeCreateBudget(markerPath, identity);
    observedInvocations++;
    if (failure === 'timeout') {
      await Promise.race([
        new Promise<never>(() => { /* Simulated transport never returns its response. */ }),
        new Promise<never>((_, reject) => setTimeout(() => reject(Error('timeout')), 5)),
      ]);
    }
    throw Error(failure);
  };
  await expect(create()).rejects.toThrow(failure);
  await expect(create()).rejects.toThrow('CREATE_BUDGET_EXHAUSTED');
  expect(observedInvocations).toBe(1);
});
