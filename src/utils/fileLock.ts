import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";

/** Cross-process lock. A paused owner must never have its lock stolen. */
export async function withFileLock<T>(lockPath: string, work: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can briefly return EPERM while another owner removes the lock
      // directory. Retry acquisition, never remove or steal the owner's lock.
      if (code !== "EEXIST" && !(process.platform === "win32" && code === "EPERM")) throw error;
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Store is locked: ${lockPath}. After a crash, verify the owner has stopped before removing this lock directory.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await work();
  } finally {
    await rmdir(lockPath);
  }
}
