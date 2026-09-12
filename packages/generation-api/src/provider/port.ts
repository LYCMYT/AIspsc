import type { ProviderContext, ProviderCreateRequest, ProviderCreateResult, ProviderDownloadedMedia, ProviderPollResult, ProviderResultReference } from './types.js';
export type * from './types.js';

export interface GenerationProvider {
  readonly bindingId: string;
  create(request: ProviderCreateRequest, context: ProviderContext): Promise<ProviderCreateResult>;
  get(externalJobId: string, context: ProviderContext): Promise<ProviderPollResult>;
  download(result: ProviderResultReference, context: ProviderContext): Promise<ProviderDownloadedMedia>;
}

const codes = ['PROVIDER_INVALID_REQUEST', 'PROVIDER_UNAUTHORIZED', 'PROVIDER_NOT_FOUND', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_OUTCOME_UNKNOWN', 'PROVIDER_DOWNLOAD_FAILED', 'PROVIDER_STORAGE_FAILED', 'REAL_PROVIDER_CREATE_DISABLED'] as const;
const categories = ['invalid_request', 'unauthorized', 'not_found', 'rate_limited', 'transient', 'unknown'] as const;
const certainties = ['not_submitted', 'rejected', 'unknown'] as const;
export type ProviderErrorCode = typeof codes[number];
export type ProviderErrorCategory = typeof categories[number];
export type ProviderSubmissionCertainty = typeof certainties[number];

/** Only fixed diagnostics cross the adapter boundary; no raw message/cause is accepted. */
export class ProviderOperationError extends Error {
  readonly code: ProviderErrorCode;
  readonly category: ProviderErrorCategory;
  readonly submissionCertainty: ProviderSubmissionCertainty;

  constructor(code: ProviderErrorCode, category: ProviderErrorCategory, submissionCertainty: ProviderSubmissionCertainty) {
    const safeCode = codes.includes(code) ? code : 'PROVIDER_OUTCOME_UNKNOWN';
    super(safeCode);
    this.name = 'ProviderOperationError';
    this.code = safeCode;
    this.category = categories.includes(category) ? category : 'unknown';
    this.submissionCertainty = certainties.includes(submissionCertainty) ? submissionCertainty : 'unknown';
  }
}
