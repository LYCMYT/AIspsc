import { createHash } from 'node:crypto';
import { canonicalJson, type VideoGenerationRequest } from '../../../contracts/src/index.js';
import { B21C_REQUEST, isB21cRequest } from '../../../domain/src/authorized-agnes.js';
export const EXPERIMENT_ID = 'B21C-2026-09-13';
export const AUTHORIZED_AT = '2026-09-13T14:25:42Z';
export const AUTHORIZED_QUOTE = '授权执行 B2.1C：只允许 1 次 Agnes Video V2.0 T2V Create，count=1、duration=5s，不得因超时、下载失败或后处理失败再次 Create。';
export const IDEMPOTENCY_KEY = 'b21c-2026-09-13-one';
export const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export interface AuthorizationRecord {
  version: 1; experimentId: typeof EXPERIMENT_ID; authorizedAt: typeof AUTHORIZED_AT;
  quote: typeof AUTHORIZED_QUOTE; request: VideoGenerationRequest; requestHash: string; sourceSha: string;
}
export function validateAuthorization(value: unknown, sourceSha: string): AuthorizationRecord {
  const expected = { version: 1, experimentId: EXPERIMENT_ID, authorizedAt: AUTHORIZED_AT, quote: AUTHORIZED_QUOTE, request: B21C_REQUEST, requestHash: digest(B21C_REQUEST), sourceSha };
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !value || typeof value !== 'object' || !isB21cRequest((value as AuthorizationRecord).request) || canonicalJson(value) !== canonicalJson(expected)) throw Error('AUTHORIZED_RECORD_INVALID');
  return structuredClone(expected) as AuthorizationRecord;
}
export function assertControlledEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.CI && env.CI !== 'false' && env.CI !== '0') throw Error('REAL_PROVIDER_CALL_FORBIDDEN_IN_CI');
  if (Object.keys(env).some(key => key.toUpperCase().startsWith('GIT_') && !['GIT_PAGER', 'GIT_TERMINAL_PROMPT'].includes(key.toUpperCase()))) throw Error('AUTHORIZED_GIT_OVERRIDE');
}
