import type { ReactNode } from "react";
import { formatDateTime, useSettings } from "../settings";

export type Stat = {
  label: string;
  value: ReactNode;
  badgeClass?: string;
};

type Props = {
  title?: string;
  stats: Stat[];
  fromMs?: number;
  toMs?: number;
  footer?: ReactNode;
};

export function InfoPanel({ title, stats, fromMs, toMs, footer }: Props) {
  const { tz } = useSettings();
  const fmtDate = (ms: number) => formatDateTime(ms, tz);
  return (
    <div className="info-panel">
      {title && <div className="info-title">{title}</div>}
      <div className="info-stats">
        {stats.map((s, i) => (
          <div className="info-row" key={i}>
            <span className="info-label">{s.label}</span>
            <span className={"info-value " + (s.badgeClass ?? "")}>{s.value}</span>
          </div>
        ))}
      </div>
      {(fromMs != null || toMs != null) && (
        <div className="info-dates">
          {fromMs != null && (
            <div className="info-row">
              <span className="info-label">from</span>
              <span className="info-value">{fmtDate(fromMs)}</span>
            </div>
          )}
          {toMs != null && (
            <div className="info-row">
              <span className="info-label">to</span>
              <span className="info-value">{fmtDate(toMs)}</span>
            </div>
          )}
        </div>
      )}
      {footer && <div className="info-footer">{footer}</div>}
    </div>
  );
}
