// Left-rail palette. Groups every block by category; each section is
// collapsible with per-category state persisted to localStorage. A
// pinned "Popular" pseudo-section at the top surfaces the blocks marked
// `ui_manifest.popular` so new users get a short, digestible starting
// list without scrolling past every category.

import { useEffect, useMemo, useState } from "react";
import { BlockDef } from "./api";
import {
  categoryFor,
  pseudoBlockDefs,
  uiManifestFor,
  isPseudoBlock,
} from "./compile";
import { BlockIcon, CategoryIcon } from "./icons";

type Props = {
  blocks: BlockDef[];
  onDragStart: (event: React.DragEvent, block: BlockDef) => void;
};

const LS_KEY = "flyt.palette.collapsed";

// Which sections default to expanded when the user has no saved state.
// Keeps the rail compact on first load but still visible for the most
// common starting moves.
const DEFAULT_EXPANDED = new Set(["Inputs / Outputs", "Popular"]);

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsed(s: Set<string>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...s]));
  } catch {
    /* quota / private-mode — non-fatal */
  }
}

const CATEGORY_ORDER = [
  "Inputs / Outputs",
  "Model",
  "Models",
  "Models (Roboflow)",
  "Foundation Models",
  "Visualization",
  "Transformations",
  "Analytics",
  "Logic",
  "Logic and Branching",
  "Sinks",
  "Data Storage",
  "Notification",
  "Video",
  "Classical Computer Vision",
  "Advanced",
  "Industrial Integration",
  "Other",
];

export function Palette({ blocks, onDragStart }: Props) {
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());

  useEffect(() => {
    saveCollapsed(collapsed);
  }, [collapsed]);

  const toggle = (cat: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const isOpen = (cat: string) => {
    // Search overrides the collapse state — the user wants to see hits.
    if (q.trim()) return true;
    if (collapsed.has(cat)) return false;
    // If the user has never touched this section, honour the default.
    return DEFAULT_EXPANDED.has(cat) || !collapsed.has(cat);
  };

  const allBlocks = useMemo(() => [...pseudoBlockDefs(), ...blocks], [blocks]);

  // Featured = blocks marked popular in `ui_manifest.popular`. Pinned at
  // the top under a synthetic "Popular" heading.
  const popular = useMemo(() => {
    return allBlocks
      .filter((b) => {
        if (isPseudoBlock(b.manifest_type_identifier)) return false;
        const ui = uiManifestFor(b);
        return !!ui.popular;
      })
      .sort((a, b) => {
        const pa =
          typeof uiManifestFor(a).blockPriority === "number"
            ? uiManifestFor(a).blockPriority
            : 100;
        const pb =
          typeof uiManifestFor(b).blockPriority === "number"
            ? uiManifestFor(b).blockPriority
            : 100;
        return pa - pb;
      })
      .slice(0, 8);
  }, [allBlocks]);

  // Normal categories (pseudo blocks grouped under "Inputs / Outputs").
  const grouped = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const map: Record<string, BlockDef[]> = {};
    for (const b of allBlocks) {
      if (needle) {
        const ui = uiManifestFor(b);
        const hay = `${b.manifest_type_identifier} ${
          b.human_friendly_block_name ?? ""
        } ${ui.description ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const cat = categoryFor(b);
      (map[cat] ||= []).push(b);
    }
    const extras = Object.keys(map).filter((c) => !CATEGORY_ORDER.includes(c));
    const order = [...CATEGORY_ORDER.filter((c) => map[c]), ...extras];
    return order.map(
      (c) =>
        [
          c,
          map[c].sort((a, b) =>
            a.manifest_type_identifier.localeCompare(b.manifest_type_identifier),
          ),
        ] as const,
    );
  }, [allBlocks, q]);

  const totalCount = grouped.reduce((a, [, list]) => a + list.length, 0);

  const renderBlock = (b: BlockDef) => (
    <div
      className="block"
      key={b.manifest_type_identifier}
      draggable
      onDragStart={(e) => onDragStart(e, b)}
      title={uiManifestFor(b).description || b.manifest_type_identifier}
    >
      <BlockIcon block={b} size={13} className="block-icon" />
      <div className="block-body">
        <div className="name">
          {b.human_friendly_block_name || b.manifest_type_identifier}
          {uiManifestFor(b).popular && <span className="dot-popular" title="Popular" />}
        </div>
        <div className="id">{b.manifest_type_identifier}</div>
      </div>
    </div>
  );

  return (
    <div className="palette">
      <h3>
        Blocks <span className="count">({totalCount})</span>
      </h3>
      <input
        className="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search blocks…"
      />

      {!q && popular.length > 0 && (
        <div className={`group ${isOpen("Popular") ? "open" : ""}`}>
          <button className="group-title" onClick={() => toggle("Popular")}>
            <span className="icon-wrap">
              <CategoryIcon category="Foundation Models" size={13} />
            </span>
            <span className="name">Popular</span>
            <span className="count">{popular.length}</span>
            <span className="chev">{isOpen("Popular") ? "▾" : "▸"}</span>
          </button>
          {isOpen("Popular") && (
            <div className="group-body">{popular.map(renderBlock)}</div>
          )}
        </div>
      )}

      {grouped.map(([cat, list]) => (
        <div className={`group ${isOpen(cat) ? "open" : ""}`} key={cat}>
          <button className="group-title" onClick={() => toggle(cat)}>
            <span className="icon-wrap">
              <CategoryIcon category={cat} size={13} />
            </span>
            <span className="name">{cat}</span>
            <span className="count">{list.length}</span>
            <span className="chev">{isOpen(cat) ? "▾" : "▸"}</span>
          </button>
          {isOpen(cat) && (
            <div className="group-body">{list.map(renderBlock)}</div>
          )}
        </div>
      ))}

      {q && totalCount === 0 && (
        <div className="palette-empty">
          No blocks match "{q}"
        </div>
      )}
    </div>
  );
}
