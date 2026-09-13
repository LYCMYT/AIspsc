export const AGNES_VIDEO_MODEL = 'agnes-video-v2.0' as const;
export const AGNES_API_BASE_URL = 'https://apihub.agnes-ai.com' as const;

export type AgnesVideoRatio = '16:9' | '9:16' | '1:1';
export type AgnesVideoResolution = '720p' | '1080p';
export type AgnesDocumentedDuration = 5 | 10;
export type AgnesNormalizedStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_reconciliation';

export interface AgnesVideoCreateInput {
  prompt: string;
  imageUrl?: string;
  durationSeconds: number;
  ratio: AgnesVideoRatio;
  resolution: AgnesVideoResolution;
  audio: boolean;
  seed?: number;
  negativePrompt?: string;
}

export interface AgnesVideoCreateBody {
  model: typeof AGNES_VIDEO_MODEL;
  prompt: string;
  image?: string;
  width: number;
  height: number;
  num_frames: number;
  frame_rate: 24;
  seed?: number;
  negative_prompt?: string;
}

export interface AgnesSizeMapping {
  adjusted?: boolean;
  width?: number;
  height?: number;
  requestedWidth?: number;
  requestedHeight?: number;
  ratio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
  resolution?: '480p' | '720p' | '1080p';
}

export interface AgnesVideoTask {
  id?: string;
  taskId?: string;
  videoId?: string;
  model: string;
  providerStatus: string;
  status: AgnesNormalizedStatus;
  progress?: number;
  seconds?: number;
  size?: string;
  createdAt?: number;
  sizeMapping?: AgnesSizeMapping;
  resultUrl?: string;
  errorMessage?: string;
}

export type AgnesProviderErrorKind =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'transient'
  | 'unknown';

export class AgnesProviderError extends Error {
  readonly kind: AgnesProviderErrorKind;
  readonly status?: number;

  constructor(kind: AgnesProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AgnesProviderError';
    this.kind = kind;
    this.status = status;
  }
}

const documentedFrames: Record<AgnesDocumentedDuration, number> = {
  5: 121,
  10: 241,
};

const requestedSizes: Record<AgnesVideoResolution, Record<AgnesVideoRatio, readonly [number, number]>> = {
  '720p': {
    '16:9': [1280, 720],
    '9:16': [720, 1280],
    '1:1': [720, 720],
  },
  '1080p': {
    '16:9': [1920, 1080],
    '9:16': [1080, 1920],
    '1:1': [1080, 1080],
  },
};

function assertPublicHttpUrl(value: string, field: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgnesProviderError('invalid_request', `${field} must be a valid public http(s) URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AgnesProviderError('invalid_request', `${field} must use http or https.`);
  }
}

export function buildAgnesVideoCreateBody(input: AgnesVideoCreateInput): AgnesVideoCreateBody {
  const prompt = input.prompt.trim();
  if (!prompt) throw new AgnesProviderError('invalid_request', 'Prompt is required.');
  if (input.audio) {
    throw new AgnesProviderError('invalid_request', 'Agnes Video V2.0 has no documented audio-generation request parameter.');
  }
  if (input.durationSeconds !== 5 && input.durationSeconds !== 10) {
    throw new AgnesProviderError('invalid_request', 'Agnes binding currently supports only documented 5s and 10s duration presets.');
  }
  if (input.imageUrl) assertPublicHttpUrl(input.imageUrl, 'imageUrl');
  if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0)) {
    throw new AgnesProviderError('invalid_request', 'seed must be a non-negative integer.');
  }

  const [width, height] = requestedSizes[input.resolution][input.ratio];
  return {
    model: AGNES_VIDEO_MODEL,
    prompt,
    ...(input.imageUrl ? { image: input.imageUrl } : {}),
    width,
    height,
    num_frames: documentedFrames[input.durationSeconds],
    frame_rate: 24,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.negativePrompt?.trim() ? { negative_prompt: input.negativePrompt.trim() } : {}),
  };
}

export function normalizeAgnesVideoStatus(status: string): AgnesNormalizedStatus {
  switch (status) {
    case 'queued': return 'queued';
    case 'in_progress': return 'running';
    case 'completed': return 'succeeded';
    case 'failed': return 'failed';
    default: return 'needs_reconciliation';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : undefined;
}

const maxReportedDimension = 9999;
const reportedRatios = new Set<AgnesSizeMapping['ratio']>(['16:9', '9:16', '1:1', '4:3', '3:4']);
const reportedResolutions = new Set<AgnesSizeMapping['resolution']>(['480p', '720p', '1080p']);

function safeNonNegativeInteger(value: unknown): number | undefined {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : undefined;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function safeDimension(value: unknown): number | undefined {
  const candidate = safeNonNegativeInteger(value);
  return candidate !== undefined && candidate > 0 && candidate <= maxReportedDimension ? candidate : undefined;
}

function normalizeSizeMapping(value: unknown): AgnesSizeMapping | undefined {
  if (!isRecord(value)) return undefined;
  const result: AgnesSizeMapping = {};
  if (typeof value.adjusted === 'boolean') result.adjusted = value.adjusted;
  const width = safeDimension(value.width);
  const height = safeDimension(value.height);
  const requestedWidth = safeDimension(value.requested_width ?? value.requestedWidth);
  const requestedHeight = safeDimension(value.requested_height ?? value.requestedHeight);
  if (width !== undefined) result.width = width;
  if (height !== undefined) result.height = height;
  if (requestedWidth !== undefined) result.requestedWidth = requestedWidth;
  if (requestedHeight !== undefined) result.requestedHeight = requestedHeight;
  if (typeof value.ratio === 'string' && reportedRatios.has(value.ratio as AgnesSizeMapping['ratio'])) result.ratio = value.ratio as AgnesSizeMapping['ratio'];
  if (typeof value.resolution === 'string' && reportedResolutions.has(value.resolution as AgnesSizeMapping['resolution'])) result.resolution = value.resolution as AgnesSizeMapping['resolution'];
  return Object.keys(result).length ? result : undefined;
}

function providerErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = stringField(payload, 'message');
  if (direct) return direct;
  const error = payload.error;
  if (isRecord(error)) return stringField(error, 'message');
  return undefined;
}

function redactLiteral(message: string, secret: string): string {
  return secret ? message.split(secret).join('[REDACTED]') : message;
}

function errorKindForStatus(status: number): AgnesProviderErrorKind {
  if (status === 400) return 'invalid_request';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'transient';
  return 'unknown';
}

function normalizeTask(payload: unknown): AgnesVideoTask {
  if (!isRecord(payload)) {
    throw new AgnesProviderError('unknown', 'Agnes returned a non-object video response.');
  }
  const providerStatus = stringField(payload, 'status');
  if (!providerStatus) {
    throw new AgnesProviderError('unknown', 'Agnes video response is missing status.');
  }
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const secondsRaw = payload.seconds;
  const seconds = typeof secondsRaw === 'number'
    ? secondsRaw
    : typeof secondsRaw === 'string' && secondsRaw.trim() && Number.isFinite(Number(secondsRaw))
      ? Number(secondsRaw)
      : undefined;
  const id = stringField(payload, 'id');
  const createdAt = safeNonNegativeInteger(payload.created_at);
  const sizeMapping = normalizeSizeMapping(metadata?.size_mapping);
  return {
    ...(id ? { id } : {}),
    taskId: stringField(payload, 'task_id') ?? id,
    videoId: stringField(payload, 'video_id'),
    model: stringField(payload, 'model') ?? AGNES_VIDEO_MODEL,
    providerStatus,
    status: normalizeAgnesVideoStatus(providerStatus),
    progress: numberField(payload, 'progress'),
    seconds,
    size: stringField(payload, 'size'),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(sizeMapping ? { sizeMapping } : {}),
    // The live /agnesapi response can be flat, unlike the documented envelope.
    resultUrl: (metadata ? stringField(metadata, 'url')?.trim() : undefined) || stringField(payload, 'url')?.trim() || undefined,
    errorMessage: providerErrorMessage(payload),
  };
}

export interface AgnesVideoClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export class AgnesVideoClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: AgnesVideoClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new AgnesProviderError('unauthorized', 'AGNES_API_KEY is required.');
    if (typeof options.fetchImpl !== 'function') throw new AgnesProviderError('invalid_request', 'An injected fetch implementation is required.');
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl;
    this.baseUrl = (options.baseUrl ?? AGNES_API_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async createVideo(input: AgnesVideoCreateInput): Promise<AgnesVideoTask> {
    const body = buildAgnesVideoCreateBody(input);
    const payload = await this.requestJson(`${this.baseUrl}/v1/videos`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return this.sanitizeTask(normalizeTask(payload));
  }

  async getVideo(videoId: string): Promise<AgnesVideoTask> {
    if (!videoId.trim()) throw new AgnesProviderError('invalid_request', 'videoId is required.');
    const params = new URLSearchParams({ video_id: videoId, model_name: AGNES_VIDEO_MODEL });
    const payload = await this.requestJson(`${this.baseUrl}/agnesapi?${params.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    // The opaque query ID is authoritative; upstream ids may be different.
    return this.sanitizeTask({ ...normalizeTask(payload), videoId });
  }

  private sanitizeTask(task: AgnesVideoTask): AgnesVideoTask {
    return task.errorMessage
      ? { ...task, errorMessage: redactLiteral(task.errorMessage, this.apiKey) }
      : task;
  }

  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AgnesProviderError('transient', 'Agnes request failed before a response was received.');
    }

    if (response.redirected) throw new AgnesProviderError('transient', 'Agnes request redirected unexpectedly.');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const kind = errorKindForStatus(response.status);
      const rawMessage = providerErrorMessage(payload) ?? `Agnes request failed with HTTP ${response.status}.`;
      throw new AgnesProviderError(kind, redactLiteral(rawMessage, this.apiKey), response.status);
    }
    return payload;
  }
}
