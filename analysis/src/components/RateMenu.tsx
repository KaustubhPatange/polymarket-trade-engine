import { useEffect, useRef, useState } from "react";
import type { Rate } from "../types";

type Props = {
  rate: Rate;
  onRateChange: (rate: Rate) => void;
  onFullscreen: () => void;
};

export function RateMenu({ rate, onRateChange, onFullscreen }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="ratemenu" ref={ref}>
      <button
        type="button"
        className="ratemenu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="Options"
      >
        •••
      </button>
      {open && (
        <div className="ratemenu-popup">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onFullscreen();
            }}
          >
            View full screen
          </button>
          <button
            type="button"
            className={rate === "day" ? "active" : ""}
            onClick={() => {
              setOpen(false);
              onRateChange("day");
            }}
          >
            Rate: per day
          </button>
          <button
            type="button"
            className={rate === "hour" ? "active" : ""}
            onClick={() => {
              setOpen(false);
              onRateChange("hour");
            }}
          >
            Rate: per hour
          </button>
        </div>
      )}
    </div>
  );
}
