/// <reference types="vite/client" />
import { useEffect, useMemo, useState } from "react";
import { parseLog } from "../parse";
import { useSettings } from "../settings";
import type { ParsedRun } from "../types";

// Default source: every .log shipped under repo `logs/` (loaded eagerly at
// dev/build time via Vite's glob).
const rawLogs = import.meta.glob("../../../logs/*.log", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function parseDefault(): ParsedRun[] {
  const runs: ParsedRun[] = [];
  for (const [path, content] of Object.entries(rawLogs)) {
    const filename = path.split("/").pop() ?? path;
    const parsed = parseLog(filename, content);
    if (parsed) runs.push(parsed);
  }
  runs.sort((a, b) => a.startTime - b.startTime);
  return runs;
}

// Read every .log file in the user-picked folder and parse them.
// Subdirectories are skipped (matching the default source which only globs
// `logs/*.log`). The browser's `<input webkitdirectory>` exposes nested files
// via `webkitRelativePath` like "logs/sub/x.log" — we keep only the top-level.
async function readCustom(files: File[]): Promise<ParsedRun[]> {
  const runs: ParsedRun[] = [];
  for (const file of files) {
    if (!file.name.endsWith(".log")) continue;
    const rel = (file as any).webkitRelativePath as string | undefined;
    // Skip files inside subfolders (relative path has more than one separator).
    if (rel && rel.split("/").length > 2) continue;
    try {
      const text = await file.text();
      const parsed = parseLog(file.name, text);
      if (parsed) runs.push(parsed);
    } catch {
      // Skip unreadable files silently.
    }
  }
  runs.sort((a, b) => a.startTime - b.startTime);
  return runs;
}

export function useLogs(): ParsedRun[] {
  const { dataSource } = useSettings();

  const defaultRuns = useMemo(() => parseDefault(), []);
  const [customRuns, setCustomRuns] = useState<ParsedRun[]>([]);

  useEffect(() => {
    if (dataSource.kind !== "custom") {
      setCustomRuns([]);
      return;
    }
    let cancelled = false;
    readCustom(dataSource.files).then((runs) => {
      if (!cancelled) setCustomRuns(runs);
    });
    return () => { cancelled = true; };
  }, [dataSource]);

  return dataSource.kind === "custom" ? customRuns : defaultRuns;
}
