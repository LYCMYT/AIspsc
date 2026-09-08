import { readFileSync, writeFileSync } from 'node:fs';
const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const schemas = {
  CreateGenerationRequest: JSON.parse(readFileSync(new URL('./generation-request.schema.json', import.meta.url), 'utf8')),
  Error: object({ error: object({ code: string, message: string, field: string, retryable: { type: 'boolean' }, requestId: string }, ['code', 'message', 'retryable', 'requestId']) }),
  Accepted: object({ batchId: string, itemIds: { type: 'array', items: string, minItems: 1, maxItems: 4 }, requestId: string }),
  Identifier: object({ id: string, requestId: string }),
  Upload: object({ filename: string, mime: { enum: ['video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/webp'] }, byteSize: { ...integer, minimum: 1, maximum: 209715200 } }),
  UploadComplete: object({ uploadId: string }),
  AssetInput: object({ mediaFileId: string, text: string, title: string, tags: { type: 'array', items: string } }, ['title', 'tags']),
  AssetPatch: object({ title: string, tags: { type: 'array', items: string }, archived: { type: 'boolean' } }, []),
  SaveToLibrary: object({ evaluationId: string }),
  Interval: object({ startMs: integer, endMs: { type: 'integer', minimum: 1 } }),
  SplitInput: object({ sourceMediaId: string, mode: { enum: ['sequential', 'average', 'scene', 'manual'] }, manualIntervals: { type: 'array', items: ref('Interval'), minItems: 1 } }, ['sourceMediaId', 'mode']),
  Review: {
    oneOf: [
      object({ rubricVersion: { const: 'rubric-v2-rebuild' }, score: { type: 'integer', minimum: 1, maximum: 10 }, applicability: object(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Q${String(i + 1).padStart(2, '0')}`, object({ applicable: { type: 'boolean' }, reason: { type: 'string' } }, ['applicable'])]))), issueTags: { type: 'array', items: { enum: Array.from({ length: 11 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`) } }, hardFailures: { type: 'array', items: { enum: ['H01', 'H02', 'H03'] } }, technicalErrors: { type: 'array', items: { enum: ['TECH_CORRUPT', 'TECH_DURATION', 'TECH_RESOLUTION', 'TECH_AUDIO'] } }, notes: { type: 'string' } }, ['rubricVersion', 'score', 'applicability', 'issueTags', 'hardFailures', 'technicalErrors']),
      object({ rubricVersion: { const: 'basic-media-review-v1' }, humanDecision: { enum: ['approved', 'rejected'] }, readable: { type: 'boolean' }, followsTask: { type: 'boolean' }, reason: { type: 'string' } }, ['rubricVersion', 'humanDecision', 'readable', 'followsTask']),
    ],
  },
  CreditGrant: object({ units: { type: 'integer', minimum: 1 }, reason: string }),
};
const paths = {};
function endpoint(path, method, summary, input, response = 'Identifier', status = '200') {
  const parameters = [...path.matchAll(/\{(\w+)\}/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: string }));
  if (method !== 'get') parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: string });
  const operation = { summary, description: 'B0 共享边界设计；B1 以同型本地服务端口执行，HTTP 与身份权限由 B2 实现。', parameters, security: [{ session: [] }], responses: { [status]: { description: 'Success; response is scoped to the authenticated workspace in B2.', content: { 'application/json': { schema: ref(response) } } }, ...Object.fromEntries(['400', '401', '403', '404', '409', '422', '429', '503'].map((code) => [code, { description: 'Structured error', content: { 'application/json': { schema: ref('Error') } } }])) } };
  if (input) operation.requestBody = { required: true, content: { 'application/json': { schema: ref(input) } } };
  (paths[path] ??= {})[method] = operation;
}
endpoint('/v1/capabilities', 'get', '可用参数及组合限制');
endpoint('/v1/media/uploads', 'post', '建立上传会话', 'Upload');
endpoint('/v1/media/uploads/{id}/complete', 'post', '探测并保存媒体', 'UploadComplete');
endpoint('/v1/assets', 'get', '搜索、媒体和来源筛选');
endpoint('/v1/assets', 'post', '创建上传或人工文案资产', 'AssetInput');
endpoint('/v1/assets/{id}', 'patch', '编辑资产元数据', 'AssetPatch');
endpoint('/v1/generations', 'post', '幂等创建请求与子任务', 'CreateGenerationRequest', 'Accepted', '202');
endpoint('/v1/generations/{id}', 'get', '读取任务快照');
endpoint('/v1/generation-items/{id}/cancel', 'post', '提交取消意图');
endpoint('/v1/generation-items/{id}/retry', 'post', '创建新意图并关联原子任务');
endpoint('/v1/generation-items/{id}/reviews', 'post', '保存不可变审核版本', 'Review');
endpoint('/v1/generation-items/{id}/save-to-library', 'post', '人工通过后手动入库', 'SaveToLibrary');
endpoint('/v1/splits', 'post', '规划切片区间', 'SplitInput');
endpoint('/v1/splits/{id}', 'get', '读取区间和实际可用产物');
endpoint('/v1/credits', 'get', '额度余额');
endpoint('/v1/credit-ledger', 'get', '额度流水');
endpoint('/v1/admin/credit-grants', 'post', 'B2 管理员额度分配，B1 不启用 HTTP', 'CreditGrant');
endpoint('/v1/admin/task-statistics', 'get', 'B2 管理员统计，B1 不启用 HTTP');
const api = { openapi: '3.1.0', info: { title: '多模型 AI营销视频生产平台', version: 'rebuild-v2', description: 'B0 契约基线；B1 仅本地 Mock；HTTP 响应实体将在 B2 与共享 TypeScript 端口一起实现。不得视为已部署 API。' }, paths, components: { schemas, securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'session' } } } };
writeFileSync(new URL('./openapi.json', import.meta.url), JSON.stringify(api, null, 2) + '\n');
