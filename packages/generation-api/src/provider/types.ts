import type { CreateGenerationRequest, MediaFile, ScenarioName } from '../../../contracts/src/index.js';
import type { ProviderReportedFacts } from '../../../contracts/src/provider-media.js';

export interface ProviderCreateRequest {
  request: CreateGenerationRequest;
  itemId: string;
  itemIndex: number;
}
export interface ProviderContext extends ProviderCreateRequest {
  attemptId: string;
  externalIdempotencyKey: string;
  submittedAt: string;
  now: number;
  scenario: ScenarioName;
  lastPolledAt?: string;
  cancelRequested: boolean;
  recovery: boolean;
}
export type ProviderStatus = 'queued' | 'running' | 'result_ready' | 'failed' | 'cancelled' | 'unknown';
export interface ProviderCreateResult { externalJobId: string; status: ProviderStatus; reported?: ProviderReportedFacts }
export type ProviderResultReference =
  | { kind: 'https'; url: string; providerReportedSeconds?: number; providerReportedSize?: string }
  | { kind: 'fixture'; fixtureKey: string }
  | { kind: 'text'; text: string };
export interface ProviderPollResult { status: ProviderStatus; result?: ProviderResultReference; reported?: ProviderReportedFacts }
export type ProviderDownloadedMedia =
  | { kind: 'media'; bytes: Uint8Array; sha256: string; mime: string; provenance: 'synthetic_provider_simulation' | 'real_provider_output'; fixtureMedia?: MediaFile }
  | { kind: 'text'; text: string };
