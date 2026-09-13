import fs from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GenerationStore } from '../store.js';
import { EXPERIMENT_ID, digest, type AuthorizationRecord } from './authorized-request.js';

export interface AuthorizedLocation { worktree: string; commonDir: string; sourceSha: string }
const canonical = (p: string) => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
export async function privatePath(path: string): Promise<string> {
  const absolute = resolve(path);
  for (let current = absolute;; current = dirname(current)) {
    let unsafe: boolean;
    try { unsafe = (await fs.lstat(current)).isSymbolicLink(); }
    catch (error) { unsafe = (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
    if (unsafe) throw Error('AUTHORIZED_PATH_INVALID');
    if (dirname(current) === current) break;
  }
  return absolute;
}
export async function discoverAuthorizedLocation(worktree: string): Promise<AuthorizedLocation> {
  // No shell interpolation, environment override or fallback directory.
  const git = async (args: string[]) => (await promisify(execFile)('git', ['-C', worktree, ...args], { windowsHide: true, maxBuffer: 64 * 1024 })).stdout.trim();
  try {
    const top = resolve(await git(['rev-parse', '--show-toplevel']));
    const commonDir = resolve(await git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (canonical(top) !== canonical(worktree)) throw Error();
    const inside = relative(dirname(commonDir), top);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) throw Error();
    if ((await git(['status', '--porcelain', '--untracked-files=no']))) throw Error();
    await privatePath(top); await privatePath(commonDir);
    return { worktree: top, commonDir, sourceSha: await git(['rev-parse', 'HEAD']) };
  } catch { throw Error('AUTHORIZED_GIT_INVALID'); }
}
async function exists(path: string): Promise<boolean> { try { await fs.lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function read(path: string): Promise<unknown> {
  const info = await fs.lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 65536) throw Error('AUTHORIZED_STATE_INVALID');
  return JSON.parse(await fs.readFile(path, 'utf8'));
}
async function syncParent(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dirname(path), 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function exclusive(path: string, value: unknown): Promise<void> {
  const handle = await fs.open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await syncParent(path);
}
export interface AuthorizedCounters {
  version: 1; startedAt: number; deadline: number; create: number; get: number; media: number;
  createInvocations: number; lastGetAt: number | null; resultHost?: string;
  itemId?: string; attemptId?: string; originalId?: string;
}
interface Registry { version: 1; phase: 'initializing' | 'ready'; experimentId: string; worktree: string; directory: string; sourceSha: string; requestHash: string; authorizationHash: string; startedAt: number; deadline: number; epoch?: string }
export class AuthorizedBudget {
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  constructor(private readonly root: string, private counters: AuthorizedCounters, private readonly clock: () => number, private sequence = 0) {}
  snapshot(): AuthorizedCounters { return structuredClone(this.counters); }
  private update(work: (next: AuthorizedCounters) => void): Promise<void> {
    const job = this.queue.then(async () => {
      if (this.failed) throw Error('AUTHORIZED_STATE_INVALID');
      const next = this.snapshot(); work(next);
      try {
        const sequence = this.sequence + 1;
        await exclusive(join(this.root, 'counter-receipts', String(sequence).padStart(6, '0') + '.json'), { sequence, previousHash: digest(this.counters), counters: next });
        this.sequence = sequence; this.counters = next;
      }
      catch { this.failed = true; throw Error('AUTHORIZED_STATE_INVALID'); }
    }); this.queue = job.catch(() => {}); return job;
  }
  async drain(): Promise<void> { await this.queue; }
  bind(itemId: string, attemptId: string): Promise<void> {
    return this.update(c => {
      if ((c.itemId && c.itemId !== itemId) || (c.attemptId && c.attemptId !== attemptId)) throw Error('AUTHORIZED_ID_MISMATCH');
      c.itemId = itemId; c.attemptId = attemptId;
    });
  }
  original(id: string): Promise<void> {
    return this.update(c => {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || (c.originalId && c.originalId !== id)) throw Error('AUTHORIZED_ID_MISMATCH'); c.originalId = id;
    });
  }
  invocation(): Promise<void> { return this.update(c => { if (c.create !== 1 || c.createInvocations) throw Error('CREATE_BUDGET_EXHAUSTED'); c.createInvocations = 1; }); }
  reserve(operation: 'create' | 'get' | 'media', safeIdentity?: string): Promise<void> {
    return this.update(c => {
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < c.startedAt || now >= c.deadline) throw Error('AUTHORIZED_DEADLINE');
      if (operation === 'create' && c.create >= 1) throw Error('CREATE_BUDGET_EXHAUSTED');
      if (operation === 'get' && c.get >= 120) throw Error('AUTHORIZED_GET_LIMIT');
      if (operation === 'media' && c.media >= 2) throw Error('AUTHORIZED_MEDIA_LIMIT');
      if (c.create + c.get + c.media >= 123) throw Error('AUTHORIZED_TOTAL_LIMIT');
      if (operation === 'get') {
        if (c.lastGetAt !== null && now - c.lastGetAt < 5000) throw Error('AUTHORIZED_POLL_INTERVAL');
        if (!safeIdentity || !/^[A-Za-z0-9_-]{1,200}$/.test(safeIdentity) || (c.originalId && c.originalId !== safeIdentity)) throw Error('AUTHORIZED_ID_MISMATCH');
        c.lastGetAt = now;
      }
      if (operation === 'media') {
        if (!safeIdentity || !/^[a-z0-9.-]{1,253}$/.test(safeIdentity)) throw Error('AUTHORIZED_MEDIA_INVALID'); c.resultHost = safeIdentity;
      }
      c[operation]++;
    });
  }
}
function validateCounters(value: unknown, registry: Registry): asserts value is AuthorizedCounters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
  const c = value as AuthorizedCounters;
  const required = ['version','startedAt','deadline','create','get','media','createInvocations','lastGetAt'];
  if (Object.keys(c).some(k => ![...required,'itemId','attemptId','originalId','resultHost'].includes(k)) || required.some(k => !(k in c))) throw Error();
  if (c.version !== 1 || c.startedAt !== registry.startedAt || c.deadline !== registry.deadline || c.deadline !== c.startedAt + 900000) throw Error();
  for (const [key, max] of [['create',1],['get',120],['media',2],['createInvocations',1]] as const) if (!Number.isInteger(c[key]) || c[key] < 0 || c[key] > max) throw Error();
  if (c.createInvocations > c.create || (c.lastGetAt !== null && (!Number.isSafeInteger(c.lastGetAt) || c.lastGetAt < c.startedAt || c.lastGetAt >= c.deadline)) || (c.get === 0) !== (c.lastGetAt === null)) throw Error();
  for (const key of ['itemId','attemptId','originalId'] as const) if (c[key] !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(c[key]!)) throw Error();
  if (Boolean(c.itemId) !== Boolean(c.attemptId) || (c.originalId && (!c.itemId || !c.create))) throw Error();
  if (c.resultHost !== undefined && !/^[a-z0-9.-]{1,253}$/.test(c.resultHost)) throw Error();
}
export async function openAuthorizedPersistence(location: AuthorizedLocation, auth: AuthorizationRecord, mode: 'create' | 'observe', clock: () => number) {
  const worktree = await privatePath(location.worktree); const commonDir = await privatePath(location.commonDir);
  if (!(await fs.stat(worktree)).isDirectory() || !(await fs.stat(commonDir)).isDirectory()) throw Error('AUTHORIZED_PATH_INVALID');
  const directory = await privatePath(join(worktree, '.ai/evidence/B21C/live'));
  const root = await privatePath(join(commonDir, 'aispsc-b21c', EXPERIMENT_ID));
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, 'session.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch { throw Error('AUTHORIZED_SESSION_LOCKED'); }
  let store: GenerationStore | undefined; let budget: AuthorizedBudget | undefined; let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { try { await budget?.drain(); await store?.close(); } finally { await lock.close(); await fs.rm(lockPath); } })();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, experimentId: EXPERIMENT_ID })); await lock.sync();
    const registryPath = join(root, 'registry.json');
    const identity = { version: 1 as const, experimentId: EXPERIMENT_ID, worktree: canonical(worktree), directory: canonical(directory), sourceSha: auth.sourceSha, requestHash: auth.requestHash, authorizationHash: digest(auth) };
    let registry: Registry; let counters: AuthorizedCounters; let sequence = 0;
    if (!(await exists(registryPath))) {
      if (mode !== 'create' || (await fs.readdir(root)).some(name => name !== 'session.lock') || await exists(directory)) throw Error('AUTHORIZED_STATE_INVALID');
      const startedAt = clock(); if (!Number.isSafeInteger(startedAt)) throw Error('AUTHORIZED_STATE_INVALID');
      registry = { ...identity, phase: 'initializing', startedAt, deadline: startedAt + 900000 };
      await exclusive(registryPath, registry);
      counters = { version: 1, startedAt, deadline: registry.deadline, create: 0, get: 0, media: 0, createInvocations: 0, lastGetAt: null };
      await exclusive(join(root, 'counters.json'), counters);
      await fs.mkdir(join(root, 'counter-receipts'), { mode: 0o700 });
      store = await GenerationStore.open(directory);
      registry = { ...registry, phase: 'ready', epoch: store.read().epoch }; await exclusive(join(root, 'ready.json'), registry);
    } else {
      const initializing = await read(registryPath) as Registry;
      registry = await read(join(root, 'ready.json')) as Registry;
      if (digest(initializing) !== digest({ ...identity, phase: 'initializing', startedAt: registry.startedAt, deadline: registry.deadline })) throw Error('AUTHORIZED_STATE_INVALID');
      if (digest(registry) !== digest({ ...identity, phase: 'ready', startedAt: registry.startedAt, deadline: registry.deadline, epoch: registry.epoch }) || !Number.isSafeInteger(registry.startedAt) || registry.deadline !== registry.startedAt + 900000 || typeof registry.epoch !== 'string') throw Error('AUTHORIZED_STATE_INVALID');
      counters = await read(join(root, 'counters.json')) as AuthorizedCounters; validateCounters(counters, registry);
      if (counters.create || counters.get || counters.media || counters.createInvocations || counters.itemId || counters.originalId) throw Error('AUTHORIZED_STATE_INVALID');
      const receiptRoot = await privatePath(join(root, 'counter-receipts'));
      const receipts = (await fs.readdir(receiptRoot)).sort();
      if (receipts.length > 126) throw Error('AUTHORIZED_STATE_INVALID');
      for (const name of receipts) {
        sequence++;
        if (name !== String(sequence).padStart(6, '0') + '.json') throw Error('AUTHORIZED_STATE_INVALID');
        const receipt = await read(join(receiptRoot, name)) as { sequence: number; previousHash: string; counters: AuthorizedCounters };
        if (Object.keys(receipt).sort().join(',') !== 'counters,previousHash,sequence' || receipt.sequence !== sequence || receipt.previousHash !== digest(counters)) throw Error('AUTHORIZED_STATE_INVALID');
        validateCounters(receipt.counters, registry);
        const next = receipt.counters;
        for (const key of ['create','get','media','createInvocations'] as const) if (next[key] < counters[key] || next[key] > counters[key] + 1) throw Error('AUTHORIZED_STATE_INVALID');
        for (const key of ['itemId','attemptId','originalId'] as const) if (counters[key] && counters[key] !== next[key]) throw Error('AUTHORIZED_STATE_INVALID');
        if (counters.lastGetAt !== null && (next.lastGetAt === null || next.lastGetAt < counters.lastGetAt)) throw Error('AUTHORIZED_STATE_INVALID');
        counters = next;
      }
      // Never let the normal Store's missing-file initialization run on recovery.
      const state = await read(join(directory, 'state.json')) as { epoch?: string };
      if (state.epoch !== registry.epoch) throw Error('AUTHORIZED_STATE_INVALID');
      const marker = await exists(join(root, 'create-budget.json'));
      if (marker && !counters.create) throw Error('AUTHORIZED_STATE_INVALID');
      store = await GenerationStore.open(directory);
      const s = store.read();
      if (s.items.length > 1 || s.assets.length || s.evaluations.length || (counters.itemId && !s.items.some(i => i.id === counters.itemId)) || (counters.attemptId && !s.attempts.some(a => a.attemptId === counters.attemptId)) || (counters.originalId && s.attempts[0]?.externalJobId !== counters.originalId)) throw Error('AUTHORIZED_STATE_INVALID');
      if (counters.create && !counters.itemId) throw Error('AUTHORIZED_STATE_INVALID');
      // A Create-mode restart may observe/replay but cannot replenish an exhausted budget.
    }
    budget = new AuthorizedBudget(root, counters, clock, sequence);
    return { store, budget, directory, commonDir, markerPath: join(root, 'create-budget.json'), close };
  } catch { await close(); throw Error('AUTHORIZED_STATE_INVALID'); }
}
