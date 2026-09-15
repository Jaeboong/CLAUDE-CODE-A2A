// Short, synchronous filesystem transactions shared by CLI/hook/watcher processes.
// A crashed writer leaves the lock in place: fail closed instead of guessing that
// a slow writer is dead and allowing two consumers to claim the same request.
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

export function withFileLock<T>(root: string, name: string, operation: () => T): T {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  const deadline = Date.now() + 3000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring ${path}; check for a crashed a2ab writer before removing this lock.`);
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    rmdirSync(path);
  }
}
