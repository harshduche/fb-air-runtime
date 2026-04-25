// Workflow list view for /flybuild. Shows every workflow saved under
// $MODEL_CACHE_DIR/workflow/flyt/ as a card with a schematic graph
// preview, and lets the user create / open / rename / duplicate / delete
// without ever typing an ID into a prompt.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteWorkflow,
  importBundle,
  listTemplates,
  listWorkflows,
  loadWorkflow,
  saveWorkflow,
  Template,
} from "./api";
import flytbaseLogo from "./assets/flytbase-logo.svg";

type Row = {
  id: string;
  createSeconds: number;
  updateSeconds: number;
  spec: any;
  version: number;
};

type Props = {
  onOpen: (id: string) => void;
};

function formatAgo(seconds: number): string {
  const nowSec = Date.now() / 1000;
  const delta = Math.max(0, nowSec - seconds);
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

// Render a small schematic of the workflow: one blob per
// input → one per step (stacked in order) → one per output. No layout
// engine, no React Flow — just CSS boxes. Keeps the dashboard cheap to
// render when the user has dozens of workflows.
function MiniGraph({ spec }: { spec: any }) {
  const inputs: any[] = Array.isArray(spec?.inputs) ? spec.inputs : [];
  const steps: any[] = Array.isArray(spec?.steps) ? spec.steps : [];
  const outputs: any[] = Array.isArray(spec?.outputs) ? spec.outputs : [];

  if (!inputs.length && !steps.length && !outputs.length) {
    return <div className="mini-graph empty">empty</div>;
  }

  return (
    <div className="mini-graph">
      <div className="mini-col">
        {inputs.slice(0, 4).map((inp, i) => (
          <div key={`i-${i}`} className="mini-box input" title={inp?.name}>
            {inp?.type === "WorkflowImage" ? "▶ image" : "▶ param"}
          </div>
        ))}
        {inputs.length > 4 && <div className="mini-more">+{inputs.length - 4}</div>}
      </div>
      <div className="mini-col">
        {steps.slice(0, 4).map((s, i) => (
          <div key={`s-${i}`} className="mini-box step" title={s?.type}>
            {(s?.type || "").split("/").pop()?.replace(/@.*$/, "") || "step"}
          </div>
        ))}
        {steps.length > 4 && <div className="mini-more">+{steps.length - 4}</div>}
      </div>
      <div className="mini-col">
        {outputs.slice(0, 4).map((o, i) => (
          <div key={`o-${i}`} className="mini-box output" title={o?.name}>
            ◀ {o?.name || "out"}
          </div>
        ))}
        {outputs.length > 4 && <div className="mini-more">+{outputs.length - 4}</div>}
      </div>
    </div>
  );
}

function suggestNewId(existing: Set<string>): string {
  let i = 1;
  while (existing.has(`custom-workflow-${i}`)) i += 1;
  return `custom-workflow-${i}`;
}

export function Dashboard({ onOpen }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listWorkflows();
      const next: Row[] = Object.entries(data).map(([id, meta]: [string, any]) => ({
        id,
        createSeconds: meta?.createTime?._seconds ?? 0,
        updateSeconds: meta?.updateTime?._seconds ?? 0,
        spec: meta?.config?.specification ?? meta?.config ?? {},
        version: Number(meta?.version ?? 1),
      }));
      next.sort((a, b) => b.updateSeconds - a.updateSeconds);
      setRows(next);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const existingIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    return rows.filter((r) => r.id.toLowerCase().includes(needle));
  }, [q, rows]);

  const onCreate = useCallback(() => {
    const suggested = suggestNewId(existingIds);
    const id = window.prompt("Workflow ID (a-z, 0-9, -, _):", suggested);
    if (!id) return;
    if (!/^[\w\-]+$/.test(id)) {
      alert("Invalid ID. Use letters, digits, dash, underscore only.");
      return;
    }
    onOpen(id);
  }, [existingIds, onOpen]);

  // Hidden <input type=file> we trigger from the Import button — the
  // standard click-the-button-then-pick-a-file pattern. After upload
  // we navigate the new workflow into the builder.
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const onImportClick = useCallback(() => {
    importInputRef.current?.click();
  }, []);
  const onImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      setImporting(true);
      try {
        const r = await importBundle(f);
        await refresh();
        const note = r.fixtures_count > 0
          ? ` (+${r.fixtures_count} fixture${r.fixtures_count === 1 ? "" : "s"})`
          : "";
        // Small delay so the user sees the import succeeded before
        // we redirect to the builder.
        setTimeout(() => onOpen(r.id), 50);
        // The toast survives the navigation only briefly — for a
        // notice the user can read, prefer alert.
        if (r.id !== (r.source.provenance?.workflow_id || r.id)) {
          alert(
            `Imported as '${r.id}'${note} (renamed because the original id was taken).`,
          );
        }
      } catch (err: any) {
        alert(`Import failed: ${err?.message || err}`);
      } finally {
        setImporting(false);
      }
    },
    [refresh, onOpen],
  );

  const onDelete = useCallback(
    async (id: string) => {
      if (!window.confirm(`Delete workflow '${id}'? This cannot be undone.`)) return;
      try {
        await deleteWorkflow(id);
        await refresh();
      } catch (e: any) {
        alert(`Delete failed: ${e?.message || e}`);
      }
    },
    [refresh],
  );

  const onDuplicate = useCallback(
    async (row: Row) => {
      const base = `${row.id}-copy`;
      let candidate = base;
      let i = 2;
      while (existingIds.has(candidate)) {
        candidate = `${base}-${i}`;
        i += 1;
      }
      const newId = window.prompt("New workflow ID:", candidate);
      if (!newId) return;
      if (!/^[\w\-]+$/.test(newId)) {
        alert("Invalid ID.");
        return;
      }
      try {
        // Full clone: load fresh to avoid relying on list-cached spec
        // shape, then save under the new id.
        const spec = await loadWorkflow(row.id);
        await saveWorkflow(newId, spec);
        await refresh();
      } catch (e: any) {
        alert(`Duplicate failed: ${e?.message || e}`);
      }
    },
    [existingIds, refresh],
  );

  const onUseTemplate = useCallback(
    async (tpl: Template) => {
      const base = tpl.id.replace(/^\d+_/, "");
      let candidate = base;
      let i = 2;
      while (existingIds.has(candidate)) {
        candidate = `${base}-${i}`;
        i += 1;
      }
      const newId = window.prompt(
        `New workflow from "${tpl.name}". Pick an ID:`,
        candidate,
      );
      if (!newId) return;
      if (!/^[\w\-]+$/.test(newId)) {
        alert("Invalid ID.");
        return;
      }
      try {
        await saveWorkflow(newId, tpl.specification);
        onOpen(newId);
      } catch (e: any) {
        alert(`Template create failed: ${e?.message || e}`);
      }
    },
    [existingIds, onOpen],
  );

  const onRename = useCallback(
    async (row: Row) => {
      const newId = window.prompt("New workflow ID:", row.id);
      if (!newId || newId === row.id) return;
      if (!/^[\w\-]+$/.test(newId)) {
        alert("Invalid ID.");
        return;
      }
      if (existingIds.has(newId)) {
        alert(`'${newId}' already exists.`);
        return;
      }
      try {
        // The backend treats a save where body.id === path id, combined
        // with an explicit `old_id` field on the payload, as a rename —
        // but our current saveWorkflow doesn't expose that, so do it in
        // two steps.
        const spec = await loadWorkflow(row.id);
        await saveWorkflow(newId, spec);
        await deleteWorkflow(row.id);
        await refresh();
      } catch (e: any) {
        alert(`Rename failed: ${e?.message || e}`);
      }
    },
    [existingIds, refresh],
  );

  return (
    <div className="dashboard">
      <div className="dashboard-topbar">
        <img src={flytbaseLogo} alt="FlytBase" className="brand-logo" />
        <span className="brand-subtitle">Flow Builder</span>
        <span className="sep">·</span>
        <span className="route-label">Workflows</span>
        <div className="spacer" />
        <input
          className="search"
          placeholder="Search workflows…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn primary" onClick={onCreate}>
          + Create Workflow
        </button>
        <button
          className="btn"
          onClick={onImportClick}
          disabled={importing}
          title="Load a .flyttmpl.tar.gz bundle as a new workflow"
        >
          {importing ? "Importing…" : "↑ Import .flyttmpl"}
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept=".flyttmpl,.tar.gz,.gz,application/gzip,application/x-gzip,application/x-tar"
          style={{ display: "none" }}
          onChange={onImportFile}
        />
        <a
          href="/build"
          className="compare"
          title="Open the upstream Roboflow iframe builder"
        >
          Compare with /build ↗
        </a>
      </div>

      <div className="dashboard-body">
        {templates.length > 0 && (
          <div className="templates-section">
            <div className="section-title">Explore Templates</div>
            <div className="template-grid">
              {templates.map((t) => (
                <button
                  key={t.id}
                  className="template-card"
                  onClick={() => onUseTemplate(t)}
                  title={t.description}
                >
                  <div className="tpl-name">{t.name}</div>
                  <div className="tpl-desc">{t.description}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {loading && <div className="dashboard-empty">Loading…</div>}
        {err && <div className="dashboard-empty err">Load failed: {err}</div>}
        {!loading && !err && filtered.length === 0 && (
          <div className="dashboard-empty">
            {rows.length === 0 ? (
              <>
                <div className="title">No workflows yet</div>
                <div className="hint">
                  Create your first workflow to get started. They'll be stored
                  locally under{" "}
                  <code>$MODEL_CACHE_DIR/workflow/flyt/</code>.
                </div>
                <button className="btn primary" onClick={onCreate}>
                  + Create Workflow
                </button>
              </>
            ) : (
              <div className="title">No matches for "{q}"</div>
            )}
          </div>
        )}

        <div className="workflow-grid">
          {filtered.map((row) => {
            const nodeCount =
              (row.spec?.inputs?.length ?? 0) +
              (row.spec?.steps?.length ?? 0) +
              (row.spec?.outputs?.length ?? 0);
            return (
              <div
                className="workflow-card"
                key={row.id}
                onClick={() => onOpen(row.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpen(row.id);
                }}
              >
                <div className="workflow-card-preview">
                  <MiniGraph spec={row.spec} />
                </div>
                <div className="workflow-card-meta">
                  <div className="workflow-card-title" title={row.id}>
                    {row.id}
                    <span className="version-chip">v{row.version}</span>
                  </div>
                  <div className="workflow-card-sub">
                    {nodeCount} node{nodeCount === 1 ? "" : "s"} · edited{" "}
                    {formatAgo(row.updateSeconds)}
                  </div>
                </div>
                <div className="workflow-card-actions">
                  <button
                    className="icon-btn"
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename(row);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="icon-btn"
                    title="Duplicate"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicate(row);
                    }}
                  >
                    ⧉
                  </button>
                  <button
                    className="icon-btn danger"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(row.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
