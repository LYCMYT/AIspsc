import { describe, expect, it } from 'vitest';

import requestCases from '../../../fixtures/request-cases.json';
import type {
  CreateGenerationRequest,
  ReferenceAsset,
  RoutingBinding,
} from '../../contracts/src/index.js';
import {
  DEMO_MODEL_REGISTRY,
  classifyTask,
  selectBinding,
  validateGenerationRequest,
} from '../src/index.js';

const assets: ReferenceAsset[] = [
  { id: 'p1', workspaceId: 'demo', mediaType: 'image', availability: 'available' },
  { id: 'm1', workspaceId: 'demo', mediaType: 'image', availability: 'available' },
  { id: 'v1', workspaceId: 'demo', mediaType: 'video', availability: 'available' },
];

describe('validateGenerationRequest and classifyTask', () => {
  for (const fixture of requestCases) {
    it(`${fixture.id} produces the specified validation/classification result`, () => {
      const result = validateGenerationRequest(fixture.input, assets);

      if (!fixture.schemaValid) {
        expect(result).toMatchObject({ ok: false, error: { code: fixture.expected } });
        return;
      }

      expect(result.ok).toBe(true);
      if (result.ok && fixture.kind === 'routing') {
        expect(classifyTask(result.value)).toBe(fixture.expected);
      }
    });
  }

  it.each([
    ['missing asset', [{ assetId: 'gone', role: 'product' }], 'ASSET_NOT_FOUND'],
    ['cross-workspace asset', [{ assetId: 'other', role: 'product' }], 'ASSET_FORBIDDEN'],
    ['unavailable asset', [{ assetId: 'missing', role: 'product' }], 'ASSET_UNAVAILABLE'],
    ['duplicate role', [{ assetId: 'p1', role: 'product' }, { assetId: 'p2', role: 'product' }], 'REFERENCE_ROLE_DUPLICATE'],
    ['role/media mismatch', [{ assetId: 'v1', role: 'product' }], 'REFERENCE_TYPE_MISMATCH'],
  ])('rejects %s after structural validation', (_name, references, code) => {
    const result = validateGenerationRequest(
      {
        mode: 'video',
        prompt: '展示商品',
        references,
        count: 1,
        video: { durationSeconds: 10, ratio: '9:16', resolution: '720p', audio: false },
      },
      [
        ...assets,
        { id: 'other', workspaceId: 'other', mediaType: 'image', availability: 'available' },
        { id: 'missing', workspaceId: 'demo', mediaType: 'image', availability: 'missing' },
        { id: 'p2', workspaceId: 'demo', mediaType: 'image', availability: 'available' },
      ],
    );

    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it('reports a missing required prompt as PROMPT_REQUIRED', () => {
    const result = validateGenerationRequest(
      {
        mode: 'video', references: [], count: 1,
        video: { durationSeconds: 10, ratio: '9:16', resolution: '720p', audio: false },
      },
      assets,
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'PROMPT_REQUIRED', field: 'prompt' } });
  });
});

const videoRequest: CreateGenerationRequest = {
  mode: 'video',
  prompt: '展示商品',
  references: [{ assetId: 'p1', role: 'product' }],
  count: 1,
  video: { durationSeconds: 10, ratio: '9:16', resolution: '720p', audio: false },
};

function binding(overrides: Partial<RoutingBinding>): RoutingBinding {
  return {
    modelKey: 'z-model',
    bindingId: 'binding-z',
    priority: 10,
    enabled: true,
    verificationStatus: 'verified',
    environments: ['mock', 'real'],
    capabilities: {
      taskTypes: ['IMAGE_GUIDED_VIDEO'],
      maxReferences: 4,
      referenceRoleLimits: { product: 1, person: 1, background: 1, reference_video: 0 },
      video: {
        durationSeconds: [5, 10, 15],
        ratios: ['9:16'],
        resolutions: ['720p'],
        audio: [false],
      },
    },
    ...overrides,
  };
}

describe('selectBinding', () => {
  it('provides all six deterministic demo executors', () => {
    const selected = new Set(DEMO_MODEL_REGISTRY.map((entry) => entry.modelKey));
    expect(selected).toEqual(
      new Set(['demo-t2v', 'demo-i2v', 'demo-v2v', 'demo-multi', 'demo-image', 'demo-copy']),
    );
  });

  it('rejects an unsupported combination even when every field is individually supported', () => {
    const capabilities = binding({}).capabilities;
    const result = selectBinding(
      { ...videoRequest, video: { ...videoRequest.video, resolution: '1080p', audio: true } },
      'IMAGE_GUIDED_VIDEO',
      [binding({
        capabilities: {
          ...capabilities,
          video: {
            ...capabilities.video!,
            resolutions: ['720p', '1080p'],
            audio: [false, true],
            combinations: [
              { durationSeconds: 10, ratio: '9:16', resolution: '720p', audio: true },
              { durationSeconds: 10, ratio: '9:16', resolution: '1080p', audio: false },
            ],
          },
        },
      })],
      'mock',
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'NO_COMPATIBLE_MODEL' } });
  });

  it('breaks equal-priority ties by model key without mutating the request', () => {
    const before = structuredClone(videoRequest);
    const result = selectBinding(
      videoRequest,
      'IMAGE_GUIDED_VIDEO',
      [binding({ modelKey: 'z-model' }), binding({ modelKey: 'a-model', bindingId: 'binding-a' })],
      'mock',
    );

    expect(result).toMatchObject({ ok: true, value: { modelKey: 'a-model' } });
    expect(videoRequest).toEqual(before);
  });

  it('rejects unverified bindings in real mode', () => {
    const result = selectBinding(
      videoRequest,
      'IMAGE_GUIDED_VIDEO',
      [binding({ verificationStatus: 'unverified' })],
      'real',
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'NO_COMPATIBLE_MODEL' } });
  });
});
