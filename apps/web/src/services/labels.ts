import type { GenerationItemStatus, ScenarioName } from '../../../../packages/contracts/src/index';
export const statusLabels: Record<GenerationItemStatus | 'partial_succeeded', string> = { queued: '队列中', running: '运行中', finalizing: '保存结果中', cancel_requested: '取消确认中', needs_reconciliation: '待确认状态', succeeded: '生成成功', failed: '生成失败', cancelled: '已取消', partial_succeeded: '部分成功' };
export const scenarioLabels: Record<ScenarioName, string> = { seed: '种子数据', empty: '空态', processing: '处理中', success: '成功', failure: '失败', partial_success: '部分成功', missing_file: '缺少文件', quota_insufficient: '额度不足', storage_failure: '存储不足', request_failure: '请求失败', unknown: '提交结果未知', download_failure: '产物下载失败', cancel_race: '取消与成功竞争' };
export const roleLabels = { product: '商品', person: '人物', background: '背景', reference_video: '参考视频' };
export const modeLabels = { video: '视频生成', image: '图片生成', copy: '文案生成' };

export function failureMessage(error: { code: string; message: string; field?: string }): string {
  if (error.code === 'INVALID_PARAMETERS' && error.field?.includes('duration')) return '时长需为 5–15 秒的整数';
  if (error.message && /[\u3400-\u9fff]/.test(error.message)) return error.message.replace('不符合严格请求契约', '不符合要求');
  const messages: Record<string, string> = {
    PROMPT_REQUIRED: 'Prompt 不能为空', INVALID_PARAMETERS: '请检查所填参数',
    INVALID_INTERVAL: '区间需在视频范围内，且时长为 5–15 秒',
    SCENE_FIXTURE_REQUIRED: '仅支持固定测试视频的场景边界。',
    UNSUPPORTED_MEDIA: '文件无法读取或格式不支持', MEDIA_TOO_SHORT: '视频不能短于 5 秒',
    MEDIA_UNAVAILABLE: '文件暂不可用，请重新选择', FILE_FIXTURE_MISSING: '演示文件缺失',
    QUOTA_INSUFFICIENT: '演示额度不足', NETWORK_ERROR: '请求失败，请重试',
    STORAGE_QUOTA_EXCEEDED: '本地存储空间不足', STORAGE_UNAVAILABLE: '本地存储暂不可用',
    NO_COMPATIBLE_MODEL: '当前参数组合暂不支持', TASK_NOT_READY: '任务尚未就绪，请稍后重试',
  };
  return messages[error.code] ?? '操作未完成，请稍后重试';
}
