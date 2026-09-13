import type { MediaFile } from './generation.js';

export interface ProviderReportedFacts {
  videoId?: string;
  taskId?: string;
  id?: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'unknown';
  createdAt?: number;
  seconds?: number;
  size?: string;
  sizeMapping?: {
    adjusted?: boolean;
    width?: number;
    height?: number;
    requestedWidth?: number;
    requestedHeight?: number;
    ratio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
    resolution?: '480p' | '720p' | '1080p';
  };
}

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
  rawCodec?: 'h264' | 'hevc' | 'av1' | 'vp9' | 'mpeg4';
  provenance: 'synthetic_provider_simulation' | 'real_provider_output';
}
export interface ProviderDerivativeEvidence {
  policy: 'delivery-v1';
  sourceSha256: string;
  reportSha256: string;
  media: MediaFile;
  completedAt: string;
}
