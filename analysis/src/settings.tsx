import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Tz = "local" | "ET" | "UTC";

export const ASSETS = ["BTC", "ETH", "XRP", "SOL", "DOGE"] as const;
export type Asset = (typeof ASSETS)[number];

export const DURATIONS = ["5m", "15m"] as const;
export type Duration = (typeof DURATIONS)[number];

export type DataSource =
  | { kind: "default" }
  | { kind: "custom"; name: string; files: File[] };

const STORAGE_TZ = "analysis.tz";
const STORAGE_ASSET = "analysis.asset";
const STORAGE_DURATION = "analysis.duration";

type Settings = {
  tz: Tz;
  asset: Asset;
  duration: Duration;
  strategy: string;
  dataSource: DataSource;
  setTz: (tz: Tz) => void;
  setAsset: (a: Asset) => void;
  setDuration: (d: Duration) => void;
  setStrategy: (s: string) => void;
  setDataSource: (s: DataSource) => void;
};

const SettingsContext = createContext<Settings | null>(null);

function loadEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {}
  return fallback;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [tz, setTzState] = useState<Tz>(() =>
    loadEnum(STORAGE_TZ, ["local", "ET", "UTC"] as const, "local"),
  );
  const [asset, setAssetState] = useState<Asset>(() =>
    loadEnum(STORAGE_ASSET, ASSETS, "BTC"),
  );
  const [duration, setDurationState] = useState<Duration>(() =>
    loadEnum(STORAGE_DURATION, DURATIONS, "5m"),
  );
  // Data source isn't persisted — FileSystemDirectoryHandle requires a fresh
  // user gesture each session for permissions anyway.
  const [strategy, setStrategyState] = useState<string>("All");
  const [dataSource, setDataSourceState] = useState<DataSource>({ kind: "default" });

  useEffect(() => { try { localStorage.setItem(STORAGE_TZ, tz); } catch {} }, [tz]);
  useEffect(() => { try { localStorage.setItem(STORAGE_ASSET, asset); } catch {} }, [asset]);
  useEffect(() => { try { localStorage.setItem(STORAGE_DURATION, duration); } catch {} }, [duration]);

  return (
    <SettingsContext.Provider
      value={{
        tz,
        asset,
        duration,
        strategy,
        dataSource,
        setTz: setTzState,
        setAsset: setAssetState,
        setDuration: setDurationState,
        setStrategy: setStrategyState,
        setDataSource: setDataSourceState,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): Settings {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

// ── Tz-aware formatting helpers ─────────────────────────────────────────────

const TZ_NAME: Record<Tz, string | undefined> = {
  local: undefined, // browser local
  ET: "America/New_York",
  UTC: "UTC",
};

const TZ_LABEL: Record<Tz, string> = {
  local: "Local",
  ET: "ET",
  UTC: "UTC",
};

export function tzLabel(tz: Tz): string {
  return TZ_LABEL[tz];
}

// Pull year/month/day/hour values for a timestamp in the target tz.
export function getZonedParts(
  ms: number,
  tz: Tz,
): { y: number; mo: number; d: number; h: number } {
  if (tz === "UTC") {
    const d = new Date(ms);
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth(),
      d: d.getUTCDate(),
      h: d.getUTCHours(),
    };
  }
  if (tz === "local") {
    const d = new Date(ms);
    return {
      y: d.getFullYear(),
      mo: d.getMonth(),
      d: d.getDate(),
      h: d.getHours(),
    };
  }
  // ET (or any future Intl-based tz) — reuse a cached formatter; constructing
  // Intl.DateTimeFormat is expensive and bin-filling calls this thousands of times.
  const parts = partsFmt(tz).formatToParts(ms);
  let y = 0,
    mo = 0,
    d = 0,
    h = 0;
  for (const p of parts) {
    if (p.type === "year") y = +p.value;
    else if (p.type === "month") mo = +p.value - 1;
    else if (p.type === "day") d = +p.value;
    else if (p.type === "hour") h = +p.value % 24;
  }
  return { y, mo, d, h };
}

// Cache `Intl.DateTimeFormat` instances per tz.
const partsFmtCache = new Map<Tz, Intl.DateTimeFormat>();
function partsFmt(tz: Tz): Intl.DateTimeFormat {
  let f = partsFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ_NAME[tz],
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    partsFmtCache.set(tz, f);
  }
  return f;
}

export function formatDateTime(ms: number, tz: Tz): string {
  return (
    new Date(ms).toLocaleString("en-US", {
      timeZone: TZ_NAME[tz],
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }) + (tz !== "local" ? ` ${TZ_LABEL[tz]}` : "")
  );
}
