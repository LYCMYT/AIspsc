import { describe, expect, it } from 'vitest';

import reviewCases from '../../../fixtures/review-cases.json';
import type {
  EvaluationDimensionId,
  GenerationItem,
  VideoReviewInput,
} from '../../contracts/src/index.js';
import { decideReview } from '../src/index.js';

const dimensionIds: EvaluationDimensionId[] = [
  'Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11',
];

function applicability(na: EvaluationDimensionId[] = []): VideoReviewInput['applicability'] {
  return Object.fromEntries(
    dimensionIds.map((id) => [
      id,
      na.includes(id)
        ? { applicable: false, reason: '任务不包含此对象或约束' }
        : { applicable: true },
    ]),
  ) as VideoReviewInput['applicability'];
}

function item(mode: 'video' | 'image' | 'copy', status = 'succeeded'): GenerationItem {
  return {
    id: 'item-1', batchId: 'batch-1', index: 0, version: 1,
    status: status as GenerationItem['status'], mode,
    resultAvailable: status === 'succeeded',
    routingSnapshot: {
      modelKey: `demo-${mode}`, bindingId: `demo-${mode}`,
      ruleVersion: 'routing-v2-rebuild', reason: 'fixture',
      capabilitySnapshot: { taskTypes: [], maxReferences: 0 },
    },
    pricingSnapshot: { version: 'demo-v1', unitCost: 1, unitName: 'demo-credit' },
    reviewState: 'pending', libraryState: 'not_saved', updatedAt: '2026-09-08T00:00:00.000Z',
  };
}

describe('decideReview fixture decisions', () => {
  for (const fixture of reviewCases) {
    it(`${fixture.id} follows the review decision table`, () => {
      if (fixture.mode === 'video') {
        const na = Object.entries(fixture.applicability ?? {})
          .filter(([, value]) => value === false)
          .map(([id]) => id as EvaluationDimensionId);
        const result = decideReview(item('video', fixture.itemStatus), {
          rubricVersion: 'rubric-v2-rebuild',
          score: fixture.score ?? 7,
          applicability: applicability(na),
          issueTags: (fixture.score ?? 7) < 7 ? ['Q09'] : [],
          hardFailures: (fixture.hardFailures ?? []) as VideoReviewInput['hardFailures'],
          technicalErrors: (fixture.technicalErrors ?? []) as VideoReviewInput['technicalErrors'],
          notes: (fixture.score ?? 7) < 7 ? '核心指令未完成' : undefined,
        });
        if (fixture.expectedError) {
          expect(result).toMatchObject({ ok: false, error: { code: fixture.expectedError } });
        } else {
          expect(result).toMatchObject({ ok: true, value: { decision: fixture.expectedDecision, automaticallySave: false } });
        }
        return;
      }

      const result = decideReview(item(fixture.mode as 'image' | 'copy'), {
        rubricVersion: 'basic-media-review-v1',
        humanDecision: fixture.humanDecision as 'approved' | 'rejected',
        readable: fixture.readable ?? true,
        followsTask: true,
        reason: fixture.reason,
      });
      expect(result).toMatchObject({ ok: true, value: { decision: fixture.expectedDecision, automaticallySave: false } });
    });
  }

  it('requires a reason for every not-applicable video dimension', () => {
    const form: VideoReviewInput = {
      rubricVersion: 'rubric-v2-rebuild', score: 8,
      applicability: applicability(['Q03']), issueTags: [], hardFailures: [], technicalErrors: [],
    };
    form.applicability.Q03 = { applicable: false };

    expect(decideReview(item('video'), form)).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMETERS', field: 'applicability.Q03.reason' } });
  });

  it('rejects an all-N/A video review as non-evidence', () => {
    expect(decideReview(item('video'), {
      rubricVersion: 'rubric-v2-rebuild', score: 8,
      applicability: applicability(dimensionIds), issueTags: [], hardFailures: [], technicalErrors: [],
    })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMETERS' } });
  });

  it('does not trigger an inapplicable hard failure', () => {
    expect(decideReview(item('video'), {
      rubricVersion: 'rubric-v2-rebuild', score: 8,
      applicability: applicability(['Q01']), issueTags: [], hardFailures: ['H01'], technicalErrors: [],
    })).toMatchObject({ ok: true, value: { decision: 'approved' } });
  });

  it('requires rejection reasons and rejects unreadable basic media', () => {
    expect(decideReview(item('image'), {
      rubricVersion: 'basic-media-review-v1', humanDecision: 'rejected', readable: true,
      followsTask: true,
    })).toMatchObject({ ok: false, error: { field: 'reason' } });

    expect(decideReview(item('copy'), {
      rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: false,
      followsTask: true,
    })).toMatchObject({ ok: true, value: { decision: 'rejected' } });
  });
});
