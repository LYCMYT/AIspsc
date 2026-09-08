import Ajv2020 from 'ajv/dist/2020.js';

import {
  generationRequestSchema,
  type CreateGenerationRequest,
  type DomainErrorCode,
  type ReferenceAsset,
  type Result,
} from '../../contracts/src/index.js';

const validateSchema = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictTypes: false,
}).compile(generationRequestSchema);

function invalid(
  code: DomainErrorCode,
  message: string,
  field?: string,
): Result<never> {
  return { ok: false, error: { code, message, field } };
}

function schemaField(): string | undefined {
  const error = validateSchema.errors?.[0];
  if (!error) return undefined;
  if (error.keyword === 'required') {
    const missing = (error.params as { missingProperty?: string }).missingProperty;
    return [error.instancePath.replace(/^\//, '').replaceAll('/', '.'), missing]
      .filter(Boolean)
      .join('.');
  }
  return error.instancePath.replace(/^\//, '').replaceAll('/', '.') || undefined;
}

export function validateGenerationRequest(
  input: unknown,
  assets: readonly ReferenceAsset[],
  workspaceId = 'demo',
): Result<CreateGenerationRequest> {
  if (!validateSchema(input)) {
    const field = schemaField();
    if (field === 'prompt' && typeof input === 'object' && input !== null) {
      const prompt = (input as { prompt?: unknown }).prompt;
      if (prompt === undefined || (typeof prompt === 'string' && !prompt.trim())) {
        return invalid('PROMPT_REQUIRED', 'Prompt 不能为空', 'prompt');
      }
    }
    return invalid('INVALID_PARAMETERS', '生成参数不符合严格请求契约', field);
  }

  const request = input as unknown as CreateGenerationRequest;
  const seenRoles = new Set<string>();
  for (let index = 0; index < request.references.length; index += 1) {
    const reference = request.references[index]!;
    if (seenRoles.has(reference.role)) {
      return invalid(
        'REFERENCE_ROLE_DUPLICATE',
        '同一素材角色最多只能出现一次',
        `references[${index}].role`,
      );
    }
    seenRoles.add(reference.role);

    const asset = assets.find((candidate) => candidate.id === reference.assetId);
    if (!asset) {
      return invalid('ASSET_NOT_FOUND', '引用素材不存在', `references[${index}].assetId`);
    }
    if (asset.workspaceId !== workspaceId) {
      return invalid('ASSET_FORBIDDEN', '无权使用其他工作区的素材', `references[${index}].assetId`);
    }
    if (asset.availability !== 'available') {
      return invalid('ASSET_UNAVAILABLE', '引用素材当前不可用', `references[${index}].assetId`);
    }
    const expectedMediaType = reference.role === 'reference_video' ? 'video' : 'image';
    if (asset.mediaType !== expectedMediaType) {
      return invalid(
        'REFERENCE_TYPE_MISMATCH',
        '素材类型与引用角色不匹配',
        `references[${index}].role`,
      );
    }
  }

  return {
    ok: true,
    value: {
      ...structuredClone(request),
      prompt: request.prompt.trim(),
    },
  };
}
