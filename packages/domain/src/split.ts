import { DomainError } from '../../contracts/src/index.js';

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface SceneSplitPlan {
  sceneRanges: Interval[];
  intervals: Interval[];
  expandedIntervals: Interval[];
}

type SplitErrorCode = 'MEDIA_TOO_SHORT' | 'INVALID_INTERVAL';

const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 15_000;

function fail(code: SplitErrorCode): never {
  throw new DomainError(code, code);
}

function requireDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    fail('INVALID_INTERVAL');
  }
  if (durationMs < MIN_INTERVAL_MS) {
    fail('MEDIA_TOO_SHORT');
  }
}

function dedupe(intervals: Interval[]): Interval[] {
  const seen = new Set<string>();
  const result: Interval[] = [];
  for (const interval of intervals) {
    const key = `${interval.startMs}:${interval.endMs}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(interval);
    }
  }
  return result;
}

function offsetIntervals(intervals: Interval[], offsetMs: number): Interval[] {
  return intervals.map(({ startMs, endMs }) => ({
    startMs: startMs + offsetMs,
    endMs: endMs + offsetMs,
  }));
}

export function planSequentialSplit(durationMs: number): Interval[] {
  requireDuration(durationMs);

  const intervals: Interval[] = [];
  let startMs = 0;
  while (startMs + MAX_INTERVAL_MS <= durationMs) {
    intervals.push({ startMs, endMs: startMs + MAX_INTERVAL_MS });
    startMs += MAX_INTERVAL_MS;
  }

  const remainderMs = durationMs - startMs;
  if (remainderMs > 0) {
    const tailStartMs = remainderMs < MIN_INTERVAL_MS ? durationMs - MIN_INTERVAL_MS : startMs;
    intervals.push({ startMs: tailStartMs, endMs: durationMs });
  }
  return intervals;
}

function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function planAverageSplit(durationMs: number): Interval[] {
  requireDuration(durationMs);
  if (durationMs <= MAX_INTERVAL_MS) {
    return [{ startMs: 0, endMs: durationMs }];
  }

  const count = Math.ceil(durationMs / MAX_INTERVAL_MS);
  const denominator = count - 1;
  const spanMs = durationMs - MAX_INTERVAL_MS;
  return Array.from({ length: count }, (_, index) => {
    const startMs = roundHalfUp(index * spanMs, denominator);
    return { startMs, endMs: startMs + MAX_INTERVAL_MS };
  });
}

function validateSceneCuts(durationMs: number, sceneCutMs: number[]): void {
  if (!Array.isArray(sceneCutMs)) {
    fail('INVALID_INTERVAL');
  }
  let previous = 0;
  for (const cutMs of sceneCutMs) {
    if (!Number.isSafeInteger(cutMs) || cutMs <= 0 || cutMs >= durationMs || cutMs <= previous) {
      fail('INVALID_INTERVAL');
    }
    previous = cutMs;
  }
}

function expandShortScene(range: Interval, durationMs: number): Interval {
  const midpointMs = Math.floor((range.startMs + range.endMs + 1) / 2);
  const maxStartMs = durationMs - MIN_INTERVAL_MS;
  const startMs = Math.min(maxStartMs, Math.max(0, midpointMs - MIN_INTERVAL_MS / 2));
  return { startMs, endMs: startMs + MIN_INTERVAL_MS };
}

export function planSceneSplit(durationMs: number, sceneCutMs: number[]): SceneSplitPlan {
  requireDuration(durationMs);
  validateSceneCuts(durationMs, sceneCutMs);

  const sceneRanges: Interval[] = [];
  let rangeStartMs = 0;
  for (const cutMs of sceneCutMs) {
    sceneRanges.push({ startMs: rangeStartMs, endMs: cutMs });
    rangeStartMs = cutMs;
  }
  sceneRanges.push({ startMs: rangeStartMs, endMs: durationMs });

  if (sceneCutMs.length === 0) {
    return { sceneRanges, intervals: planSequentialSplit(durationMs), expandedIntervals: [] };
  }

  const intervals: Interval[] = [];
  const expandedIntervals: Interval[] = [];
  for (const range of sceneRanges) {
    const rangeDurationMs = range.endMs - range.startMs;
    if (rangeDurationMs < MIN_INTERVAL_MS) {
      const expanded = expandShortScene(range, durationMs);
      expandedIntervals.push(expanded);
      intervals.push(expanded);
    } else {
      intervals.push(...offsetIntervals(planSequentialSplit(rangeDurationMs), range.startMs));
    }
  }

  return {
    sceneRanges,
    intervals: dedupe(intervals),
    expandedIntervals: dedupe(expandedIntervals),
  };
}

export function validateManualIntervals(durationMs: number, intervals: Interval[]): Interval[] {
  requireDuration(durationMs);
  if (!Array.isArray(intervals) || intervals.length === 0) {
    fail('INVALID_INTERVAL');
  }
  for (const interval of intervals) {
    if (
      !interval ||
      !Number.isSafeInteger(interval.startMs) ||
      !Number.isSafeInteger(interval.endMs) ||
      interval.startMs < 0 ||
      interval.endMs > durationMs ||
      interval.startMs >= interval.endMs ||
      interval.endMs - interval.startMs < MIN_INTERVAL_MS ||
      interval.endMs - interval.startMs > MAX_INTERVAL_MS
    ) {
      fail('INVALID_INTERVAL');
    }
  }
  return intervals.map(({ startMs, endMs }) => ({ startMs, endMs }));
}
