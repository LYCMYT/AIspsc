import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { DomainFailure, MediaFile, MediaPutInput, MediaStore, Result } from '../../contracts/src/index';

interface StorageSchema extends DBSchema {
  state: { key: string; value: { version: number; data: unknown } };
  media: { key: string; value: { media: MediaFile; blob: Blob } };
}
export type StorageTransaction = IDBPTransaction<StorageSchema, ['state', 'media'], 'readwrite'>;
const VERSION = 1;

export function storageError(error: unknown): DomainFailure {
  const name = error instanceof Error ? error.name : '';
  return {
    code: name === 'QuotaExceededError' ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_UNAVAILABLE',
    message: name === 'QuotaExceededError' ? '本地存储容量不足，请删除不用的素材后重试' : '本地存储不可用，请检查浏览器存储权限后重试',
  };
}

/** IndexedDB readwrite transactions coordinate tabs. Never do network I/O in a transaction. */
export class BrowserRepository<T = unknown> {
  private connection?: Promise<IDBPDatabase<StorageSchema>>;
  constructor(public readonly name = 'ai-marketing-video-demo-v1') {}

  database(): Promise<IDBPDatabase<StorageSchema>> {
    this.connection ??= openDB<StorageSchema>(this.name, 1, {
      upgrade(db) { db.createObjectStore('state'); db.createObjectStore('media'); },
      blocking: () => { void this.connection?.then((db) => db.close()); this.connection = undefined; },
    }).catch((error: unknown) => { this.connection = undefined; throw error; });
    return this.connection;
  }

  private decode(envelope: StorageSchema['state']['value'] | undefined): T | undefined {
    if (!envelope) return undefined;
    if (envelope.version !== VERSION) throw Object.assign(new Error('存储版本不兼容，请先导出资料后重置演示'), { code: 'STORAGE_VERSION_UNSUPPORTED' });
    return envelope.data as T;
  }

  async read(): Promise<T | undefined> {
    return this.decode(await (await this.database()).get('state', 'snapshot'));
  }

  async replace(value: T): Promise<void> {
    await (await this.database()).put('state', { version: VERSION, data: value }, 'snapshot');
  }

  async initialize(value: T): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(['state', 'media'], 'readwrite');
    const existing = await tx.objectStore('state').get('snapshot');
    if (!existing) await tx.objectStore('state').put({ version: VERSION, data: value }, 'snapshot');
    await tx.done;
  }

  async update<R>(work: (state: T, tx: StorageTransaction) => R | Promise<R>): Promise<R> {
    const db = await this.database();
    const tx = db.transaction(['state', 'media'], 'readwrite');
    try {
      const state = this.decode(await tx.objectStore('state').get('snapshot'));
      if (state === undefined) throw new Error('应用状态尚未初始化');
      const result = await work(state, tx);
      await tx.objectStore('state').put({ version: VERSION, data: state }, 'snapshot');
      await tx.done;
      return structuredClone(result);
    } catch (error) {
      try { tx.abort(); } catch { /* Already aborted; preserve original failure. */ }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async reset(value: T): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(['state', 'media'], 'readwrite');
    await tx.objectStore('media').clear();
    await tx.objectStore('state').put({ version: VERSION, data: value }, 'snapshot');
    await tx.done;
  }
}

export class IndexedMediaStore implements MediaStore {
  constructor(private readonly repository: Pick<BrowserRepository, 'database'>) {}

  async put(input: MediaPutInput): Promise<Result<MediaFile>> {
    try {
      const id = crypto.randomUUID();
      const media: MediaFile = { ...input.metadata, id, blobKey: id };
      await (await this.repository.database()).put('media', { media, blob: input.blob }, id);
      return { ok: true, value: media };
    } catch (error) { return { ok: false, error: storageError(error) }; }
  }

  async get(mediaId: string): Promise<Result<{ media: MediaFile; blob: Blob }>> {
    try {
      const entry = await (await this.repository.database()).get('media', mediaId);
      if (!entry) return { ok: false, error: { code: 'MEDIA_UNAVAILABLE', message: '文件需重新选择' } };
      return { ok: true, value: entry };
    } catch (error) { return { ok: false, error: storageError(error) }; }
  }

  async remove(mediaId: string): Promise<Result<void>> {
    try {
      await (await this.repository.database()).delete('media', mediaId);
      return { ok: true, value: undefined };
    } catch (error) { return { ok: false, error: storageError(error) }; }
  }
}
