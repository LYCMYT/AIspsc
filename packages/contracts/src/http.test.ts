import { describe, expect, it } from 'vitest';
import { canonicalJson, validateHttpBody } from './http.js';
import type { ReviewInput } from './generation.js';

const basicForm: ReviewInput = { rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: true, followsTask: true };
const dimensions = ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11'];
const videoForm = { rubricVersion: 'rubric-v2-rebuild', score: 8, applicability: Object.fromEntries(dimensions.map(id => [id, { applicable: true }])), issueTags: [], hardFailures: [], technicalErrors: [] };
const bodies = {
  version: { expectedVersion: 0 }, review: { expectedVersion: 0, form: basicForm, reason: '' },
  save: { expectedVersion: 0, evaluationId: 'review-1' }, reconcile: { expectedVersion: 0, outcome: 'success' },
  fixture: { key: 'image-16x9-1024' }, scenario: { name: 'success' },
} as const;

describe('HTTP command validation', () => {
  for (const kind of Object.keys(bodies) as Array<keyof typeof bodies>) {
    it(`${kind} accepts its exact body and rejects nonobjects, missing and extra properties`, () => {
      expect(validateHttpBody(kind, bodies[kind])).toEqual({ ok: true, value: bodies[kind] });
      for (const value of [null, [], {}, { ...bodies[kind], modelId: 'injected' }]) expect(validateHttpBody(kind, value).ok).toBe(false);
    });
    if ('expectedVersion' in bodies[kind]) {
      it(`${kind} requires a nonnegative safe integer version without coercion`, () => {
        for (const expectedVersion of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
          expect(validateHttpBody(kind, { ...bodies[kind], expectedVersion }).ok).toBe(false);
        }
        const rest: Record<string, unknown> = { ...bodies[kind] };
        delete rest.expectedVersion;
        expect(validateHttpBody(kind, rest).ok).toBe(false);
      });
    }
  }
  it('validates all eleven video dimensions and nested form types', () => {
    const check = (form: unknown) => validateHttpBody('review', { expectedVersion: 0, form, reason: '' });
    expect(check(videoForm).ok).toBe(true);
    const missing = { ...videoForm.applicability }; delete missing.Q11;
    for (const form of [
      { ...videoForm, applicability: missing },
      { ...videoForm, applicability: { ...videoForm.applicability, Q12: { applicable: true } } },
      { ...videoForm, applicability: { ...videoForm.applicability, Q01: { applicable: 'yes' } } },
      { ...videoForm, applicability: { ...videoForm.applicability, Q01: { applicable: true, secret: true } } },
      { ...videoForm, score: '8' }, { ...videoForm, score: 8.5 }, { ...videoForm, score: 11 },
      { ...videoForm, rubricVersion: 'old-rubric' }, { ...videoForm, hardFailures: ['H04'] },
      { ...videoForm, issueTags: ['Q12'] }, { ...videoForm, technicalErrors: ['OTHER'] },
      { ...basicForm, readable: 1 }, { ...basicForm, extra: true },
    ]) expect(check(form).ok).toBe(false);
  });
  it('rejects empty identifiers, unsupported scenarios and reconciliation outcomes', () => {
    expect(validateHttpBody('fixture', { key: '' }).ok).toBe(false);
    expect(validateHttpBody('save', { expectedVersion: 0, evaluationId: '' }).ok).toBe(false);
    expect(validateHttpBody('scenario', { name: 'missing_file' }).ok).toBe(false);
    expect(validateHttpBody('scenario', { name: 'invented' }).ok).toBe(false);
    expect(validateHttpBody('reconcile', { expectedVersion: 0, outcome: 'maybe' }).ok).toBe(false);
  });
});

describe('canonical JSON', () => {
  it('sorts object keys recursively and preserves array order', () => {
    expect(canonicalJson({ b: [{ z: 0, a: 1 }], a: true })).toBe('{"a":true,"b":[{"a":1,"z":0}]}');
    expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']));
    expect(canonicalJson({ prompt: '  text  ' })).toBe('{"prompt":"  text  "}');
    expect(canonicalJson(null)).toBe('null');
  });
  it('rejects non-JSON values and prototypes without invoking getters', () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    let accessed = false;
    const getter = { get key() { accessed = true; return 1; } };
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x'), new Date(0), new Map(), Object.create({ x: 1 }), { x: undefined }, [undefined], Array(1), cycle, getter, { [Symbol('x')]: 1 }]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    expect(accessed).toBe(false);
  });
});
