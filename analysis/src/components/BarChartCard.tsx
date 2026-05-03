import { useEffect, useState, type ReactNode } from "react";
import { RateMenu } from "./RateMenu";
import type { Rate } from "../types";

type Props = {
  title: ReactNode;
  toolbarLeft?: ReactNode;
  rate: Rate;
  onRateChange: (rate: Rate) => void;
  chart: ReactNode;
  side: ReactNode;
};

export function BarChartCard({
  title,
  toolbarLeft,
  rate,
  onRateChange,
  chart,
  side,
}: Props) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  return (
    <div className={"card" + (fullscreen ? " card-fullscreen" : "")}>
      <div className="card-header">
        <div className="card-toolbar-left">
          {title}
          {toolbarLeft}
        </div>
        <div className="card-toolbar-right">
          {fullscreen && (
            <button
              type="button"
              className="card-close"
              onClick={() => setFullscreen(false)}
            >
              Close ✕
            </button>
          )}
          <RateMenu
            rate={rate}
            onRateChange={onRateChange}
            onFullscreen={() => setFullscreen(true)}
          />
        </div>
      </div>
      <div className="card-body">
        <div className="card-chart">{chart}</div>
        <div className="card-side">{side}</div>
      </div>
    </div>
  );
}
