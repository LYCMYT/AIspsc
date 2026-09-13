import { expect, it } from 'vitest';
import { B21C_REQUEST, isB21cRequest, selectAuthorizedAgnesBinding } from '../src/authorized-agnes.js';
it('accepts only the immutable exact experiment request and returns independent routing snapshots', () => {
  expect(isB21cRequest(structuredClone(B21C_REQUEST))).toBe(true);
  expect(Object.isFrozen(B21C_REQUEST)).toBe(true); expect(Object.isFrozen(B21C_REQUEST.video)).toBe(true); expect(Object.isFrozen(B21C_REQUEST.references)).toBe(true);
  for (const patch of [{ count: 2 }, { references: [{ role: 'product', assetId: 'a' }] }, { prompt: `${B21C_REQUEST.prompt} ` }, { mode: 'copy' }, { video: { ...B21C_REQUEST.video, audio: true } }, { video: { ...B21C_REQUEST.video, durationSeconds: 6 } }, { video: { ...B21C_REQUEST.video, resolution: '1080p' } }, { video: { ...B21C_REQUEST.video, ratio: '9:16' } }, { extra: 'value' }]) {
    expect(isB21cRequest({ ...B21C_REQUEST, ...patch })).toBe(false);
    expect(selectAuthorizedAgnesBinding({ ...B21C_REQUEST, ...patch }).ok).toBe(false);
  }
  const first = selectAuthorizedAgnesBinding(B21C_REQUEST); const second = selectAuthorizedAgnesBinding(B21C_REQUEST);
  if (!first.ok || !second.ok) throw Error('routing missing');
  first.value.capabilitySnapshot.video!.durationSeconds.push(6);
  expect(second.value.capabilitySnapshot.video!.durationSeconds).toEqual([5]);
});
