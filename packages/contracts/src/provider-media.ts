import type { MediaFile } from './generation.js';

/** Private durable evidence. A temporary Provider URL is deliberately not a field. */
export interface RawProviderMedia {
  provider: string;
  externalJobId: string;
  providerReportedSeconds?: number;
  providerReportedSize?: string;
  providerResultReferenceKind: 'https';
  resultHost: string;
  retrievedAt: string;
  rawSha256: string;
  rawActualWidth: number;
  rawActualHeight: number;
  rawDuration: number;
  rawHasAudio: boolean;
  rawFps: number;
  rawFrames: number;
  rawDecodeVerified: true;
  rawObjectKey: string;
  rawByteSize: number;
  downloadedAt: string;
  provenance: 'synthetic_provider_simulation';
}
export interface ProviderDerivativeEvidence {
  policy: 'delivery-v1';
  sourceSha256: string;
  reportSha256: string;
  media: MediaFile;
  completedAt: string;
}
