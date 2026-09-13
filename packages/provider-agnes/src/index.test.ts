import { describe, expect, it } from 'vitest';
import {
  AgnesProviderError,
  AgnesVideoClient,
  buildAgnesVideoCreateBody,
  normalizeAgnesVideoStatus,
} from './index.ts';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Agnes provider adapter contract', () => {
  it('maps a supported 5-second 720p landscape request to the documented API body', () => {
    expect(buildAgnesVideoCreateBody({
      prompt: 'A blue cube rotates slowly in a clean studio.',
      durationSeconds: 5,
      ratio: '16:9',
      resolution: '720p',
      audio: false,
    })).toEqual({
      model: 'agnes-video-v2.0',
      prompt: 'A blue cube rotates slowly in a clean studio.',
      width: 1280,
      height: 720,
      num_frames: 121,
      frame_rate: 24,
    });
  });

  it('uses the image field for a single image-guided request', () => {
    expect(buildAgnesVideoCreateBody({
      prompt: 'Keep the product stable while the camera moves closer.',
      imageUrl: 'https://example.com/product.png',
      durationSeconds: 5,
      ratio: '9:16',
      resolution: '720p',
      audio: false,
      seed: 7,
    })).toEqual({
      model: 'agnes-video-v2.0',
      prompt: 'Keep the product stable while the camera moves closer.',
      image: 'https://example.com/product.png',
      width: 720,
      height: 1280,
      num_frames: 121,
      frame_rate: 24,
      seed: 7,
    });
  });

  it('rejects unsupported audio and undocumented platform durations instead of silently changing them', () => {
    expect(() => buildAgnesVideoCreateBody({
      prompt: 'test', durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: true,
    })).toThrow(/audio/i);
    expect(() => buildAgnesVideoCreateBody({
      prompt: 'test', durationSeconds: 7, ratio: '16:9', resolution: '720p', audio: false,
    })).toThrow(/duration/i);
  });

  it('normalizes Agnes task states without inventing a terminal result', () => {
    expect(normalizeAgnesVideoStatus('queued')).toBe('queued');
    expect(normalizeAgnesVideoStatus('in_progress')).toBe('running');
    expect(normalizeAgnesVideoStatus('completed')).toBe('succeeded');
    expect(normalizeAgnesVideoStatus('failed')).toBe('failed');
    expect(normalizeAgnesVideoStatus('mystery')).toBe('needs_reconciliation');
  });

  it('creates a video with bearer auth and does not retry a failed paid create request', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ error: { message: 'busy' } }, 503);
    };
    const client = new AgnesVideoClient({ apiKey: 'test-secret', fetchImpl: fakeFetch });

    await expect(client.createVideo({
      prompt: 'A blue cube rotates slowly.',
      durationSeconds: 5,
      ratio: '16:9',
      resolution: '720p',
      audio: false,
    })).rejects.toMatchObject({
      name: 'AgnesProviderError',
      status: 503,
      kind: 'transient',
    } satisfies Partial<AgnesProviderError>);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://apihub.agnes-ai.com/v1/videos');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer test-secret');
  });

  it('redacts the configured API key if a provider error unexpectedly echoes it', async () => {
    const fakeFetch: typeof fetch = async () => jsonResponse({
      error: { message: 'authorization failed for test-secret' },
    }, 401);
    const client = new AgnesVideoClient({ apiKey: 'test-secret', fetchImpl: fakeFetch });

    let caught: unknown;
    try {
      await client.createVideo({
        prompt: 'A blue cube rotates slowly.',
        durationSeconds: 5,
        ratio: '16:9',
        resolution: '720p',
        audio: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgnesProviderError);
    expect((caught as AgnesProviderError).message).toBe('authorization failed for [REDACTED]');
    expect((caught as AgnesProviderError).message).not.toContain('test-secret');
  });

  it('polls by video_id and returns only normalized safe result fields', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse({
        id: 'task_1',
        task_id: 'task_1',
        video_id: 'video_1',
        object: 'video',
        model: 'agnes-video-v2.0',
        status: 'completed',
        progress: 100,
        seconds: '5.0',
        size: '1280x720',
        metadata: {
          url: 'https://platform-outputs.agnes-ai.space/videos/result.mp4',
          size_mapping: { resolution: '720p', ratio: '16:9' },
        },
      });
    };
    const client = new AgnesVideoClient({ apiKey: 'test-secret', fetchImpl: fakeFetch });

    await expect(client.getVideo('video_1')).resolves.toEqual({
      id: 'task_1',
      taskId: 'task_1',
      videoId: 'video_1',
      model: 'agnes-video-v2.0',
      providerStatus: 'completed',
      status: 'succeeded',
      progress: 100,
      seconds: 5,
      size: '1280x720',
      sizeMapping: { ratio: '16:9', resolution: '720p' },
      resultUrl: 'https://platform-outputs.agnes-ai.space/videos/result.mp4',
      errorMessage: undefined,
    });
    expect(calls).toEqual([
      'https://apihub.agnes-ai.com/agnesapi?video_id=video_1&model_name=agnes-video-v2.0',
    ]);
  });

  it('normalizes provider identifiers, timestamps, and the allowlisted size mapping', async () => {
    const client = new AgnesVideoClient({
      apiKey: 'test-secret',
      fetchImpl: async () => jsonResponse({
        id: 'upstream-id',
        task_id: 'task_1',
        video_id: 'video_1',
        created_at: '1700000000',
        status: 'queued',
        metadata: {
          size_mapping: {
            adjusted: true,
            width: 1280,
            height: 720,
            requested_width: 1280,
            requested_height: 720,
            ratio: '16:9',
            resolution: '720p',
            message: 'drop this arbitrary text',
            extra: { secret: 'drop this arbitrary object' },
          },
        },
      }),
    });

    await expect(client.createVideo({
      prompt: 'A blue cube rotates slowly.',
      durationSeconds: 5,
      ratio: '16:9',
      resolution: '720p',
      audio: false,
    })).resolves.toMatchObject({
      id: 'upstream-id',
      taskId: 'task_1',
      videoId: 'video_1',
      createdAt: 1700000000,
      sizeMapping: {
        adjusted: true,
        width: 1280,
        height: 720,
        requestedWidth: 1280,
        requestedHeight: 720,
        ratio: '16:9',
        resolution: '720p',
      },
    });
  });

  it('requires an injected fetch implementation instead of falling back to global fetch', () => {
    expect(() => new AgnesVideoClient({ apiKey: 'test-secret' })).toThrow(/fetch/i);
  });

  it('rejects redirected API responses and sends redirect:error without retrying', async () => {
    let calls = 0;
    const client = new AgnesVideoClient({
      apiKey: 'test-secret',
      fetchImpl: async (_input, init) => {
        calls += 1;
        expect(init?.redirect).toBe('error');
        return { ok: true, redirected: true, json: async () => ({ status: 'queued', video_id: 'video_1' }) } as Response;
      },
    });

    await expect(client.createVideo({
      prompt: 'A blue cube rotates slowly.',
      durationSeconds: 5,
      ratio: '16:9',
      resolution: '720p',
      audio: false,
    })).rejects.toMatchObject({ kind: 'transient' });
    expect(calls).toBe(1);
  });
});
