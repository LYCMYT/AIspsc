import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GenerationStore } from './store.js';
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
        if (!dir.startsWith(resolve('.cache/generation-tests') + '\\'))
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
