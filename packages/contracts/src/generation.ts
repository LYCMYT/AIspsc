import type { RawProviderMedia, ProviderDerivativeEvidence, ProviderReportedFacts } from './provider-media.js';
import generationRequestSchemaSource from '../../../contracts/generation-request.schema.json';

export type GenerationMode = 'video' | 'image' | 'copy';
export type ReferenceRole = 'product' | 'person' | 'background' | 'reference_video';
export type AspectRatio = '9:16' | '16:9' | '1:1';
export type VideoResolution = '720p' | '1080p';

export interface GenerationReference {
  assetId: string;
  role: ReferenceRole;
}

interface GenerationRequestBase {
  prompt: string;
  references: GenerationReference[];
  count: number;
}

export interface VideoGenerationRequest extends GenerationRequestBase {
  mode: 'video';
  video: {
    durationSeconds: number;
    ratio: AspectRatio;
    resolution: VideoResolution;
    audio: boolean;
  };
  image?: never;
  copy?: never;
}

export interface ImageGenerationRequest extends GenerationRequestBase {
  mode: 'image';
  image: {
    ratio: AspectRatio;
    resolution: string;
  };
  video?: never;
  copy?: never;
}

export interface CopyGenerationRequest extends GenerationRequestBase {
  mode: 'copy';
  copy: {
    language: 'zh-CN';
    maxCharacters: number;
  };
  video?: never;
  image?: never;
}

export type CreateGenerationRequest =
  | VideoGenerationRequest
  | ImageGenerationRequest
  | CopyGenerationRequest;

export type DomainErrorCode =
  | 'PROMPT_REQUIRED'
  | 'INVALID_PARAMETERS'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_FORBIDDEN'
  | 'ASSET_UNAVAILABLE'
  | 'REFERENCE_ROLE_DUPLICATE'
  | 'REFERENCE_TYPE_MISMATCH'
  | 'MEDIA_UNAVAILABLE'
  | 'MEDIA_TOO_SHORT'
  | 'MEDIA_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA'
  | 'NO_COMPATIBLE_MODEL'
  | 'INVALID_SCENE_CUTS'
  | 'SCENE_FIXTURE_REQUIRED'
  | 'INVALID_INTERVAL'
  | 'QUOTA_INSUFFICIENT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_LEDGER_TRANSITION'
  | 'REVIEW_REQUIRED'
  | 'REVIEW_REJECTED'
  | 'ITEM_NOT_READY'
  | 'TASK_NOT_READY'
  | 'FORBIDDEN'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'VERSION_CONFLICT'
  | 'FILE_FIXTURE_MISSING'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'CANCELLED';

export interface DomainFailure {
  code: DomainErrorCode;
  message: string;
  field?: string;
}

export type Result<T, E = DomainFailure> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly field?: string;

  constructor(code: DomainErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.field = field;
  }
}

export const generationRequestSchema = generationRequestSchemaSource;

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface User {
  id: string;
  displayName: string;
  createdAt: string;
}

export type MembershipRole = 'member' | 'admin';

export interface Membership {
  workspaceId: string;
  userId: string;
  role: MembershipRole;
  createdAt: string;
}

export type MediaType = 'image' | 'video' | 'audio';
export type MediaAvailability =
  | 'processing'
  | 'available'
  | 'missing'
  | 'quarantined'
  | 'unavailable';

export interface MediaFile {
  id: string;
  workspaceId: string;
  mediaType: MediaType;
  mime: string;
  byteSize: number;
  width?: number;
  height?: number;
  durationMs?: number;
  objectKey?: string;
  blobKey?: string;
  sha256: string;
  availability: MediaAvailability;
  hasAudio?: boolean;
  isDemo?: boolean;
  fixtureKey?: string;
}

export type AssetSource = 'upload' | 'generated' | 'fixture';
export type AssetReviewValidity = 'valid' | 'review_invalidated';

export interface Asset {
  id: string;
  workspaceId: string;
  mediaFileId?: string;
  text?: string;
  mediaType: MediaType | 'text';
  availability: MediaAvailability;
  source: AssetSource;
  originItemId?: string;
  reviewId?: string;
  reviewValidity?: AssetReviewValidity;
  title: string;
  tags: string[];
  archivedAt?: string;
  createdAt: string;
  isDemo: boolean;
}

export interface ReferenceAsset {
  id: string;
  workspaceId: string;
  mediaType: MediaType | 'text';
  availability: MediaAvailability;
}

export type TaskType =
  | 'COPY_GENERATION'
  | 'IMAGE_GENERATION'
  | 'MULTI_REFERENCE_VIDEO'
  | 'REFERENCE_VIDEO_GEN'
  | 'IMAGE_GUIDED_VIDEO'
  | 'TEXT_TO_VIDEO';

export type GenerationItemStatus =
  | 'queued'
  | 'running'
  | 'finalizing'
  | 'cancel_requested'
  | 'needs_reconciliation'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type GenerationBatchStatus =
  | 'queued'
  | 'running'
  | 'needs_reconciliation'
  | 'succeeded'
  | 'partial_succeeded'
  | 'failed'
  | 'cancelled';

export type ReviewState = 'pending' | 'approved' | 'rejected';
export type LibraryState = 'not_saved' | 'saved';

export interface RoutingCapabilitySnapshot {
  taskTypes: TaskType[];
  maxReferences: number;
  referenceRoleLimits?: Partial<Record<ReferenceRole, number>>;
  video?: {
    durationSeconds: number[];
    ratios: AspectRatio[];
    resolutions: VideoResolution[];
    audio: boolean[];
    combinations?: Array<{
      durationSeconds: number;
      ratio: AspectRatio;
      resolution: VideoResolution;
      audio: boolean;
      maxReferences?: number;
    }>;
  };
  image?: { ratios: AspectRatio[]; resolutions: string[] };
  copy?: { languages: Array<'zh-CN'>; maxCharacters: number };
}

export interface RoutingDecision {
  modelKey: string;
  bindingId: string;
  ruleVersion: string;
  reason: string;
  capabilitySnapshot: RoutingCapabilitySnapshot;
}

export type RoutingEnvironment = 'mock' | 'real';
export type BindingVerificationStatus = 'verified' | 'unverified';

export interface RoutingBinding {
  modelKey: string;
  bindingId: string;
  priority: number;
  enabled: boolean;
  verificationStatus: BindingVerificationStatus;
  environments: RoutingEnvironment[];
  capabilities: RoutingCapabilitySnapshot;
}

export interface PricingSnapshot {
  version: string;
  unitCost: number;
  unitName: 'demo-credit';
}

export interface GenerationBatch {
  id: string;
  workspaceId: string;
  requestSnapshot: CreateGenerationRequest;
  requestedCount: number;
  idempotencyKey: string;
  requestHash: string;
  createdAt: string;
}

export interface GenerationItem {
  id: string;
  batchId: string;
  index: number;
  version: number;
  status: GenerationItemStatus;
  mode: GenerationMode;
  resultMediaId?: string;
  text?: string;
  resultAvailable: boolean;
  errorCode?: DomainErrorCode;
  retryOfItemId?: string;
  routingSnapshot: RoutingDecision;
  pricingSnapshot: PricingSnapshot;
  reviewState: ReviewState;
  libraryState: LibraryState;
  updatedAt: string;
}

export interface GenerationBatchSnapshot extends GenerationBatch {
  status: GenerationBatchStatus;
  items: GenerationItem[];
}

export type ProviderSubmissionState =
  | 'not_submitted'
  | 'submitting'
  | 'submitted'
  | 'outcome_unknown'
  | 'polling'
  | 'result_ready'
  | 'downloading'
  | 'needs_reconciliation'
  | 'failed'
  | 'settled';

export type ProviderStatus = 'queued' | 'running' | 'result_ready' | 'failed' | 'cancelled' | 'unknown';
export type ProviderErrorCategory = 'invalid_request' | 'unauthorized' | 'not_found' | 'rate_limited' | 'transient' | 'unknown';

export interface ProviderAttempt {
  lifecycleVersion?: 1;
  attemptId?: string;
  providerStatus?: ProviderStatus;
  submittedAt?: string;
  lastPolledAt?: string;
  nextPollAt?: string;
  errorCategory?: ProviderErrorCategory;
  actualCost?: null;
  reported?: ProviderReportedFacts;
  rawMedia?: RawProviderMedia;
  derivativeEvidence?: ProviderDerivativeEvidence;
  itemId: string;
  attemptNo: number;
  providerBindingId: string;
  externalJobId?: string;
  externalIdempotencyKey: string;
  submissionState: ProviderSubmissionState;
  createdAt: string;
  updatedAt: string;
}

export type EvaluationDimensionId =
  | 'Q01'
  | 'Q02'
  | 'Q03'
  | 'Q04'
  | 'Q05'
  | 'Q06'
  | 'Q07'
  | 'Q08'
  | 'Q09'
  | 'Q10'
  | 'Q11';
export type HardFailureCode = 'H01' | 'H02' | 'H03';
export type TechnicalErrorCode =
  | 'TECH_CORRUPT'
  | 'TECH_DURATION'
  | 'TECH_RESOLUTION'
  | 'TECH_AUDIO';

export interface EvaluationApplicability {
  applicable: boolean;
  reason?: string;
}

export interface VideoReviewInput {
  rubricVersion: 'rubric-v2-rebuild';
  score: number;
  applicability: Record<EvaluationDimensionId, EvaluationApplicability>;
  issueTags: EvaluationDimensionId[];
  hardFailures: HardFailureCode[];
  technicalErrors: TechnicalErrorCode[];
  notes?: string;
}

export interface BasicMediaReviewInput {
  rubricVersion: 'basic-media-review-v1';
  humanDecision: 'approved' | 'rejected';
  readable: boolean;
  followsTask: boolean;
  reason?: string;
}

export type ReviewInput = VideoReviewInput | BasicMediaReviewInput;

export interface Evaluation {
  id: string;
  itemId: string;
  revision: number;
  rubricVersion: ReviewInput['rubricVersion'];
  score?: number;
  applicability?: Record<EvaluationDimensionId, EvaluationApplicability>;
  issueTags: string[];
  hardFailures: HardFailureCode[];
  technicalErrors: TechnicalErrorCode[];
  decision: Exclude<ReviewState, 'pending'>;
  reason: string;
  reviewerId: string;
  createdAt: string;
}

export interface TimeInterval {
  startMs: number;
  endMs: number;
}

export type SplitMode = 'sequential' | 'average' | 'scene' | 'manual';
export interface Clip extends TimeInterval {
  actualDurationMs?: number;
  mediaFileId?: string;
}

export interface SplitJob {
  id: string;
  sourceMediaId: string;
  mode: SplitMode;
  sourceDurationMs: number;
  ruleVersion: 'split-v2-rebuild';
  intervals: Clip[];
  status: GenerationItemStatus;
}

export type LedgerAction = 'GRANT' | 'RESERVE' | 'COMMIT' | 'RELEASE';
export type CreditReservationFinalState = 'reserved' | 'committed' | 'released';

export interface CreditReservation {
  itemId: string;
  reservedUnits: number;
  finalState: CreditReservationFinalState;
}

export interface CreditLedgerEntry {
  referenceId: string;
  action: LedgerAction;
  units: number;
  createdAt: string;
  reason?: string;
}

export interface CreditSnapshot {
  granted: number;
  available: number;
  reserved: number;
  spent: number;
  reservations: Record<string, CreditReservation>;
  appliedActions: string[];
}

export interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateId: string;
  requestId: string;
  occurredAt: string;
  payload: unknown;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string;
  occurredAt: string;
}

export interface MediaPutInput {
  blob: Blob;
  metadata: Omit<MediaFile, 'id' | 'blobKey' | 'objectKey'>;
}

export interface GenerationService {
  create(
    input: unknown,
    options: { idempotencyKey: string },
  ): Promise<Result<GenerationBatchSnapshot>>;
  get(batchId: string): Promise<Result<GenerationBatchSnapshot>>;
  cancel(itemId: string, expectedVersion?: number): Promise<Result<GenerationItem>>;
  retry(
    itemId: string,
    options: { idempotencyKey: string },
  ): Promise<Result<GenerationBatchSnapshot>>;
}

export interface ReviewService {
  save(
    itemId: string,
    rubricVersion: ReviewInput['rubricVersion'],
    form: ReviewInput,
  ): Promise<Result<Evaluation>>;
}

export interface AssetService {
  saveApprovedOutput(itemId: string, evaluationId: string): Promise<Result<Asset>>;
}

export interface MediaStore {
  put(input: MediaPutInput): Promise<Result<MediaFile>>;
  get(mediaId: string): Promise<Result<{ media: MediaFile; blob: Blob }>>;
  remove(mediaId: string): Promise<Result<void>>;
}

export interface SplitService {
  create(input: {
    sourceMediaId: string;
    mode: SplitMode;
    manualIntervals?: TimeInterval[];
  }): Promise<Result<SplitJob>>;
  get(splitId: string): Promise<Result<SplitJob>>;
}

export interface QuotaService {
  get(): Promise<Result<CreditSnapshot>>;
}

export interface DemoScenario {
  id: string;
  outcome:
    | 'success'
    | 'partial_failure'
    | 'failure'
    | 'cancel_race'
    | 'unknown'
    | 'download_failure'
    | 'storage_failure'
    | 'no_capacity';
  dueAt: string;
  fixtureId: string;
}

export interface ServiceFacade {
  generation: GenerationService;
  review: ReviewService;
  asset: AssetService;
  media: MediaStore;
  split: SplitService;
  quota: QuotaService;
}
