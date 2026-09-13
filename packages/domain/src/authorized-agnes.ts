import { canonicalJson, type VideoGenerationRequest, type RoutingDecision, type Result } from '../../contracts/src/index.js';

/** Fixed experiment identity only. This helper grants no network authorization. */
export const B21C_REQUEST: VideoGenerationRequest = {
  mode: 'video', prompt: 'A simple blue geometric cube on a clean light background, slow gentle camera push-in, minimal studio lighting, stable composition, no text, no people.',
  count: 1, references: [], video: { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false },
};
Object.freeze(B21C_REQUEST.references); Object.freeze(B21C_REQUEST.video); Object.freeze(B21C_REQUEST);
export function isB21cRequest(value: unknown): value is VideoGenerationRequest {
  try { return canonicalJson(value) === canonicalJson(B21C_REQUEST); } catch { return false; }
}
export function selectAuthorizedAgnesBinding(request: unknown): Result<RoutingDecision> {
  if (!isB21cRequest(request)) return { ok: false, error: { code: 'NO_COMPATIBLE_MODEL', message: '请求不符合本次受控执行参数' } };
  return { ok: true, value: {
    modelKey: 'agnes-video-v2.0', bindingId: 'agnes-authorized-real', ruleVersion: 'b21c-fixed-t2v-v1', reason: '本次固定参数受控执行；演示额度独立记账',
    capabilitySnapshot: { taskTypes: ['TEXT_TO_VIDEO'], maxReferences: 0, video: { durationSeconds: [5], ratios: ['16:9'], resolutions: ['720p'], audio: [false] } },
  } };
}
