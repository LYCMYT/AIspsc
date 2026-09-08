import type {
  BasicMediaReviewInput,
  DomainFailure,
  EvaluationDimensionId,
  GenerationItem,
  HardFailureCode,
  Result,
  ReviewInput,
  VideoReviewInput,
} from '../../contracts/src/index.js';

export interface ReviewDecision {
  decision: 'approved' | 'rejected';
  reason: string;
  canSave: boolean;
  automaticallySave: false;
}

const dimensionIds: EvaluationDimensionId[] = [
  'Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11',
];

const hardFailureDimension: Record<HardFailureCode, EvaluationDimensionId> = {
  H01: 'Q01',
  H02: 'Q02',
  H03: 'Q04',
};

function failure(message: string, field?: string): Result<never, DomainFailure> {
  return { ok: false, error: { code: 'INVALID_PARAMETERS', message, field } };
}

function decision(
  value: 'approved' | 'rejected',
  reason: string,
): Result<ReviewDecision> {
  return {
    ok: true,
    value: {
      decision: value,
      reason,
      canSave: value === 'approved',
      automaticallySave: false,
    },
  };
}

function decideVideo(form: VideoReviewInput): Result<ReviewDecision> {
  if (!Number.isInteger(form.score) || form.score < 1 || form.score > 10) {
    return failure('综合分必须是 1–10 的整数', 'score');
  }

  let applicableCount = 0;
  for (const id of dimensionIds) {
    const applicability = form.applicability[id];
    if (!applicability || typeof applicability.applicable !== 'boolean') {
      return failure('必须记录全部 11 个维度的适用性', `applicability.${id}`);
    }
    if (applicability.applicable) {
      applicableCount += 1;
    } else if (!applicability.reason?.trim()) {
      return failure('不适用维度必须填写原因', `applicability.${id}.reason`);
    }
  }
  if (applicableCount === 0) {
    return failure('审核不能将全部 11 个维度标记为不适用', 'applicability');
  }

  if (form.technicalErrors.length > 0) {
    return decision('rejected', `技术预检失败：${form.technicalErrors.join(', ')}`);
  }

  const effectiveHardFailures = form.hardFailures.filter(
    (code) => form.applicability[hardFailureDimension[code]].applicable,
  );
  if (effectiveHardFailures.length > 0) {
    return decision('rejected', `存在适用的硬失败：${effectiveHardFailures.join(', ')}`);
  }

  if (form.score < 7) {
    if (form.issueTags.length === 0) {
      return failure('低于 7 分必须至少选择一个问题标签', 'issueTags');
    }
    if (!form.notes?.trim()) {
      return failure('低于 7 分必须填写问题备注', 'notes');
    }
    return decision('rejected', `综合分 ${form.score} 低于入库门槛`);
  }
  return decision('approved', `综合分 ${form.score} 且无适用硬失败或技术失败`);
}

function decideBasic(form: BasicMediaReviewInput): Result<ReviewDecision> {
  if (form.humanDecision === 'rejected' && !form.reason?.trim()) {
    return failure('人工拒绝必须填写原因', 'reason');
  }
  if (!form.readable) return decision('rejected', '输出不可读取');
  if (!form.followsTask) return decision('rejected', '输出未通过任务遵循检查');
  if (form.humanDecision === 'rejected') return decision('rejected', form.reason!.trim());
  return decision('approved', '人工通过且输出可读取、符合任务要求');
}

export function decideReview(
  item: Pick<GenerationItem, 'status' | 'mode' | 'resultAvailable'>,
  form: ReviewInput,
): Result<ReviewDecision> {
  if (item.status !== 'succeeded' || !item.resultAvailable) {
    return {
      ok: false,
      error: { code: 'ITEM_NOT_READY', message: '只有产物可用的成功子项才能审核' },
    };
  }
  if (item.mode === 'video') {
    if (form.rubricVersion !== 'rubric-v2-rebuild') {
      return failure('视频必须使用 11 维视频审核表', 'rubricVersion');
    }
    return decideVideo(form);
  }
  if (form.rubricVersion !== 'basic-media-review-v1') {
    return failure('图片和文案必须使用基础媒体审核表', 'rubricVersion');
  }
  return decideBasic(form);
}
