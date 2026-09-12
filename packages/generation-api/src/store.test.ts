import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path, { resolve, join, posix, win32 } from 'node:path';
import { GenerationStore } from './store.js';

function cleanupChild(root: string, directory: string, paths = path): boolean {
    const relative = paths.relative(root, directory);
    return relative !== '' && !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep);
}
const roots: string[] = [];
const stores: GenerationStore[] = [];
async function directory() {
    const root = resolve('.cache/generation-tests');
    await mkdir(root, {
        recursive: true
    });
    const dir = await mkdtemp(join(root, 'store-'));
    roots.push(dir);
    return dir;
}
async function opened(dir: string) {
    const store = await GenerationStore.open(dir);
    stores.push(store);
    return store;
}
afterEach(async () => {
    for (const store of stores.splice(0))
        await store.close();
    for (const dir of roots.splice(0)) {
        if (!cleanupChild(resolve('.cache/generation-tests'), dir))
            throw Error('cleanup containment');
        await rm(dir, {
            recursive: true, force: true
        });
    }
});
describe('atomic generation store', () => {
    it('holds exclusive ownership until close', async () => {
        const dir = await directory();
        const store = await opened(dir);
        await expect(GenerationStore.open(dir)).rejects.toThrow('STORE_LOCKED');
        await store.close();
        await opened(dir);
    });
    it('rejects corrupt JSON and malformed complete snapshots without reset', async () => {
        const dir = await directory();
        await writeFile(join(dir, 'state.json'), '{broken');
        await expect(GenerationStore.open(dir)).rejects.toThrow('INVALID_STORE');
        expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe('{broken');
        await writeFile(join(dir, 'state.json'), JSON.stringify({
            version: 1
        }));
        await expect(GenerationStore.open(dir)).rejects.toThrow('INVALID_STORE');
    });
    it('rolls back failed reducers and detaches reads', async () => {
        const store = await opened(await directory());
        const before = store.read();
        const result = await store.transact(state => {
            state.sequence += 99;
            state.ledger = [];
            return {
                ok: false, error: {
                    code: 'QUOTA_INSUFFICIENT', message: '测试额度不足'
                }
            };
        });
        expect(result.ok).toBe(false);
        expect(store.read()).toEqual(before);
        before.sequence = 99;
        expect(store.read().sequence).toBe(0);
    });
    it('serializes commits and preserves complete state across restart', async () => {
        const dir = await directory();
        const store = await opened(dir);
        await Promise.all(Array.from({
            length: 8
        }, () => store.transact(state => {
            state.sequence++;
            return {
                ok: true, value: state.sequence
            };
        })));
        const before = store.read();
        expect(before.sequence).toBe(8);
        await store.close();
        expect((await opened(dir)).read()).toEqual(before);
    });
    it('does not publish an atomic rename failure and cleans owned temp', async () => {
        const dir = await directory();
        let fail = false;
        const store = await GenerationStore.open(dir, {
            rename: async (a, b) => {
                if (fail)
                    throw Error('private filesystem detail');
                await rename(a, b);
            }
        });
        stores.push(store);
        const before = store.read();
        fail = true;
        await expect(store.transact(state => {
            state.sequence++;
            return {
                ok: true, value: null
            };
        })).rejects.toThrow('STORAGE_UNAVAILABLE');
        expect(store.read()).toEqual(before);
        expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toEqual(before);
    });
    it('rejects inconsistent quota and unknown state fields on reload', async () => {
        const dir = await directory();
        const store = await opened(dir);
        const state = store.read();
        await store.close();
        state.credits.available++;
        await writeFile(join(dir, 'state.json'), JSON.stringify(state));
        await expect(GenerationStore.open(dir)).rejects.toThrow('INVALID_STORE');
        state.credits.available--;
        await writeFile(join(dir, 'state.json'), JSON.stringify({
            ...state, hidden: true
        }));
        await expect(GenerationStore.open(dir)).rejects.toThrow('INVALID_STORE');
    });
});

describe.each([
    { name: 'POSIX', paths: posix, root: '/runner/work/AIspsc/.cache/generation-tests' },
    { name: 'Windows', paths: win32, root: win32.join('D:/', 'workspace', '.cache', 'generation-tests') },
])('$name cleanup containment', ({ paths, root }) => {
    it.each([
        { name: 'direct child', segments: ['store-123'], expected: true },
        { name: 'nested child', segments: ['store-123', 'nested'], expected: true },
        { name: 'root itself', segments: [], expected: false },
        { name: 'parent escape', segments: ['..', 'outside'], expected: false },
        { name: 'normalized traversal', segments: ['store-123', '..', '..', 'outside'], expected: false },
        { name: 'sibling sharing prefix', segments: ['..', 'generation-tests-sibling'], expected: false },
    ])('accepts or rejects $name', ({ segments, expected }) => {
        expect(cleanupChild(root, paths.join(root, ...segments), paths)).toBe(expected);
    });
    it('rejects a different filesystem root', () => {
        const other = paths === win32 ? win32.join('E:/', 'outside', 'store-123') : '/outside/store-123';
        expect(cleanupChild(root, other, paths)).toBe(false);
    });
});

describe('private lifecycle schema migration', () => {
 it('atomically marks legacy snapshots while preserving the public version and history', async () => {
  const dir = await directory(); const first = await opened(dir); const before = first.read(); await first.close();
  delete before.schemaVersion;
  await writeFile(join(dir, 'state.json'), JSON.stringify(before));
  const migrated = (await opened(dir)).read();
  expect(migrated).toEqual({ ...before, schemaVersion: 2 });
  expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toEqual(migrated);
 });
 it('rejects unknown schema without rewriting the file', async () => {
  const dir = await directory(); const first = await opened(dir); const before = first.read(); await first.close();
  const serialized = JSON.stringify({ ...before, schemaVersion: 999 }); await writeFile(join(dir, 'state.json'), serialized);
  await expect(GenerationStore.open(dir)).rejects.toThrow('UNSUPPORTED_STORE_SCHEMA');
  expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(serialized);
 });
});
import manifestSource from '../../../apps/web/public/demo/MEDIA_MANIFEST.json';
import { createBatch, syncBatch } from '../../domain/src/generation-state.js';
import { applyWorkerEvent } from '../../domain/src/generation-commands.js';
import { normalizeProviderAttempt } from '../../domain/src/provider-attempt.js';
import type { DemoManifest } from '../../contracts/src/index.js';
describe('actual lifecycle persistence', () => {
 async function submitted() {
  const dir = await directory(); const store = await opened(dir);
  const now = Date.now();
  await store.transact(s => createBatch(s, { mode: 'copy', prompt: 'demo', count: 1, references: [], copy: { language: 'zh-CN', maxCharacters: 100 } }, 'test', 'a'.repeat(64), { now, manifest: manifestSource as DemoManifest }));
  const item = store.read().items[0]!;
  await store.transact(s => applyWorkerEvent(s, { kind: 'submitting', itemId: item.id, expectedVersion: 0 }, { now, manifest: manifestSource as DemoManifest }));
  return { dir, store, now };
 }
 it('preserves interrupted legacy claim and adopts it as paused unknown without releasing quota', async () => {
  const { dir, store } = await submitted(); const original = store.read(); await store.close();
  const reloaded = await opened(dir);
  expect(reloaded.read()).toEqual(original);
  await reloaded.transact(s => {
   s.attempts[0] = normalizeProviderAttempt(s.attempts[0]!, 'fake-local');
   s.items[0]!.status = 'needs_reconciliation';
   s.pending[0]!.phase = 'complete'; s.pending[0]!.dueAt = Number.MAX_SAFE_INTEGER;
   syncBatch(s, s.items[0]!); return { ok: true, value: null };
  });
  expect(reloaded.read().credits).toEqual(original.credits);
  expect(reloaded.read().attempts[0]!.submissionState).toBe('needs_reconciliation');
  await reloaded.close(); expect((await opened(dir)).read().attempts[0]!.submissionState).toBe('needs_reconciliation');
 });
 it('rejects lifecycle-item mismatch transactionally and retains its claim', async () => {
  const { store } = await submitted(); const original = store.read();
  await expect(store.transact(s => {
   s.attempts[0] = normalizeProviderAttempt(s.attempts[0]!, 'agnes-simulated');
   return { ok: true, value: null };
  })).rejects.toThrow('INVALID_STORE');
  expect(store.read()).toEqual(original);
 });
});
