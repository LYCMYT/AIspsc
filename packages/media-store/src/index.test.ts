import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { wrap } from 'idb';
import { BrowserRepository, IndexedMediaStore } from './index';

describe('B1 durable storage boundary', () => {
  it('reconnects after a transient asynchronous IndexedDB open failure', async () => {
    const repository = new BrowserRepository(crypto.randomUUID());
    const originalOpen = indexedDB.open.bind(indexedDB);
    const spy = vi.spyOn(indexedDB, 'open').mockImplementationOnce((name, version) => {
      const request = originalOpen(name, version);
      queueMicrotask(() => request.addEventListener('upgradeneeded', () => {
        void wrap(request.transaction!).done.catch(() => undefined);
        request.transaction!.abort();
      }));
      return request;
    });
    try {
      await expect(repository.database()).rejects.toThrow();
      await expect(repository.database()).resolves.toBeDefined();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it('restores Blob bytes after a new service instance and reports removed files', async () => {
    const repository = new BrowserRepository<{ count: number }>('media-restore');
    const media = new IndexedMediaStore(repository);
    const created = await media.put({ blob: new Blob(['demo'], { type: 'image/png' }), metadata: { workspaceId: 'demo', mediaType: 'image', mime: 'image/png', byteSize: 4, sha256: 'test', availability: 'available' } });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    const reopened = new IndexedMediaStore(new BrowserRepository('media-restore'));
    const restored = await reopened.get(created.value.id);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(await restored.value.blob.text()).toBe('demo');
    await reopened.remove(created.value.id);
    expect(await media.get(created.value.id)).toMatchObject({ ok: false, error: { code: 'MEDIA_UNAVAILABLE' } });
  });

  it('serializes concurrent state updates across two connections and aborts failed transactions', async () => {
    const one = new BrowserRepository<{ count: number }>('concurrent');
    const two = new BrowserRepository<{ count: number }>('concurrent');
    await one.replace({ count: 0 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? one : two).update((state) => { state.count += 1; })));
    expect(await one.read()).toEqual({ count: 12 });
    await expect(one.update((state) => { state.count = 999; throw new Error('abort'); })).rejects.toThrow('abort');
    expect(await two.read()).toEqual({ count: 12 });
  });

  it('rejects unknown storage versions without erasing data', async () => {
    const repository = new BrowserRepository<{ count: number }>('versions');
    await repository.replace({ count: 7 });
    const db = await repository.database();
    await db.put('state', { version: 99, data: { count: 7 } }, 'snapshot');
    await expect(repository.read()).rejects.toMatchObject({ code: 'STORAGE_VERSION_UNSUPPORTED' });
    expect(await db.get('state', 'snapshot')).toEqual({ version: 99, data: { count: 7 } });
  });

  it('resets only its own database namespace', async () => {
    const one = new BrowserRepository<{ count: number }>('reset-own');
    const other = new BrowserRepository<{ count: number }>('keep-other');
    await one.replace({ count: 1 });
    await other.replace({ count: 22 });
    await one.reset({ count: 0 });
    expect(await one.read()).toEqual({ count: 0 });
    expect(await other.read()).toEqual({ count: 22 });
  });
});
