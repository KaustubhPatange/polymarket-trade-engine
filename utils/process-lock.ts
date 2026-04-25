import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const LOCK_DIR = process.env.LOCK_DIR ?? "state";

function lockPath(name: string): string {
  return join(LOCK_DIR, `${name}.lock`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquires a named process lock backed by a PID file in the state/ directory.
 * If another process with the same name is already running, logs an error and exits.
 * The lock is automatically released when the process exits.
 */
export function acquireProcessLock(name: string): void {
  const path = lockPath(name);

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (!isNaN(pid) && isProcessRunning(pid)) {
      console.error(
        `[process-lock] Another "${name}" process is already running (PID ${pid}). Exiting.`,
      );
      process.exit(1);
    }
    // Stale lock — previous process died without cleanup
    unlinkSync(path);
  }

  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(path, String(process.pid), "utf8");

  process.on("exit", () => {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  });
}
