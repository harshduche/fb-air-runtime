// Two UIs bundled here because they share the same ranking logic:
//
//   • <BlockPickerModal>   — centered Add Block modal with search + category
//                            accordion (screenshot 3.18.16).
//   • <InlineBlockPicker>  — floating popover anchored to an edge or node
//                            handle, filtered to blocks compatible with the
//                            upstream output kinds (screenshot parity +
//                            "suggestive dropdown in place" per user ask).

import { useEffect, useMemo, useRef, useState } from "react";
import { BlockDef } from "./api";
import { categoryFor, uiManifestFor } from "./compile";
import { pseudoBlockDefs, isPseudoBlock } from "./compile";
import { BlockIcon, CategoryIcon } from "./icons";

type RankedBlock = {
  def: BlockDef;
  score: number;
  popular: boolean;
};

// ---- ranking ----------------------------------------------------------

function rankBlocks(
  blocks: BlockDef[],
  compatibleIds: Set<string> | null,
  query: string,
): RankedBlock[] {
  const q = query.trim().toLowerCase();
  const matches: RankedBlock[] = [];
  for (const b of blocks) {
    if (isPseudoBlock(b.manifest_type_identifier)) continue;
    if (compatibleIds && !compatibleIds.has(b.manifest_type_identifier)) continue;
    const ui = uiManifestFor(b);
    const popular = !!ui.popular;
    const priority = typeof ui.blockPriority === "number" ? ui.blockPriority : 100;
    const hay = `${b.manifest_type_identifier} ${b.human_friendly_block_name ?? ""} ${ui.description ?? ""}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    // Score: lower is better. Popular: -1000. Priority contributes.
    // Query match in title: -50.
    let score = priority;
    if (popular) score -= 1000;
    const title = (b.human_friendly_block_name ?? b.manifest_type_identifier).toLowerCase();
    if (q && title.includes(q)) score -= 50;
    matches.push({ def: b, score, popular });
  }
  matches.sort((a, b) => a.score - b.score);
  return matches;
}

// ---- centered modal ---------------------------------------------------

export function BlockPickerModal({
  blocks,
  onPick,
  onClose,
}: {
  blocks: BlockDef[];
  onPick: (def: BlockDef) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const extended = useMemo(() => [...pseudoBlockDefs(), ...blocks], [blocks]);

  const grouped = useMemo(() => {
    const ranked = rankBlocks(extended, null, q);
    const map: Record<string, RankedBlock[]> = {};
    for (const r of ranked) {
      const cat = categoryFor(r.def);
      (map[cat] ||= []).push(r);
    }
    const order = [
      "Inputs / Outputs",
      "Model",
      "Models",
      "Foundation Models",
      "Visualization",
      "Transformations",
      "Analytics",
      "Logic",
      "Sinks",
      "Data Storage",
      "Notification",
      "Video",
      "Classical Computer Vision",
      "Advanced",
      "Industrial Integration",
      "Other",
    ];
    const rest = Object.keys(map).filter((c) => !order.includes(c));
    return [...order.filter((c) => map[c]), ...rest].map(
      (c) => [c, map[c]] as const,
    );
  }, [extended, q]);

  const total = grouped.reduce((a, [, list]) => a + list.length, 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="block-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="header">
          <div className="title">Add Block</div>
          <button className="icon-btn close" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <input
          ref={inputRef}
          className="search"
          placeholder={`Search ${blocks.length}+ blocks…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const first = grouped[0]?.[1]?.[0]?.def;
              if (first) {
                onPick(first);
                onClose();
              }
            }
          }}
        />
        <div className="category-list">
          {total === 0 && (
            <div className="empty">No matches for "{q}"</div>
          )}
          {grouped.map(([cat, list]) => {
            const open = q ? true : expanded === cat;
            return (
              <div className={`category ${open ? "open" : ""}`} key={cat}>
                <button
                  className="category-head"
                  onClick={() => setExpanded(open ? null : cat)}
                >
                  <CategoryIcon category={cat} size={14} />
                  <span>{cat}</span>
                  <span className="count">{list.length}</span>
                  <span className="chev">{open ? "▾" : "▸"}</span>
                </button>
                {open && (
                  <div className="category-body">
                    {list.map((r) => (
                      <button
                        className={`block-row ${r.popular ? "popular" : ""}`}
                        key={r.def.manifest_type_identifier}
                        onClick={() => {
                          onPick(r.def);
                          onClose();
                        }}
                        title={
                          uiManifestFor(r.def).description ||
                          r.def.manifest_type_identifier
                        }
                      >
                        <BlockIcon block={r.def} size={14} className="row-icon" />
                        <div className="row-body">
                          <div className="name">
                            {r.def.human_friendly_block_name ||
                              r.def.manifest_type_identifier}
                            {r.popular && <span className="tag">popular</span>}
                          </div>
                          <div className="id">
                            {r.def.manifest_type_identifier}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- inline suggestive popover ---------------------------------------

export function InlineBlockPicker({
  blocks,
  compatibleIds,
  anchor,
  hint,
  onPick,
  onClose,
}: {
  blocks: BlockDef[];
  /** When non-null, only blocks whose ID is in this set are shown. */
  compatibleIds: Set<string> | null;
  /** Viewport coords for the floating popover. */
  anchor: { x: number; y: number };
  /** Optional hint above the list, e.g. "image, object_detection_prediction". */
  hint?: string;
  onPick: (def: BlockDef) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClickOutside = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest(".inline-block-picker");
      if (!el) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClickOutside);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClickOutside);
    };
  }, [onClose]);

  const ranked = useMemo(
    () => rankBlocks(blocks, compatibleIds, q).slice(0, 40),
    [blocks, compatibleIds, q],
  );

  // Clamp popover inside viewport.
  const style: React.CSSProperties = {
    left: Math.min(Math.max(8, anchor.x), window.innerWidth - 320),
    top: Math.min(Math.max(8, anchor.y), window.innerHeight - 400),
  };

  return (
    <div className="inline-block-picker" style={style}>
      <input
        ref={inputRef}
        className="search"
        placeholder="Add a block…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ranked[0]) {
            onPick(ranked[0].def);
            onClose();
          }
        }}
      />
      {hint && <div className="hint">accepts: {hint}</div>}
      <div className="list">
        {ranked.length === 0 && (
          <div className="empty">
            {compatibleIds
              ? "No block accepts that output. Try Search all blocks."
              : "No matches"}
          </div>
        )}
        {ranked.map((r) => (
          <button
            className={`row ${r.popular ? "popular" : ""}`}
            key={r.def.manifest_type_identifier}
            onClick={() => {
              onPick(r.def);
              onClose();
            }}
            title={
              uiManifestFor(r.def).description || r.def.manifest_type_identifier
            }
          >
            <BlockIcon block={r.def} size={14} className="row-icon" />
            <div className="row-body">
              <div className="name">
                {r.def.human_friendly_block_name ||
                  r.def.manifest_type_identifier}
                {r.popular && <span className="tag">popular</span>}
              </div>
              <div className="id">{r.def.manifest_type_identifier}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
