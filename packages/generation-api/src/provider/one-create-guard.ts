import fs from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Consumes intent, not proof that a Provider POST was dispatched.
 * The caller must first validate authorization, the fixed request and its private
 * experiment directory, including refusal to initialize over prior state/locks.
 * Every existing marker (including empty/corrupt files) permanently exhausts this
 * budget. Never delete/reset it after persistence, dispatch or response failure.
 */
export async function consumeCreateBudget(markerPath: string, identity: {
  experimentId: string;
  itemId: string;
  attemptId: string;
  sourceSha: string;
  authorizedAt: string;
}): Promise<void> {
  const handle = await fs.open(markerPath, 'wx', 0o600).catch(() => {
    throw Error('CREATE_BUDGET_EXHAUSTED');
  });
  try {
    try {
      const { experimentId, itemId, attemptId, sourceSha, authorizedAt } = identity;
      await handle.writeFile(JSON.stringify({
        version: 1, createBudgetConsumed: 1,
        experimentId, itemId, attemptId, sourceSha, authorizedAt,
      }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // POSIX fsync of the directory persists the newly created directory entry.
    // Windows Node cannot portably fsync directories: the file is flushed, but
    // power-loss durability of the directory entry is not guaranteed there.
    if (process.platform !== 'win32') {
      const directory = await fs.open(dirname(markerPath), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch {
    // Do not expose filesystem paths or remove a possibly consumed marker.
    throw Error('CREATE_BUDGET_PERSIST_FAILED');
  }
}
