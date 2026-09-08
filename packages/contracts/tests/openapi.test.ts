import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020';

describe('B0 shared API boundary', () => {
  it('rejects illegal request fields through the published generation request schema', () => {
    const path = resolve('contracts/openapi.json');
    expect(existsSync(path), 'publish the shared API contract').toBe(true);
    const api = JSON.parse(readFileSync(path, 'utf8'));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(api.components.schemas.CreateGenerationRequest);
    const request = { mode: 'video', prompt: '测试', references: [], count: 1, video: { durationSeconds: 5, ratio: '9:16', resolution: '720p', audio: false } };
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, modelId: 'unverified' })).toBe(false);
    expect(validate({ ...request, prompt: ' ' })).toBe(false);
    expect(validate({ ...request, video: { ...request.video, durationSeconds: 16 } })).toBe(false);
    expect(validate({ ...request, copy: { language: 'zh-CN', maxCharacters: 300 } })).toBe(false);
  });
  it('publishes the same basic review fields consumed by the service port', () => {
    const api = JSON.parse(readFileSync(resolve('contracts/openapi.json'), 'utf8'));
    const validate = new Ajv2020({ strict: false }).compile(api.components.schemas.Review);
    expect(validate({ rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: true, followsTask: true })).toBe(true);
    expect(validate({ rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: true, followsInstructions: true })).toBe(false);
  });
});
