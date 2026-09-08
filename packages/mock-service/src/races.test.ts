import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { BrowserRepository, type StorageTransaction } from '../../media-store/src/index';
import { MockPlatform } from './index';
import { sha256 } from './helpers';
import type { Result } from '../../contracts/src/index';
function value<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.code); return r.value; }
const request = { mode: 'video', prompt: '演示', references: [], count: 1, video: { durationSeconds: 10, ratio: '9:16', resolution: '720p', audio: false } };
async function setup(fetcher: typeof fetch, repository: BrowserRepository<unknown> = new BrowserRepository(crypto.randomUUID())) {
  let now = 1000; const blob = new Blob(['video fixture']);
  const platform = new MockPlatform({ repository, fetcher, clock: () => now, manifest: { version: 1, files: [{ key: 'video-10-9x16-720p-silent', fixtureKey: 'video-10-9x16-720p-silent', path: 'video.mp4', sha256: await sha256(blob), source: 'test', mime: 'video/mp4', width: 720, height: 1280, durationMs: 10000, hasAudio: false }] } });
  await platform.ready(); const batch = value(await platform.generation.create(request, { idempotencyKey: 'a' })); now += 10000;
  return { platform, blob, itemId: batch.items[0]!.id };
}
it('T07 epoch prevents an in-flight fetch from resurrecting a reset task', async () => {
  let unblock!: (response: Response) => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const { platform, blob } = await setup(async () => { entered(); return new Promise<Response>(resolve => { unblock = resolve; }); });
  const pumping = platform.pump(); await waiting;
  await platform.resetScenario('empty', true); unblock(new Response(blob)); await pumping;
  const state = await platform.snapshot();
  expect(state.items).toHaveLength(0); expect(state.mediaMetadata).toHaveLength(0); expect(state.credits.spent).toBe(0);
});
it('T07 a media storage exception rolls back output commit while retaining reservation for recovery', async () => {
  // A browser quota failure is injected at the persistence boundary; all state transactions remain real IndexedDB.
  class LimitedRepository extends BrowserRepository<unknown> {
    limited = true;
    override update<R>(work: (state: unknown, tx: StorageTransaction) => R | Promise<R>): Promise<R> {
      return super.update((state, tx) => work(state, new Proxy(tx, {
        get: (target, key) => key === 'objectStore' ? (name: 'state' | 'media') => {
          const store = target.objectStore(name);
          return new Proxy(store, { get: (storage, field) => {
            if (field === 'put' && name === 'media' && this.limited) return () => { throw new DOMException('storage full', 'QuotaExceededError'); };
            const member: unknown = Reflect.get(storage, field);
            return typeof member === 'function' ? member.bind(storage) : member;
          } });
        } : Reflect.get(target, key),
      })));
    }
  }
  const repository = new LimitedRepository(crypto.randomUUID());
  const { platform, itemId } = await setup(async () => new Response(new Blob(['video fixture'])), repository);
  expect(await platform.loadFixture('video-10-9x16-720p-silent')).toMatchObject({ ok: false, error: { code: 'STORAGE_QUOTA_EXCEEDED' } });
  await expect(platform.pump()).resolves.toBeUndefined();
  expect((await platform.snapshot()).items[0]).toMatchObject({ status: 'finalizing', errorCode: 'STORAGE_QUOTA_EXCEEDED' });
  expect((await platform.snapshot()).credits).toMatchObject({ reserved: 1, spent: 0 });
  expect((await platform.snapshot()).mediaMetadata).toHaveLength(0);
  repository.limited = false; value(await platform.retryDownload(itemId)); await platform.pump();
  expect((await platform.snapshot()).credits.spent).toBe(1);
});
it('T07 actual fetch failure retains the existing output intent and reservation until explicit download retry', async () => {
  let calls = 0;
  const prepared = await setup(async () => { calls++; if (calls === 1) throw new TypeError('network failed'); return new Response(blob); });
  const blob = prepared.blob;
  await prepared.platform.pump();
  expect((await prepared.platform.snapshot()).items[0]?.status).toBe('finalizing');
  expect((await prepared.platform.snapshot()).credits.reserved).toBe(1);
  await prepared.platform.pump(); expect(calls).toBe(1);
  value(await prepared.platform.retryDownload(prepared.itemId)); await prepared.platform.pump();
  expect(calls).toBe(2); expect((await prepared.platform.snapshot()).attempts).toHaveLength(1);
  expect((await prepared.platform.snapshot()).credits.spent).toBe(1);
});
it('T07 a response body stream failure remains a retryable download of the same output', async () => {
  let calls = 0;
  const { platform, itemId } = await setup(async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('stream disconnected')); } }));
    return new Response(new Blob(['video fixture']));
  });
  await platform.pump();
  expect((await platform.snapshot()).items[0]).toMatchObject({ status: 'finalizing', errorCode: 'NETWORK_ERROR' });
  expect((await platform.snapshot()).credits).toMatchObject({ reserved: 1, spent: 0 });
  value(await platform.retryDownload(itemId)); await platform.pump();
  expect(calls).toBe(2); expect((await platform.snapshot()).attempts).toHaveLength(1);
  expect((await platform.snapshot()).credits.spent).toBe(1);
});
