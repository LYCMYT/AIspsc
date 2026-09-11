import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020';

const schema = JSON.parse(readFileSync(resolve('contracts/real-evaluation-record.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, formats: { 'date-time': true } });
const validate = ajv.compile(schema);

function applicability(applicable = true, reason?: string) {
  return { applicable, ...(reason ? { reason } : {}) };
}

function validRecord() {
  return {
    experimentId: 'EXP-2026-09-001',
    caseId: 'EV001',
    candidateModel: 'Seedance 2.0',
    provider: 'provider-under-test',
    apiModelId: 'verified-model-id',
    providerDocsCheckedAt: '2026-09-11T15:00:00Z',
    startedAt: '2026-09-11T15:01:00Z',
    completedAt: '2026-09-11T15:02:00Z',
    prompt: '展示测试商品并缓慢转动镜头。',
    references: [{
      role: 'product',
      assetId: 'asset-product-1',
      sha256: 'a'.repeat(64),
      source: 'owned-test',
    }],
    normalizedRequest: {
      mode: 'video',
      durationSeconds: 5,
      ratio: '9:16',
      resolution: '720p',
      audio: false,
    },
    providerRequestSummary: {
      duration: 5,
      ratio: '9:16',
      audio: false,
    },
    externalJobId: 'job-1',
    providerStatusTimeline: [
      { at: '2026-09-11T15:01:00Z', providerStatus: 'queued', normalizedStatus: 'queued' },
      { at: '2026-09-11T15:02:00Z', providerStatus: 'done', normalizedStatus: 'succeeded' },
    ],
    platformOutcome: 'succeeded',
    resultMedia: {
      path: 'evaluation/outputs/EXP-2026-09-001.mp4',
      sha256: 'b'.repeat(64),
      mime: 'video/mp4',
      actualDurationMs: 5000,
      width: 720,
      height: 1280,
      hasAudio: false,
    },
    latencyMs: 60000,
    estimatedCost: 1,
    actualCost: 1,
    currency: 'TEST',
    pricingEvidence: {
      source: 'official-provider-pricing-page',
      checkedAt: '2026-09-11T15:00:00Z',
      pricingVersionOrNote: 'Recorded for contract test only; not a real price.',
    },
    review: {
      rubricVersion: 'rubric-v2-rebuild',
      score: 7,
      applicability: {
        Q01: applicability(),
        Q02: applicability(),
        Q03: applicability(false, 'No person is required in EV001.'),
        Q04: applicability(),
        Q05: applicability(),
        Q06: applicability(),
        Q07: applicability(),
        Q08: applicability(),
        Q09: applicability(),
        Q10: applicability(),
        Q11: applicability(),
      },
      issueTags: [],
      hardFailures: [],
      technicalErrors: [],
      decision: 'approved',
      reason: 'Contract-test fixture only.',
      reviewedAt: '2026-09-11T15:03:00Z',
    },
    badCases: [],
    notes: 'Synthetic record for schema validation; not a real model result.',
  };
}

describe('B1.5 real evaluation evidence contract', () => {
  it('accepts a complete non-secret evaluation record', () => {
    expect(validate(validRecord()), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects provider request summaries that expose credential-like fields', () => {
    const base = validRecord();
    const record: unknown = {
      ...base,
      providerRequestSummary: { ...base.providerRequestSummary, api_key: 'must-not-be-recorded' },
    };
    expect(validate(record)).toBe(false);
  });

  it('requires a reason whenever a rubric dimension is not applicable', () => {
    const record = validRecord();
    record.review.applicability.Q03 = { applicable: false } as typeof record.review.applicability.Q03;
    expect(validate(record)).toBe(false);
  });
});
