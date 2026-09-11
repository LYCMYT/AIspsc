import { AGNES_VIDEO_MODEL, AgnesProviderError } from './index.ts';
import type { AgnesVideoClient, AgnesVideoCreateInput, AgnesVideoTask } from './index.ts';

export interface DownloadedVideo {
  filename: string;
  sha256: string;
  byteSize: number;
  media: { durationMs: number; width: number; height: number; hasAudio: boolean; decodeVerified: boolean };
}

export interface SmokeEvidence {
  version: 2;
  provider: 'Agnes AI';
  model: typeof AGNES_VIDEO_MODEL;
  operation: 'recover_existing' | 'create_one';
  startedAt: string;
  completedAt?: string;
  operationLatencyMs?: number;
  phase: 'preflight' | 'submitting' | 'polling' | 'finalizing' | 'done';
  outcome: 'pending' | 'succeeded' | 'failed' | 'needs_reconciliation';
  newTaskSubmissions: number;
  externalVideoId?: string;
  request?: Omit<AgnesVideoCreateInput, 'imageUrl'> & { hasImageReference: boolean };
  statusTimeline: Array<{ at: string; providerStatus: string; resultAvailable: boolean }>;
  providerReported?: { seconds?: number; size?: string };
  result?: DownloadedVideo;
  errorCode?: string;
  actualCostUsd: null;
  costStatus: 'not_reported_by_provider';
}

export interface SmokeOptions {
  client: Pick<AgnesVideoClient, 'createVideo' | 'getVideo'>;
  existingVideoId?: string;
  request?: AgnesVideoCreateInput;
  allowCreate?: boolean;
  persist: (record: SmokeEvidence) => Promise<void>;
  download: (url: string) => Promise<DownloadedVideo>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

/** Core orchestration has no env access or logs. Recovery NEVER calls createVideo. */
export async function runAgnesSmoke(options: SmokeOptions): Promise<SmokeEvidence> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('INVALID_POLLING_LIMITS');
  }
  let videoId = options.existingVideoId?.trim();
  const started = now();
  const evidence: SmokeEvidence = {
    version: 2, provider: 'Agnes AI', model: AGNES_VIDEO_MODEL,
    operation: videoId ? 'recover_existing' : 'create_one',
    startedAt: new Date(started).toISOString(), phase: 'preflight', outcome: 'pending',
    newTaskSubmissions: 0, externalVideoId: videoId, statusTimeline: [],
    actualCostUsd: null, costStatus: 'not_reported_by_provider',
  };
  let failureCode = 'PREFLIGHT_FAILED';
  const save = () => options.persist(structuredClone(evidence));
  await save();
  try {
    let task: AgnesVideoTask;
    if (videoId) {
      evidence.phase = 'polling';
      failureCode = 'QUERY_FAILED';
      task = await options.client.getVideo(videoId);
    } else {
      if (!options.allowCreate || !options.request) {
        failureCode = 'CREATE_NOT_AUTHORIZED';
        throw new Error(failureCode);
      }
      const { imageUrl, ...request } = options.request;
      evidence.request = { ...request, hasImageReference: Boolean(imageUrl) };
      evidence.phase = 'submitting';
      evidence.newTaskSubmissions = 1;
      failureCode = 'CREATE_OUTCOME_UNKNOWN';
      await save(); // Capture submission intent BEFORE the non-idempotent POST.
      task = await options.client.createVideo(options.request);
      videoId = task.videoId?.trim();
      if (!videoId) throw new Error(failureCode);
      evidence.externalVideoId = videoId;
    }
    while (true) {
      evidence.providerReported = { seconds: task.seconds, size: task.size };
      evidence.statusTimeline.push({
        at: new Date(now()).toISOString(),
        providerStatus: ['queued', 'in_progress', 'completed', 'failed'].includes(task.providerStatus) ? task.providerStatus : 'unknown',
        resultAvailable: Boolean(task.resultUrl),
      });
      evidence.phase = task.status === 'succeeded' ? 'finalizing' : 'polling';
      await save(); // Persist the original query ID even if download or the next GET fails.
      if (task.status === 'failed') {
        failureCode = 'PROVIDER_TASK_FAILED';
        throw new Error(failureCode);
      }
      if (task.status === 'succeeded' && task.resultUrl) {
        failureCode = 'RESULT_DOWNLOAD_FAILED';
        evidence.result = await options.download(task.resultUrl);
        evidence.phase = 'done';
        evidence.outcome = 'succeeded';
        break;
      }
      if (now() - started >= timeoutMs) {
        failureCode = task.status === 'succeeded' ? 'RESULT_NOT_READY' : 'POLL_TIMEOUT';
        throw new Error(failureCode);
      }
      await sleep(Math.min(pollMs, timeoutMs - (now() - started)));
      failureCode = 'QUERY_FAILED';
      task = await options.client.getVideo(videoId);
    }
    evidence.completedAt = new Date(now()).toISOString();
    evidence.operationLatencyMs = now() - started;
    await save();
    return evidence;
  } catch (error) {
    // Do not persist raw exception messages, provider bodies, result URLs or headers.
    const rejected = error instanceof AgnesProviderError && ['unauthorized', 'invalid_request'].includes(error.kind);
    evidence.errorCode = rejected ? 'PROVIDER_REQUEST_REJECTED' : failureCode;
    evidence.outcome = rejected || failureCode === 'PROVIDER_TASK_FAILED' || failureCode === 'CREATE_NOT_AUTHORIZED'
      ? 'failed' : 'needs_reconciliation';
    evidence.operationLatencyMs = now() - started;
    await save();
    // eslint-disable-next-line preserve-caught-error -- Raw provider causes may carry credentials or signed URLs; retain only the safe stage code.
    throw new Error(evidence.errorCode);
  }
}
