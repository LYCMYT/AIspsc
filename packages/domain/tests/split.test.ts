import { describe, expect, it } from 'vitest';

import splitVectors from '../../../fixtures/split-vectors.json';
import { DomainError } from '../../contracts/src/index.js';
import {
  planAverageSplit,
  planSceneSplit,
  planSequentialSplit,
  validateManualIntervals,
  type Interval,
} from '../src/split.js';

type SplitVector = {
  id: string;
  mode: 'sequential' | 'average';
  durationMs: number;
  expectedIntervals: Interval[] | null;
  expectedError: string | null;
};

describe('sequential and average split vectors', () => {
  for (const vector of splitVectors as SplitVector[]) {
    it(`${vector.id} follows the rebuild split rule`, () => {
      const planner = vector.mode === 'sequential' ? planSequentialSplit : planAverageSplit;

      if (vector.expectedError) {
        expect(() => planner(vector.durationMs)).toThrowError(vector.expectedError);
        try {
          planner(vector.durationMs);
        } catch (error) {
          expect(error).toMatchObject({ code: vector.expectedError });
        }
        return;
      }

      expect(planner(vector.durationMs)).toEqual(vector.expectedIntervals);
    });
  }
});

describe('planSceneSplit', () => {
  it('keeps the original scene ranges and uses sequential intervals when there are no cuts', () => {
    expect(planSceneSplit(32000, [])).toEqual({
      sceneRanges: [{ startMs: 0, endMs: 32000 }],
      intervals: [
        { startMs: 0, endMs: 15000 },
        { startMs: 15000, endMs: 30000 },
        { startMs: 27000, endMs: 32000 },
      ],
      expandedIntervals: [],
    });
  });

  it('expands short scenes around their midpoint, clamps to the source, and deduplicates', () => {
    expect(planSceneSplit(10000, [1000, 2000])).toEqual({
      sceneRanges: [
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2000 },
        { startMs: 2000, endMs: 10000 },
      ],
      intervals: [
        { startMs: 0, endMs: 5000 },
        { startMs: 2000, endMs: 10000 },
      ],
      expandedIntervals: [{ startMs: 0, endMs: 5000 }],
    });
  });

  it('splits long scenes internally and preserves a short tail inside that scene', () => {
    expect(planSceneSplit(40000, [2000])).toEqual({
      sceneRanges: [
        { startMs: 0, endMs: 2000 },
        { startMs: 2000, endMs: 40000 },
      ],
      intervals: [
        { startMs: 0, endMs: 5000 },
        { startMs: 2000, endMs: 17000 },
        { startMs: 17000, endMs: 32000 },
        { startMs: 32000, endMs: 40000 },
      ],
      expandedIntervals: [{ startMs: 0, endMs: 5000 }],
    });
  });

  it('rejects cuts that are not sorted, unique, integer, and strictly inside the source', () => {
    for (const cuts of [[2000, 1000], [1000, 1000], [0], [10000], [1000.5]]) {
      expect(() => planSceneSplit(10000, cuts)).toThrowError('INVALID_INTERVAL');
    }
  });
});

describe('validateManualIntervals', () => {
  it('accepts legal integer intervals and returns a defensive copy', () => {
    const input: Interval[] = [{ startMs: 1000, endMs: 6000 }, { startMs: 5000, endMs: 20000 }];
    const result = validateManualIntervals(22000, input);

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(input[0]);
  });

  it('rejects empty, non-integer, out-of-bounds, and out-of-length intervals', () => {
    const invalidInputs: Interval[][] = [
      [],
      [{ startMs: 0, endMs: 4999 }],
      [{ startMs: 0.5, endMs: 5000 }],
      [{ startMs: -1, endMs: 5000 }],
      [{ startMs: 0, endMs: 15001 }],
      [{ startMs: 18000, endMs: 22001 }],
      [{ startMs: 6000, endMs: 6000 }],
    ];

    for (const intervals of invalidInputs) {
      expect(() => validateManualIntervals(22000, intervals)).toThrowError('INVALID_INTERVAL');
    }
  });

  it('rejects a source duration below the minimum reference length', () => {
    try {
      validateManualIntervals(4999, [{ startMs: 0, endMs: 4999 }]);
      throw new Error('expected a domain error');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: 'MEDIA_TOO_SHORT' });
    }
  });
});
