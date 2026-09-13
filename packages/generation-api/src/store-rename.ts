import { rename } from 'node:fs/promises';
const waits = [20, 40, 80, 160] as const;
/** Retry only the same already-flushed snapshot rename; reducers and network are outside this helper. */
export async function renameSnapshot(source: string, destination: string, options: {
  platform?: NodeJS.Platform;
  rename?: (source: string, destination: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
} = {}): Promise<void> {
  const move = options.rename ?? rename;
  const platform = options.platform ?? process.platform;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 0;; attempt++) {
    try { await move(source, destination); return; }
    catch (error) {
      const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      if (platform !== 'win32' || !['EPERM','EBUSY'].includes(code) || attempt === waits.length) throw error;
    }
    await sleep(waits[attempt]!);
  }
}
