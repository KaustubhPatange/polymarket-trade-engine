import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const MODULE_PATH = resolve(import.meta.dir, "../../utils/process-lock.ts");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lock-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function runScript(
  script: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "-e", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("acquireProcessLock", () => {
  test("creates lock file with current PID", async () => {
    const script = `
      const { acquireProcessLock } = await import("${MODULE_PATH}");
      acquireProcessLock("test1");
      const { readFileSync } = await import("fs");
      const { join } = await import("path");
      const content = readFileSync(join(process.env.LOCK_DIR, "test1.lock"), "utf8");
      console.log(process.pid + ":" + content.trim());
    `;
    const { exitCode, stdout } = await runScript(script, { LOCK_DIR: tmpDir });
    expect(exitCode).toBe(0);
    const [pid, filePid] = stdout.trim().split(":");
    expect(pid).toBe(filePid);
  });

  test("cleans up lock file on process exit", async () => {
    const script = `
      const { acquireProcessLock } = await import("${MODULE_PATH}");
      acquireProcessLock("test2");
    `;
    const { exitCode } = await runScript(script, { LOCK_DIR: tmpDir });
    expect(exitCode).toBe(0);
    expect(existsSync(join(tmpDir, "test2.lock"))).toBe(false);
  });

  test("removes stale lock from dead process", async () => {
    // Write a lock file with a non-existent PID
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "test3.lock"), "999999", "utf8");

    const script = `
      const { acquireProcessLock } = await import("${MODULE_PATH}");
      acquireProcessLock("test3");
      const { readFileSync } = await import("fs");
      const { join } = await import("path");
      const content = readFileSync(join(process.env.LOCK_DIR, "test3.lock"), "utf8");
      console.log(content.trim());
    `;
    const { exitCode, stdout } = await runScript(script, { LOCK_DIR: tmpDir });
    expect(exitCode).toBe(0);
    // The lock file should now have the subprocess PID (not 999999)
    const pid = stdout.trim();
    expect(pid).not.toBe("999999");
    expect(parseInt(pid, 10)).toBeGreaterThan(0);
  });

  test("exits when another process holds lock", async () => {
    // Start subprocess A that acquires lock and sleeps
    const scriptA = `
      const { acquireProcessLock } = await import("${MODULE_PATH}");
      acquireProcessLock("test4");
      await Bun.sleep(5000);
    `;
    const procA = Bun.spawn(["bun", "-e", scriptA], {
      env: { ...process.env, LOCK_DIR: tmpDir },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for A to create the lock file
    const lockFile = join(tmpDir, "test4.lock");
    const start = Date.now();
    while (!existsSync(lockFile) && Date.now() - start < 3000) {
      await Bun.sleep(50);
    }
    expect(existsSync(lockFile)).toBe(true);

    // Start subprocess B that tries to acquire the same lock
    const scriptB = `
      const { acquireProcessLock } = await import("${MODULE_PATH}");
      acquireProcessLock("test4");
    `;
    const { exitCode } = await runScript(scriptB, { LOCK_DIR: tmpDir });
    expect(exitCode).toBe(1);

    // Clean up process A
    procA.kill();
    await procA.exited;
  });

  test("stderr contains running PID when lock is held", async () => {
    // Start subprocess A that acquires lock and sleeps
    const scriptA = `
      const { acquireProcessLock } = await import("${MODULE_PATH}");
      acquireProcessLock("test5");
      console.log(process.pid);
      await Bun.sleep(5000);
    `;
    const procA = Bun.spawn(["bun", "-e", scriptA], {
      env: { ...process.env, LOCK_DIR: tmpDir },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for A to create the lock file and get its PID
    const lockFile = join(tmpDir, "test5.lock");
    const start = Date.now();
    while (!existsSync(lockFile) && Date.now() - start < 3000) {
      await Bun.sleep(50);
    }
    const pidA = readFileSync(lockFile, "utf8").trim();

    // Start subprocess B
    const scriptB = `
      const { acquireProcessLock } = await import("${MODULE_PATH}");
      acquireProcessLock("test5");
    `;
    const { exitCode, stderr } = await runScript(scriptB, { LOCK_DIR: tmpDir });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`PID ${pidA}`);
    expect(stderr).toContain(`[process-lock]`);

    procA.kill();
    await procA.exited;
  });

  test("lock file with non-numeric content is treated as stale", async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "test6.lock"), "garbage", "utf8");

    const script = `
      const { acquireProcessLock } = await import("${MODULE_PATH}");
      acquireProcessLock("test6");
      console.log("acquired");
    `;
    const { exitCode, stdout } = await runScript(script, { LOCK_DIR: tmpDir });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("acquired");
  });
});
