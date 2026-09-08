import { describe, expect, it } from 'vitest';

import type { GenerationItem } from '../../contracts/src/index.js';
import {
  applyCreditAction,
  createQuotaState,
  deriveBatchStatus,
  reserveCredits,
  transitionItemStatus,
} from '../src/index.js';

function statusItem(status: GenerationItem['status'], version = 1): GenerationItem {
  return {
    id: 'item-1', batchId: 'batch-1', index: 0, version, status, mode: 'video',
    resultAvailable: status === 'succeeded',
    routingSnapshot: {
      modelKey: 'demo-t2v', bindingId: 'demo-t2v', ruleVersion: 'routing-v2-rebuild',
      reason: 'fixture', capabilitySnapshot: { taskTypes: ['TEXT_TO_VIDEO'], maxReferences: 0 },
    },
    pricingSnapshot: { version: 'demo-v1', unitCost: 1, unitName: 'demo-credit' },
    reviewState: 'pending', libraryState: 'not_saved', updatedAt: '2026-09-08T00:00:00.000Z',
  };
}

describe('deriveBatchStatus', () => {
  it.each([
    [['queued', 'queued'], 'queued'],
    [['queued', 'running'], 'running'],
    [['finalizing', 'cancel_requested'], 'running'],
    [['needs_reconciliation', 'failed'], 'needs_reconciliation'],
    [['succeeded', 'succeeded'], 'succeeded'],
    [['succeeded', 'failed'], 'partial_succeeded'],
    [['succeeded', 'cancelled'], 'partial_succeeded'],
    [['failed', 'cancelled'], 'failed'],
    [['cancelled', 'cancelled'], 'cancelled'],
  ] as const)('derives %j as %s', (statuses, expected) => {
    expect(deriveBatchStatus(statuses.map((status) => statusItem(status)))).toBe(expected);
  });

  it('rejects an empty batch', () => {
    expect(() => deriveBatchStatus([])).toThrowError(expect.objectContaining({ code: 'INVALID_PARAMETERS' }));
  });
});

describe('transitionItemStatus', () => {
  it('uses optimistic version checks and does not let stale events overwrite success', () => {
    const succeeded = statusItem('succeeded', 4);
    expect(transitionItemStatus(succeeded, 'running', 3)).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(transitionItemStatus(succeeded, 'running', 4)).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMETERS' } });
    expect(transitionItemStatus(succeeded, 'succeeded', 4)).toEqual({ ok: true, value: succeeded });
    expect(transitionItemStatus(succeeded, 'succeeded', 1)).toEqual({ ok: true, value: succeeded });
  });

  it('lets a cancellation race converge through finalizing to success', () => {
    const requested = statusItem('cancel_requested', 2);
    const finalizing = transitionItemStatus(requested, 'finalizing', 2);
    expect(finalizing).toMatchObject({ ok: true, value: { status: 'finalizing', version: 3 } });
    if (finalizing.ok) {
      expect(transitionItemStatus(finalizing.value, 'succeeded', 3)).toMatchObject({ ok: true, value: { status: 'succeeded', version: 4 } });
    }
  });
});

describe('quota ledger', () => {
  it('preserves A13 conservation and makes duplicate terminal actions idempotent', () => {
    let state = createQuotaState();
    const granted = applyCreditAction(state, { action: 'GRANT', referenceId: 'grant-10', units: 10 });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    state = granted.value;

    const reserved = reserveCredits(state, ['item-1', 'item-2', 'item-3']);
    expect(reserved).toMatchObject({ ok: true, value: { snapshot: { available: 7, reserved: 3, spent: 0 } } });
    if (!reserved.ok) return;
    state = reserved.value;

    for (const itemId of ['item-1', 'item-2']) {
      const committed = applyCreditAction(state, { action: 'COMMIT', referenceId: itemId, units: 1 });
      expect(committed.ok).toBe(true);
      if (committed.ok) state = committed.value;
    }
    const released = applyCreditAction(state, { action: 'RELEASE', referenceId: 'item-3', units: 1 });
    expect(released).toMatchObject({ ok: true, value: { snapshot: { granted: 10, available: 8, reserved: 0, spent: 2 } } });
    if (!released.ok) return;

    const duplicate = applyCreditAction(released.value, { action: 'COMMIT', referenceId: 'item-1', units: 1 });
    expect(duplicate).toEqual({ ok: true, value: released.value });
    expect(duplicate.ok && duplicate.value.ledger).toHaveLength(7);
  });

  it('rejects a whole reservation batch without partial changes when quota is insufficient', () => {
    const initial = applyCreditAction(createQuotaState(), { action: 'GRANT', referenceId: 'grant-2', units: 2 });
    if (!initial.ok) throw new Error('test setup failed');

    expect(reserveCredits(initial.value, ['one', 'two', 'three'])).toMatchObject({
      ok: false,
      error: { code: 'QUOTA_INSUFFICIENT' },
    });
    expect(initial.value.snapshot).toMatchObject({ available: 2, reserved: 0, spent: 0 });
  });

  it('rejects invalid transitions and mismatched duplicate action amounts', () => {
    const initial = applyCreditAction(createQuotaState(), { action: 'GRANT', referenceId: 'grant', units: 1 });
    if (!initial.ok) throw new Error('test setup failed');
    const reserved = applyCreditAction(initial.value, { action: 'RESERVE', referenceId: 'item', units: 1 });
    if (!reserved.ok) throw new Error('test setup failed');

    expect(applyCreditAction(reserved.value, { action: 'RESERVE', referenceId: 'item', units: 2 })).toMatchObject({ ok: false, error: { code: 'INVALID_LEDGER_TRANSITION' } });
    expect(applyCreditAction(reserved.value, { action: 'RELEASE', referenceId: 'unknown', units: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_LEDGER_TRANSITION' } });
  });
});
