import {
  DomainError,
  type GenerationBatchStatus,
  type GenerationItem,
  type GenerationItemStatus,
  type Result,
} from '../../contracts/src/index.js';

const active = new Set<GenerationItemStatus>([
  'queued', 'running', 'finalizing', 'cancel_requested',
]);
const terminal = new Set<GenerationItemStatus>(['succeeded', 'failed', 'cancelled']);

export function deriveBatchStatus(
  items: readonly Pick<GenerationItem, 'status'>[],
): GenerationBatchStatus {
  if (items.length === 0) {
    throw new DomainError('INVALID_PARAMETERS', '批次必须至少包含一个子项', 'items');
  }
  const statuses = items.map((item) => item.status);
  if (statuses.every((status) => status === 'queued')) return 'queued';
  if (statuses.some((status) => active.has(status))) return 'running';
  if (statuses.some((status) => status === 'needs_reconciliation')) {
    return 'needs_reconciliation';
  }
  if (statuses.every((status) => status === 'succeeded')) return 'succeeded';
  if (statuses.some((status) => status === 'succeeded')) return 'partial_succeeded';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  return 'cancelled';
}

const allowedTransitions: Record<GenerationItemStatus, ReadonlySet<GenerationItemStatus>> = {
  queued: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['finalizing', 'failed', 'needs_reconciliation', 'cancel_requested']),
  finalizing: new Set(['succeeded', 'failed', 'needs_reconciliation']),
  cancel_requested: new Set(['cancelled', 'finalizing', 'needs_reconciliation']),
  needs_reconciliation: new Set(['running', 'finalizing', 'succeeded', 'failed', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function transitionItemStatus(
  item: GenerationItem,
  nextStatus: GenerationItemStatus,
  expectedVersion: number,
): Result<GenerationItem> {
  if (item.status === nextStatus && terminal.has(item.status)) {
    return { ok: true, value: item };
  }
  if (item.version !== expectedVersion) {
    return {
      ok: false,
      error: { code: 'VERSION_CONFLICT', message: '子项版本已变化，拒绝过期事件' },
    };
  }
  if (!allowedTransitions[item.status].has(nextStatus)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_PARAMETERS',
        message: `不允许从 ${item.status} 迁移到 ${nextStatus}`,
        field: 'status',
      },
    };
  }
  return {
    ok: true,
    value: {
      ...item,
      status: nextStatus,
      version: item.version + 1,
      resultAvailable: nextStatus === 'succeeded' ? item.resultAvailable : false,
    },
  };
}
