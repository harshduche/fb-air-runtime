// Version history drawer — lists all prior versions of a workflow with
// a one-click restore. Backend storage is `<sha>/v<N>.json` + meta.json;
// restoring copies the chosen v<N> forward as a new current_version.

import { useCallback, useEffect, useState } from "react";
import { downloadBundle, listVersions, restoreVersion } from "./api";

type VersionRow = {
  version: number;
  createTime: number;
  updateTime: number;
  is_current: boolean;
};

function formatAgo(unixSec: number): string {
  const delta = Math.max(0, Date.now() / 1000 - unixSec);
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function VersionHistory({
  workflowId,
  onClose,
  onRestored,
  refreshToken,
}: {
  workflowId: string;
  onClose: () => void;
  /** Called after restore succeeds. Builder reloads the spec. */
  onRestored: (newVersion: number) => void;
  /** Bump to force a refresh (e.g. after publish). */
  refreshToken: number;
}) {
  const [rows, setRows] = useState<VersionRow[]>([]);
  const [current, setCurrent] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const d = await listVersions(workflowId);
      setRows(d.versions);
      setCurrent(d.current_version);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshToken]);

  const onRestore = useCallback(
    async (v: number) => {
      if (!window.confirm(`Restore v${v} as the current version?`)) return;
      try {
        const { version } = await restoreVersion(workflowId, v);
        await refresh();
        onRestored(version);
      } catch (e: any) {
        alert(`Restore failed: ${e?.message || e}`);
      }
    },
    [workflowId, refresh, onRestored],
  );

  const onDownload = useCallback(
    async (v: number) => {
      try {
        await downloadBundle(workflowId, v);
      } catch (e: any) {
        alert(`Download failed: ${e?.message || e}`);
      }
    },
    [workflowId],
  );

  return (
    <div className="version-drawer">
      <div className="header">
        <span>Version history</span>
        <button className="icon-btn" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="body">
        {loading && <div className="empty">Loading…</div>}
        {err && <div className="empty err">Failed: {err}</div>}
        {!loading && !err && rows.length === 0 && (
          <div className="empty">
            No prior versions. Publish to snapshot the current spec.
          </div>
        )}
        {rows.map((r) => (
          <div
            key={r.version}
            className={`version-row ${r.is_current ? "current" : ""}`}
          >
            <div className="ver">v{r.version}</div>
            <div className="meta">
              <div className="when">edited {formatAgo(r.updateTime)}</div>
              {r.is_current && <div className="pill">current</div>}
            </div>
            <div className="actions">
              <button
                className="icon-btn"
                onClick={() => onDownload(r.version)}
                title={`Download v${r.version} as a .flyttmpl bundle`}
                aria-label={`Download v${r.version}`}
              >
                ⬇
              </button>
              {!r.is_current && (
                <button
                  className="btn"
                  onClick={() => onRestore(r.version)}
                  title={`Restore v${r.version} as v${(current || 0) + 1}`}
                >
                  Restore
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
