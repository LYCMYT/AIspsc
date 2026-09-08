import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import requestCases from '../../../fixtures/request-cases.json';
import { DomainError, generationRequestSchema } from './index.js';

describe('generationRequestSchema', () => {
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
  }).compile(generationRequestSchema);

  for (const fixture of requestCases) {
    it(`${fixture.id} matches the strict request contract`, () => {
      expect(validate(fixture.input), JSON.stringify(validate.errors)).toBe(
        fixture.schemaValid,
      );
    });
  }

  it('rejects unknown fields at the request and mode-parameter boundaries', () => {
    expect(
      validate({
        mode: 'video',
        prompt: '展示商品',
        references: [],
        count: 1,
        video: {
          durationSeconds: 10,
          ratio: '9:16',
          resolution: '720p',
          audio: false,
          silentDowngrade: true,
        },
        modelId: 'hidden-model',
      }),
    ).toBe(false);
  });

  it('rejects a video-mode request that omits its video parameters', () => {
    expect(
      validate({
        mode: 'video',
        prompt: '展示商品',
        references: [],
        count: 1,
      }),
    ).toBe(false);
  });
});

describe('DomainError', () => {
  it('exposes a stable code and optional field for service boundaries', () => {
    const error = new DomainError('INVALID_INTERVAL', '区间无效', 'intervals[0]');

    expect(error).toMatchObject({
      name: 'DomainError',
      code: 'INVALID_INTERVAL',
      message: '区间无效',
      field: 'intervals[0]',
    });
  });
});
