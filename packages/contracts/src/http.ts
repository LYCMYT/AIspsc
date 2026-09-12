import Ajv2020 from 'ajv/dist/2020.js';
import type { DemoManifest, DemoSnapshot, ScenarioName } from './demo.js';
import type { MediaFile, Result, ReviewInput } from './generation.js';

export interface ItemVersionInput { expectedVersion: number }
export interface ItemReviewInput extends ItemVersionInput { form: ReviewInput; reason: string }
export interface ItemSaveInput extends ItemVersionInput { evaluationId: string }
export interface ItemReconcileInput extends ItemVersionInput { outcome: 'success' | 'failure' | 'cancelled' }
export interface FixtureLoadInput { key: string }
export interface ScenarioInput { name: ScenarioName }
export interface PendingGeneration {
  itemId: string;
  dueAt: number;
  scenario: ScenarioName;
  phase: 'submit' | 'accept' | 'complete' | 'download';
  downloadRetry: boolean;
}
export interface GenerationState extends DemoSnapshot {
  /** Private HTTP schema; absent only before lifecycle adoption. */
  schemaVersion?: 2;
  sequence: number;
  pending: PendingGeneration[];
  memo: Record<string, { hash: string; value: unknown }>;
  reviewForms: Record<string, { form: ReviewInput; reason: string; resultSha256: string }>;
}
export interface GenerationContext { now: number; manifest: DemoManifest }
export type WorkerEvent =
  | { kind: 'submitting'; itemId: string; expectedVersion: number }
  | { kind: 'submitted'; itemId: string; expectedVersion: number }
  | { kind: 'complete'; itemId: string; expectedVersion: number; media?: MediaFile }
  | { kind: 'download_failed'; itemId: string; expectedVersion: number };
export interface HttpCommandBodies {
  version: ItemVersionInput; review: ItemReviewInput; save: ItemSaveInput;
  reconcile: ItemReconcileInput; fixture: FixtureLoadInput; scenario: ScenarioInput;
}

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
const identifier = { type: 'string', minLength: 1, pattern: '\\S' };
const expectedVersion = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const dimensions = ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11'];
const tags = (values: string[]) => ({ type: 'array', items: { type: 'string', enum: values }, uniqueItems: true });
const form = { oneOf: [
  object({ rubricVersion: { const: 'basic-media-review-v1' }, humanDecision: { enum: ['approved', 'rejected'] }, readable: { type: 'boolean' }, followsTask: { type: 'boolean' }, reason: text }, ['rubricVersion', 'humanDecision', 'readable', 'followsTask']),
  object({ rubricVersion: { const: 'rubric-v2-rebuild' }, score: { type: 'integer', minimum: 1, maximum: 10 },
    applicability: object(Object.fromEntries(dimensions.map(id => [id, object({ applicable: { type: 'boolean' }, reason: text }, ['applicable'])]))),
    issueTags: tags(dimensions), hardFailures: tags(['H01', 'H02', 'H03']), technicalErrors: tags(['TECH_CORRUPT', 'TECH_DURATION', 'TECH_RESOLUTION', 'TECH_AUDIO']), notes: text,
  }, ['rubricVersion', 'score', 'applicability', 'issueTags', 'hardFailures', 'technicalErrors']),
] };
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validators = {
  version: ajv.compile<ItemVersionInput>(object({ expectedVersion })),
  review: ajv.compile<ItemReviewInput>(object({ expectedVersion, form, reason: text })),
  save: ajv.compile<ItemSaveInput>(object({ expectedVersion, evaluationId: identifier })),
  reconcile: ajv.compile<ItemReconcileInput>(object({ expectedVersion, outcome: { enum: ['success', 'failure', 'cancelled'] } })),
  fixture: ajv.compile<FixtureLoadInput>(object({ key: identifier })),
  scenario: ajv.compile<ScenarioInput>(object({ name: { enum: ['seed', 'empty', 'processing', 'success', 'failure', 'partial_success', 'unknown', 'download_failure', 'cancel_race', 'quota_insufficient', 'request_failure', 'storage_failure'] } })),
};

export function validateHttpBody<K extends keyof HttpCommandBodies>(kind: K, value: unknown): Result<HttpCommandBodies[K]> {
  // JSON transport cannot supply accessors, exotic prototypes or undefined values.
  // Apply the same boundary for in-process callers before schema traversal.
  try { canonicalJson(value); } catch { return { ok: false, error: { code: 'INVALID_PARAMETERS', message: '请求参数不符合 HTTP 契约' } }; }
  if (!validators[kind](value)) return { ok: false, error: { code: 'INVALID_PARAMETERS', message: '请求参数不符合 HTTP 契约' } };
  return { ok: true, value: value as HttpCommandBodies[K] };
}

/** Canonical JSON only: never invokes toJSON/accessors or silently drops data. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (entry: unknown): string => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number' && Number.isFinite(entry)) return JSON.stringify(entry);
    if (typeof entry !== 'object' || entry === null) throw new TypeError('Only JSON values are supported');
    if (ancestors.has(entry)) throw new TypeError('Cyclic JSON value');
    const array = Array.isArray(entry);
    if (Object.getPrototypeOf(entry) !== (array ? Array.prototype : Object.prototype)) throw new TypeError('Unexpected JSON prototype');
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Reflect.ownKeys(entry).some(key => typeof key !== 'string')) throw new TypeError('Unexpected JSON symbol');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Unexpected JSON property');
    }
    ancestors.add(entry);
    let result: string;
    if (array) {
      if (Object.keys(entry).length !== entry.length) throw new TypeError('Sparse or extended JSON array');
      const values: string[] = [];
      for (let i = 0; i < entry.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor) throw new TypeError('Sparse JSON array');
        values.push(encode(descriptor.value));
      }
      result = `[${values.join(',')}]`;
    } else {
      result = `{${Object.keys(descriptors).sort().map(key => `${JSON.stringify(key)}:${encode(descriptors[key]!.value)}`).join(',')}}`;
    }
    ancestors.delete(entry);
    return result;
  };
  return encode(value);
}
