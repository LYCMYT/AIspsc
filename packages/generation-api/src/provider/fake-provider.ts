import { outputFixtureKey } from '../../../domain/src/generation-state.js';
import { FixtureCatalog } from '../fixtures.js';
import { ProviderOperationError, type GenerationProvider, type ProviderContext, type ProviderCreateRequest, type ProviderCreateResult, type ProviderDownloadedMedia, type ProviderPollResult, type ProviderResultReference } from './port.js';

/** Stateless simulation: every outcome derives from durable caller context and verified fixtures. */
export class DeterministicFakeProvider implements GenerationProvider {
  readonly bindingId = 'fake-local';
  constructor(private readonly fixtures: FixtureCatalog) {}

  async create(request: ProviderCreateRequest, _context: ProviderContext): Promise<ProviderCreateResult> {
    void _context;
    return { externalJobId: `fake-job-${request.itemId}`, status: 'queued' };
  }

  async get(externalJobId: string, context: ProviderContext): Promise<ProviderPollResult> {
    if (externalJobId !== `fake-job-${context.itemId}`) throw new ProviderOperationError('PROVIDER_NOT_FOUND', 'not_found', 'unknown');
    if (context.cancelRequested && context.scenario !== 'cancel_race') return { status: 'cancelled' };
    if (!context.lastPolledAt) return { status: 'running' };
    if (!context.recovery) {
      if (context.scenario === 'unknown') return { status: 'unknown' };
      if (context.scenario === 'failure' || (context.scenario === 'partial_success' && context.itemIndex % 3 === 1)) return { status: 'failed' };
    }
    const request = context.request;
    if (request.mode === 'copy') return { status: 'result_ready', result: { kind: 'text', text: `演示文案：${request.prompt}`.slice(0, request.copy.maxCharacters) } };
    return { status: 'result_ready', result: { kind: 'fixture', fixtureKey: outputFixtureKey(request)! } };
  }

  async download(result: ProviderResultReference, context: ProviderContext): Promise<ProviderDownloadedMedia> {
    if (result.kind === 'https') throw new ProviderOperationError('PROVIDER_INVALID_REQUEST', 'invalid_request', 'not_submitted');
    if (!context.recovery && context.scenario === 'storage_failure') throw new ProviderOperationError('PROVIDER_STORAGE_FAILED', 'transient', 'unknown');
    if (!context.recovery && context.scenario === 'download_failure') throw new ProviderOperationError('PROVIDER_DOWNLOAD_FAILED', 'transient', 'unknown');
    if (result.kind === 'text') return { kind: 'text', text: result.text };
    try {
      const { bytes, media } = await this.fixtures.readFixture(result.fixtureKey);
      return { kind: 'media', bytes, sha256: media.sha256, mime: media.mime, provenance: 'synthetic_provider_simulation', fixtureMedia: media };
    } catch {
      throw new ProviderOperationError('PROVIDER_DOWNLOAD_FAILED', 'transient', 'unknown');
    }
  }
}
