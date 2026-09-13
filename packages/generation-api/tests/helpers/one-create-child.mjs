import fs from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const [suppliedDirectory, stage] = process.argv.slice(2);
const stages = ['normal', 'before-write', 'after-write', 'before-dispatch', 'after-dispatch'];
if (!suppliedDirectory || !stages.includes(stage)) throw Error('INVALID_CHILD_INPUT');
const directory = resolve(suppliedDirectory);
const contained = relative(resolve('.cache/generation-tests/one-create-process'), directory);
if (!contained || contained.startsWith('..') || isAbsolute(contained)) throw Error('INVALID_CHILD_DIRECTORY');
globalThis.fetch = async () => { throw Error('NETWORK_FORBIDDEN_IN_PROCESS_TEST'); };
const markerPath = join(directory, 'create-consumed.json');
const identity = {
  experimentId: 'B21C-2026-09-13', itemId: 'item-test', attemptId: 'attempt-test',
  sourceSha: '0'.repeat(40), authorizedAt: '2026-09-13T00:00:00Z',
};

// Patch only the fault boundary, preserving actual exclusive open/write/sync operations.
const open = fs.open.bind(fs);
fs.open = async (...args) => {
  const handle = await open(...args);
  if (args[0] === markerPath && ['before-write', 'after-write'].includes(stage)) {
    const writeFile = handle.writeFile.bind(handle);
    handle.writeFile = async (...writeArgs) => {
      if (stage === 'before-write') process.exit(81);
      await writeFile(...writeArgs);
      process.exit(82);
    };
  }
  return handle;
};
const { consumeCreateBudget } = await import('../../src/provider/one-create-guard.ts');
await new Promise(resolve => {
  process.once('message', message => { if (message === 'go') resolve(); });
  process.send({ ready: true });
});
try {
  await consumeCreateBudget(markerPath, identity);
  if (stage === 'before-dispatch') process.exit(83);
  // Synthetic transport invocation evidence is separate from the consumed intent marker.
  const log = await open(join(directory, 'observed-invocations.jsonl'), 'a', 0o600);
  await log.writeFile(JSON.stringify({ pid: process.pid, kind: 'simulated-create' }) + '\n');
  await log.sync();
  await log.close();
  if (stage === 'after-dispatch') process.exit(84);
  process.send({ outcome: 'permitted', pid: process.pid });
} catch (error) {
  process.send({ outcome: error.message, pid: process.pid });
}
process.disconnect();
