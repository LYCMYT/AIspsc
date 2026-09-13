import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { MediaFile } from '../../contracts/src/index.js';
import type { RawProviderMedia, ProviderDerivativeEvidence } from '../../contracts/src/provider-media.js';
import { canonicalJson } from '../../contracts/src/index.js';
import { checkedMediaUrl } from '../../provider-agnes/src/download.ts';
import { MAX_MEDIA_BYTES, decodeVideo, probeVideo, probeVideoCodec, processDelivery, readMp4 } from '../../media-processing/src/processor.ts';
import type { DeliveryReport } from '../../media-processing/src/processor.ts';
import { FixtureCatalog } from './fixtures.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const rawKey = new RegExp(`^media/raw-${uuid}\\.mp4$`);
const outputKey = new RegExp(`^media/delivery-(${uuid})/result\\.mp4$`);
const identifier = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);
function unavailable(): never { throw new Error('MEDIA_UNAVAILABLE'); }
async function syncDirectory(path: string): Promise<void> {
  // Node cannot open Windows directories for fsync. Windows supports process-restart
  // recovery here; Linux acceptance additionally flushes directory entries.
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
type RepositoryReport = DeliveryReport & { providerProvenance?: 'real_provider_output' };
function metadata(report: RepositoryReport, id: string): MediaFile {
  if (Object.hasOwn(report, 'providerProvenance') && report.providerProvenance !== 'real_provider_output') unavailable();
  const real = report.providerProvenance === 'real_provider_output';
  const facts = report.result.media;
  return { id: `provider-${id}`, workspaceId: 'demo', mediaType: 'video', mime: 'video/mp4',
    byteSize: report.result.byteSize, sha256: report.result.sha256, width: facts.width, height: facts.height,
    durationMs: Math.round(facts.durationSeconds * 1000), hasAudio: facts.hasAudio,
    objectKey: `media/delivery-${id}/result.mp4`, availability: 'available', isDemo: !real,
    ...(real ? {} : { fixtureKey: 'synthetic-provider-simulation' }) };
}

/** Files stay below the already private Store root; this owns no review, quota or task state. */
export class GenerationMediaRepository {
  private constructor(private readonly root: string, private readonly fixtures: FixtureCatalog) {}
  static async open(directory: string, fixtures: FixtureCatalog): Promise<GenerationMediaRepository> {
    const root = resolve(directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (let at = root;; at = dirname(at)) {
      if ((await lstat(at)).isSymbolicLink()) unavailable();
      if (at === dirname(at)) break;
    }
    await mkdir(join(root, 'media'), { recursive: true, mode: 0o700 });
    if ((await lstat(join(root, 'media'))).isSymbolicLink()) unavailable();
    await syncDirectory(join(root, 'media'));
    await syncDirectory(root);
    await syncDirectory(dirname(root));
    return new GenerationMediaRepository(root, fixtures);
  }
  private async checkedPath(key: string): Promise<string> {
    if (!rawKey.test(key) && !outputKey.test(key) && !new RegExp(`^media/delivery-${uuid}/delivery\\.json$`).test(key)) unavailable();
    const path = resolve(this.root, key);
    const rel = relative(this.root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) unavailable();
    for (let at = path; at !== this.root; at = dirname(at)) if ((await lstat(at)).isSymbolicLink()) unavailable();
    if (resolve(await realpath(path)).toLowerCase() !== path.toLowerCase()) unavailable();
    return path;
  }
  async captureRaw(download: { bytes: Uint8Array; sha256: string; provenance?: 'synthetic_provider_simulation' | 'real_provider_output' }, reference: {
    kind: 'https'; url: string; providerReportedSeconds?: number; providerReportedSize?: string;
  }, provider: string, externalJobId: string, now: number): Promise<RawProviderMedia> {
    try {
      const host = checkedMediaUrl(reference.url).hostname;
      const real = provider === 'agnes-authorized-real';
      if (!['agnes-simulated','agnes-authorized-real','fake-local'].includes(provider) || (real ? download.provenance !== 'real_provider_output' : download.provenance !== undefined && download.provenance !== 'synthetic_provider_simulation')) unavailable();
      if (!identifier(provider) || !identifier(externalJobId) || !Number.isFinite(now) ||
        download.bytes.length < 12 || download.bytes.length > MAX_MEDIA_BYTES || digest(download.bytes) !== download.sha256 ||
        Buffer.from(download.bytes).toString('ascii', 4, 8) !== 'ftyp') unavailable();
      if (reference.providerReportedSeconds !== undefined && (!Number.isFinite(reference.providerReportedSeconds) || reference.providerReportedSeconds <= 0 || reference.providerReportedSeconds > 60)) unavailable();
      if (reference.providerReportedSize !== undefined && !/^\d{1,4}x\d{1,4}$/.test(reference.providerReportedSize)) unavailable();
      const key = `media/raw-${randomUUID()}.mp4`;
      if ((await lstat(join(this.root, 'media'))).isSymbolicLink()) unavailable();
      const file = await open(join(this.root, key), 'wx', 0o600);
      try { await file.writeFile(download.bytes); await file.sync(); } finally { await file.close(); }
      await syncDirectory(join(this.root, 'media'));
      const path = await this.checkedPath(key);
      const facts = await probeVideo(path);
      await decodeVideo(path);
      const rawCodec = real ? await probeVideoCodec(path) : undefined;
      if (digest(await readMp4(path)) !== download.sha256) unavailable();
      const date = new Date(now).toISOString();
      return { provider, externalJobId, providerResultReferenceKind: 'https', resultHost: host, retrievedAt: date,
        ...(reference.providerReportedSeconds !== undefined ? { providerReportedSeconds: reference.providerReportedSeconds } : {}),
        ...(reference.providerReportedSize !== undefined ? { providerReportedSize: reference.providerReportedSize } : {}),
        rawSha256: download.sha256, rawActualWidth: facts.width, rawActualHeight: facts.height, rawDuration: facts.durationSeconds,
        rawHasAudio: facts.hasAudio, rawFps: facts.fps, rawFrames: facts.frames, rawDecodeVerified: true,
        rawObjectKey: key, rawByteSize: download.bytes.length, downloadedAt: date, provenance: real ? 'real_provider_output' : 'synthetic_provider_simulation', ...(rawCodec ? { rawCodec } : {}) };
    } catch { return unavailable(); }
  }
  async verifyRaw(raw: RawProviderMedia): Promise<void> {
    try {
      const path = await this.checkedPath(raw.rawObjectKey);
      const bytes = await readMp4(path);
      if (bytes.length !== raw.rawByteSize || digest(bytes) !== raw.rawSha256) unavailable();
      const real = raw.provider === 'agnes-authorized-real';
      if (raw.provenance !== (real ? 'real_provider_output' : 'synthetic_provider_simulation')) unavailable();
      if (real) {
        const facts = await probeVideo(path);
        if (raw.rawCodec !== await probeVideoCodec(path) || raw.rawActualWidth !== facts.width || raw.rawActualHeight !== facts.height || raw.rawDuration !== facts.durationSeconds || raw.rawFps !== facts.fps || raw.rawFrames !== facts.frames || raw.rawHasAudio !== facts.hasAudio || raw.rawDecodeVerified !== true) unavailable();
        await decodeVideo(path);
      }
    } catch { unavailable(); }
  }
  async finalize(raw: RawProviderMedia, target: unknown): Promise<ProviderDerivativeEvidence> {
    if (raw.provenance !== (raw.provider === 'agnes-authorized-real' ? 'real_provider_output' : 'synthetic_provider_simulation')) unavailable();
    await this.verifyRaw(raw);
    const source = await this.checkedPath(raw.rawObjectKey);
    const id = randomUUID();
    try {
      if ((await lstat(join(this.root, 'media'))).isSymbolicLink()) unavailable();
      const report: RepositoryReport = await processDelivery(source, join(this.root, `media/delivery-${id}`), target);
      if (raw.provenance === 'real_provider_output') {
        report.providerProvenance = 'real_provider_output';
        const manifest = await open(await this.checkedPath(`media/delivery-${id}/delivery.json`), 'r+');
        try { await manifest.truncate(0); await manifest.writeFile(JSON.stringify(report, null, 2) + '\n'); await manifest.sync(); } finally { await manifest.close(); }
      }
      if (report.source.sha256 !== raw.rawSha256) unavailable();
      for (const name of ['result.mp4', 'delivery.json']) {
        const file = await open(await this.checkedPath(`media/delivery-${id}/${name}`), 'r+');
        try { await file.sync(); } finally { await file.close(); }
      }
      const media = metadata(report, id);
      await syncDirectory(join(this.root, `media/delivery-${id}`));
      await syncDirectory(join(this.root, 'media'));
      const reportBytes = await readFile(await this.checkedPath(`media/delivery-${id}/delivery.json`));
      const evidence: ProviderDerivativeEvidence = { policy: 'delivery-v1', sourceSha256: raw.rawSha256,
        reportSha256: digest(reportBytes), media, completedAt: report.completedAt };
      await this.readMedia(media, evidence);
      return evidence;
    } catch { throw new Error('MEDIA_FINALIZATION_FAILED'); }
  }
  async readMedia(media: MediaFile, evidence?: ProviderDerivativeEvidence): Promise<{ media: MediaFile; bytes: Buffer }> {
    if (!media.id.startsWith('provider-')) return this.fixtures.readMedia(media);
    try {
      const match = outputKey.exec(media.objectKey ?? '');
      if (!match || media.id !== `provider-${match[1]}` || !evidence || canonicalJson(evidence.media) !== canonicalJson(media)) unavailable();
      const path = await this.checkedPath(media.objectKey!);
      const reportPath = await this.checkedPath(`media/delivery-${match[1]}/delivery.json`);
      if ((await lstat(reportPath)).size > 64 * 1024) unavailable();
      const reportBytes = await readFile(reportPath);
      if (reportBytes.length > 64 * 1024 || digest(reportBytes) !== evidence.reportSha256) unavailable();
      const report = JSON.parse(reportBytes.toString('utf8')) as RepositoryReport;
      if (report.version !== 'delivery-v1' || report.validation !== 'passed' || evidence.policy !== 'delivery-v1' ||
        report.source.sha256 !== evidence.sourceSha256 || report.completedAt !== evidence.completedAt ||
        canonicalJson(metadata(report, match[1]!)) !== canonicalJson(media)) unavailable();
      const bytes = await readMp4(path);
      if (bytes.length !== media.byteSize || digest(bytes) !== media.sha256) unavailable();
      return { media: structuredClone(media), bytes };
    } catch { return unavailable(); }
  }
}
