import { useEffect, useRef, useState } from "react";
import { useSettings, type Tz } from "../settings";

const TZ_OPTIONS: { value: Tz; label: string; sub: string }[] = [
  { value: "local", label: "Local", sub: "Browser timezone" },
  { value: "ET", label: "ET", sub: "America/New_York" },
  { value: "UTC", label: "UTC", sub: "Coordinated Universal Time" },
];

export function SettingsButton() {
  const { tz, setTz, dataSource, setDataSource } = useSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const onFolderPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    // Folder name comes from the relative path of any picked file:
    //   webkitRelativePath = "<folderName>/path/to/file.log"
    const first = files[0] as any;
    const rel = first?.webkitRelativePath as string | undefined;
    const name = rel ? rel.split("/")[0] || "selected" : "selected";
    setDataSource({ kind: "custom", name, files });
    setOpen(false);
    // Reset value so picking the same folder twice still triggers onChange.
    e.target.value = "";
  };

  return (
    <div className="settings" ref={ref}>
      <button
        type="button"
        className="settings-trigger"
        title="Settings"
        onClick={() => setOpen((v) => !v)}
      >
        ⚙
      </button>
      {open && (
        <div className="settings-popup">
          <div className="settings-section-title">TIMEZONE</div>
          {TZ_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={"settings-row" + (tz === opt.value ? " active" : "")}
              onClick={() => {
                setTz(opt.value);
                setOpen(false);
              }}
            >
              <div className="settings-row-main">{opt.label}</div>
              <div className="settings-row-sub">{opt.sub}</div>
            </button>
          ))}

          <div className="settings-section-title settings-section-title-spaced">
            DATA SOURCE
          </div>
          <button
            type="button"
            className={
              "settings-row" + (dataSource.kind === "default" ? " active" : "")
            }
            onClick={() => {
              setDataSource({ kind: "default" });
              setOpen(false);
            }}
          >
            <div className="settings-row-main">Default</div>
            <div className="settings-row-sub">Bundled logs/ directory</div>
          </button>
          <button
            type="button"
            className={
              "settings-row" + (dataSource.kind === "custom" ? " active" : "")
            }
            onClick={() => inputRef.current?.click()}
          >
            <div className="settings-row-main">
              {dataSource.kind === "custom"
                ? `Custom: ${dataSource.name}/`
                : "Custom directory…"}
            </div>
            <div className="settings-row-sub">
              {dataSource.kind === "custom"
                ? "Click to choose a different folder"
                : "Pick a folder of slug log files"}
            </div>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={onFolderPicked}
            // webkitdirectory + directory let Chrome/Edge/Safari and Firefox
            // expose the OS folder picker. Spread via {...} to bypass React's
            // typed-attribute checks for these non-standard names.
            {...({ webkitdirectory: "", directory: "" } as any)}
          />
        </div>
      )}
    </div>
  );
}
