import type {
  CreateGenerationRequest,
  ReferenceRole,
  Result,
  RoutingBinding,
  RoutingDecision,
  RoutingEnvironment,
  TaskType,
} from '../../contracts/src/index.js';

const allDurations = Array.from({ length: 11 }, (_, index) => index + 5);
const videoCapability = {
  durationSeconds: allDurations,
  ratios: ['9:16', '16:9', '1:1'] as const,
  resolutions: ['720p', '1080p'] as const,
  audio: [false, true],
};

function demoBinding(modelKey: string, taskType: TaskType): RoutingBinding {
  return {
    modelKey,
    bindingId: `${modelKey}-executor`,
    priority: 100,
    enabled: true,
    verificationStatus: 'verified',
    environments: ['mock'],
    capabilities: {
      taskTypes: [taskType],
      maxReferences: taskType === 'COPY_GENERATION' || taskType === 'TEXT_TO_VIDEO' ? 0 : 4,
      referenceRoleLimits: { product: 1, person: 1, background: 1, reference_video: 1 },
      ...(taskType.endsWith('VIDEO') || taskType === 'REFERENCE_VIDEO_GEN'
        ? { video: { ...videoCapability, ratios: [...videoCapability.ratios], resolutions: [...videoCapability.resolutions] } }
        : {}),
      ...(taskType === 'IMAGE_GENERATION'
        ? { image: { ratios: ['9:16', '16:9', '1:1'], resolutions: ['1024'] } }
        : {}),
      ...(taskType === 'COPY_GENERATION'
        ? { copy: { languages: ['zh-CN'], maxCharacters: 5000 } }
        : {}),
    },
  };
}

export const DEMO_MODEL_REGISTRY: readonly RoutingBinding[] = [
  demoBinding('demo-t2v', 'TEXT_TO_VIDEO'),
  demoBinding('demo-i2v', 'IMAGE_GUIDED_VIDEO'),
  demoBinding('demo-v2v', 'REFERENCE_VIDEO_GEN'),
  demoBinding('demo-multi', 'MULTI_REFERENCE_VIDEO'),
  demoBinding('demo-image', 'IMAGE_GENERATION'),
  demoBinding('demo-copy', 'COPY_GENERATION'),
];

export function classifyTask(request: CreateGenerationRequest): TaskType {
  if (request.mode === 'copy') return 'COPY_GENERATION';
  if (request.mode === 'image') return 'IMAGE_GENERATION';

  const hasVideo = request.references.some((reference) => reference.role === 'reference_video');
  const hasImage = request.references.some((reference) => reference.role !== 'reference_video');
  if (hasVideo && hasImage) return 'MULTI_REFERENCE_VIDEO';
  if (hasVideo) return 'REFERENCE_VIDEO_GEN';
  if (hasImage) return 'IMAGE_GUIDED_VIDEO';
  return 'TEXT_TO_VIDEO';
}

function roleCounts(request: CreateGenerationRequest): Partial<Record<ReferenceRole, number>> {
  const counts: Partial<Record<ReferenceRole, number>> = {};
  for (const reference of request.references) {
    counts[reference.role] = (counts[reference.role] ?? 0) + 1;
  }
  return counts;
}

function supports(
  binding: RoutingBinding,
  request: CreateGenerationRequest,
  taskType: TaskType,
  environment: RoutingEnvironment,
): boolean {
  if (!binding.enabled || !binding.environments.includes(environment)) return false;
  if (environment === 'real' && binding.verificationStatus !== 'verified') return false;
  const capability = binding.capabilities;
  if (!capability.taskTypes.includes(taskType)) return false;
  if (request.references.length > capability.maxReferences) return false;

  const counts = roleCounts(request);
  for (const [role, count] of Object.entries(counts) as Array<[ReferenceRole, number]>) {
    if (count > (capability.referenceRoleLimits?.[role] ?? 0)) return false;
  }

  if (request.mode === 'video') {
    const video = capability.video;
    if (
      !video ||
      !video.durationSeconds.includes(request.video.durationSeconds) ||
      !video.ratios.includes(request.video.ratio) ||
      !video.resolutions.includes(request.video.resolution) ||
      !video.audio.includes(request.video.audio)
    ) {
      return false;
    }
    if (!video.combinations) return true;
    return video.combinations.some(
      (combination) =>
        combination.durationSeconds === request.video.durationSeconds &&
        combination.ratio === request.video.ratio &&
        combination.resolution === request.video.resolution &&
        combination.audio === request.video.audio &&
        request.references.length <= (combination.maxReferences ?? capability.maxReferences),
    );
  }
  if (request.mode === 'image') {
    const image = capability.image;
    return Boolean(
      image &&
        image.ratios.includes(request.image.ratio) &&
        image.resolutions.includes(request.image.resolution),
    );
  }
  const copy = capability.copy;
  return Boolean(
    copy &&
      copy.languages.includes(request.copy.language) &&
      request.copy.maxCharacters <= copy.maxCharacters,
  );
}

export function selectBinding(
  request: CreateGenerationRequest,
  taskType: TaskType,
  registry: readonly RoutingBinding[] = DEMO_MODEL_REGISTRY,
  environment: RoutingEnvironment = 'mock',
): Result<RoutingDecision> {
  const selected = registry
    .filter((binding) => supports(binding, request, taskType, environment))
    .slice()
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        left.modelKey.localeCompare(right.modelKey) ||
        left.bindingId.localeCompare(right.bindingId),
    )[0];

  if (!selected) {
    return {
      ok: false,
      error: {
        code: 'NO_COMPATIBLE_MODEL',
        message: '没有支持当前全部参数组合的可用模型',
      },
    };
  }

  return {
    ok: true,
    value: {
      modelKey: selected.modelKey,
      bindingId: selected.bindingId,
      ruleVersion: 'routing-v2-rebuild',
      reason: `匹配 ${taskType} 的完整参数组合，并按固定优先级选择`,
      capabilitySnapshot: structuredClone(selected.capabilities),
    },
  };
}
