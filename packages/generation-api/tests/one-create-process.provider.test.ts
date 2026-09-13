import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface Report { outcome?: string; pid?: number; exitCode: number | null }
async function fixture() {
  const parent = resolve('.cache/generation-tests/one-create-process');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'case-'));
}
function start(directory: string, stage = 'normal') {
  const child = fork(resolve('packages/generation-api/tests/helpers/one-create-child.mjs'), [directory, stage], {
    cwd: process.cwd(), execArgv: [], silent: true,
    env: { ...process.env, AGNES_API_KEY: '', PROVIDER_MODE: 'fake', AGNES_REAL_CREATE_ENABLED: 'false' },
  });
  let report: Omit<Report, 'exitCode'> = {};
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  let markReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; rejectReady = reject; });
  const completed = new Promise<Report>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('CHILD_TIMEOUT')); }, 15000);
    child.on('error', error => { clearTimeout(timer); rejectReady(error); reject(error); });
    child.on('message', message => {
      const value = message as { ready?: boolean; outcome?: string; pid?: number };
      if (value.ready) markReady();
      else report = value;
    });
    child.on('exit', exitCode => {
      clearTimeout(timer);
      rejectReady(Error(`CHILD_EXIT_BEFORE_READY: ${stderr}`));
      if (exitCode === 1) reject(Error(`CHILD_FAILED: ${stderr}`));
      else resolve({ ...report, exitCode });
    });
  });
  return { ready, completed, go: () => child.send('go') };
}
async function run(directory: string, stage = 'normal') {
  const child = start(directory, stage);
  await child.ready;
  child.go();
  return child.completed;
}
async function invocations(directory: string) {
  try {
    return (await readFile(join(directory, 'observed-invocations.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

it('racing processes permit one create and a third process cannot reuse the budget', async () => {
  const directory = await fixture();
  const children = [start(directory), start(directory)];
  await Promise.all(children.map(child => child.ready));
  children.forEach(child => child.go());
  const outcomes = await Promise.all(children.map(child => child.completed));
  expect(outcomes.map(report => report.outcome).sort()).toEqual(['CREATE_BUDGET_EXHAUSTED', 'permitted']);
  expect(new Set(outcomes.map(report => report.pid)).size).toBe(2);
  expect(outcomes.map(report => report.exitCode)).toEqual([0, 0]);
  const restarted = await run(directory);
  expect(restarted.outcome).toBe('CREATE_BUDGET_EXHAUSTED');
  expect(await invocations(directory)).toHaveLength(1);
});

it.each([
  { stage: 'before-write', exitCode: 81, calls: 0, empty: true },
  { stage: 'after-write', exitCode: 82, calls: 0, empty: false },
  { stage: 'before-dispatch', exitCode: 83, calls: 0, empty: false },
  { stage: 'after-dispatch', exitCode: 84, calls: 1, empty: false },
])('retains consumed intent across a process exit at $stage without inferring dispatch', async ({ stage, exitCode, calls, empty }) => {
  const directory = await fixture();
  expect((await run(directory, stage)).exitCode).toBe(exitCode);
  const bytes = await readFile(join(directory, 'create-consumed.json'), 'utf8');
  if (empty) expect(bytes).toBe('');
  else expect(JSON.parse(bytes).createBudgetConsumed).toBe(1);
  expect(await invocations(directory)).toHaveLength(calls);
  expect((await run(directory)).outcome).toBe('CREATE_BUDGET_EXHAUSTED');
  expect(await readFile(join(directory, 'create-consumed.json'), 'utf8')).toBe(bytes);
  expect(await invocations(directory)).toHaveLength(calls);
});
