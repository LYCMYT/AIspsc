import type {
  CreditLedgerEntry,
  CreditSnapshot,
  LedgerAction,
  Result,
} from '../../contracts/src/index.js';

export interface QuotaState {
  snapshot: CreditSnapshot;
  ledger: CreditLedgerEntry[];
}

export interface CreditAction {
  action: LedgerAction;
  referenceId: string;
  units: number;
  reason?: string;
  createdAt?: string;
}

export function createQuotaState(): QuotaState {
  return {
    snapshot: {
      granted: 0,
      available: 0,
      reserved: 0,
      spent: 0,
      reservations: {},
      appliedActions: [],
    },
    ledger: [],
  };
}

function invalid(message: string): Result<never> {
  return { ok: false, error: { code: 'INVALID_LEDGER_TRANSITION', message } };
}

export function applyCreditAction(
  state: QuotaState,
  command: CreditAction,
): Result<QuotaState> {
  if (!Number.isInteger(command.units) || command.units <= 0 || !command.referenceId.trim()) {
    return invalid('额度动作要求正整数 units 和非空 referenceId');
  }
  const actionKey = `${command.referenceId}:${command.action}`;
  const existing = state.ledger.find(
    (entry) => entry.referenceId === command.referenceId && entry.action === command.action,
  );
  if (existing) {
    return existing.units === command.units
      ? { ok: true, value: state }
      : invalid('相同 referenceId 与动作不能使用不同额度');
  }

  const snapshot: CreditSnapshot = {
    ...state.snapshot,
    reservations: { ...state.snapshot.reservations },
    appliedActions: [...state.snapshot.appliedActions, actionKey],
  };

  if (command.action === 'GRANT') {
    snapshot.granted += command.units;
    snapshot.available += command.units;
  } else if (command.action === 'RESERVE') {
    if (snapshot.reservations[command.referenceId]) {
      return invalid('子项已有额度预占');
    }
    if (snapshot.available < command.units) {
      return { ok: false, error: { code: 'QUOTA_INSUFFICIENT', message: '可用演示额度不足' } };
    }
    snapshot.available -= command.units;
    snapshot.reserved += command.units;
    snapshot.reservations[command.referenceId] = {
      itemId: command.referenceId,
      reservedUnits: command.units,
      finalState: 'reserved',
    };
  } else {
    const reservation = snapshot.reservations[command.referenceId];
    if (!reservation || reservation.finalState !== 'reserved') {
      return invalid('只有有效预占可以结算或释放');
    }
    if (reservation.reservedUnits !== command.units) {
      return invalid('结算额度必须等于原预占额度');
    }
    snapshot.reserved -= command.units;
    if (command.action === 'COMMIT') {
      snapshot.spent += command.units;
      snapshot.reservations[command.referenceId] = { ...reservation, finalState: 'committed' };
    } else {
      snapshot.available += command.units;
      snapshot.reservations[command.referenceId] = { ...reservation, finalState: 'released' };
    }
  }

  const entry: CreditLedgerEntry = {
    referenceId: command.referenceId,
    action: command.action,
    units: command.units,
    createdAt: command.createdAt ?? '1970-01-01T00:00:00.000Z',
    ...(command.reason ? { reason: command.reason } : {}),
  };
  return { ok: true, value: { snapshot, ledger: [...state.ledger, entry] } };
}

export function reserveCredits(
  state: QuotaState,
  itemIds: readonly string[],
  unitsPerItem = 1,
): Result<QuotaState> {
  if (
    itemIds.length === 0 ||
    new Set(itemIds).size !== itemIds.length ||
    !Number.isInteger(unitsPerItem) ||
    unitsPerItem <= 0
  ) {
    return invalid('预占要求非空且不重复的 itemId 与正整数单价');
  }
  if (state.snapshot.available < itemIds.length * unitsPerItem) {
    return { ok: false, error: { code: 'QUOTA_INSUFFICIENT', message: '整批可用演示额度不足' } };
  }

  let next = state;
  for (const itemId of itemIds) {
    const result = applyCreditAction(next, {
      action: 'RESERVE',
      referenceId: itemId,
      units: unitsPerItem,
    });
    if (!result.ok) return result;
    next = result.value;
  }
  return { ok: true, value: next };
}
