import type { Asset, CreditLedgerEntry, CreditSnapshot, Evaluation, GenerationBatchSnapshot, GenerationItem, MediaFile, ProviderAttempt, Result, ReviewInput, ServiceFacade, SplitJob, TimeInterval } from './generation';

export type ScenarioName = 'seed' | 'empty' | 'processing' | 'success' | 'failure' | 'partial_success' | 'missing_file' | 'quota_insufficient' | 'storage_failure' | 'request_failure' | 'unknown' | 'download_failure' | 'cancel_race';
export interface DemoSnapshot {
  version: 1;
  epoch: string;
  scenario: ScenarioName;
  batches: GenerationBatchSnapshot[];
  items: GenerationItem[];
  evaluations: Evaluation[];
  assets: Asset[];
  mediaMetadata: MediaFile[];
  credits: CreditSnapshot;
  ledger: CreditLedgerEntry[];
  attempts: ProviderAttempt[];
  reconciliations: Array<{ itemId: string; outcome: 'success' | 'failure' | 'cancelled'; evidence: string; createdAt: string }>;
  splits: DemoSplitJob[];
}
export interface DemoSplitJob extends SplitJob {
  sceneRanges?: TimeInterval[];
  expandedIntervals?: TimeInterval[];
  sourceSha256: string;
}
export interface DemoFixture {
  key: string;
  path: string;
  sha256: string;
  source: string;
  mime: string;
  durationMs?: number;
  width: number;
  height: number;
  hasAudio: boolean;
  fixtureKey: string;
  sceneCutMs?: number[];
  sourceSha256?: string;
  startMs?: number;
  endMs?: number;
}
export interface DemoManifest { version: 1; files: DemoFixture[] }
export interface DemoPlatform extends ServiceFacade {
  ready(): Promise<void>;
  snapshot(): Promise<DemoSnapshot>;
  pump(): Promise<void>;
  setScenario(name: ScenarioName): Promise<Result<void>>;
  resetScenario(name: ScenarioName, confirmed: boolean): Promise<Result<void>>;
  upload(blob: Blob, filename: string): Promise<Result<Asset>>;
  loadFixture(key: string): Promise<Result<Asset>>;
  restore(assetId: string, blob: Blob): Promise<Result<Asset>>;
  updateAsset(assetId: string, input: { title: string; tags: string[] }): Promise<Result<Asset>>;
  deleteAsset(assetId: string): Promise<Result<void>>;
  resolveUnknown(itemId: string, outcome: 'success' | 'failure' | 'cancelled'): Promise<Result<GenerationItem>>;
  retryDownload(itemId: string): Promise<Result<GenerationItem>>;
  saveReviewRevision(itemId: string, form: ReviewInput, reason: string): Promise<Result<Evaluation>>;
  saveClipAsset(splitId: string, index: number): Promise<Result<Asset>>;
}
