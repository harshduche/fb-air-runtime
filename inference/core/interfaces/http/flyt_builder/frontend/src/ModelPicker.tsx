// Model picker modal — used by Inspector fields that look like a
// `model_id`. Splits "Your models" (scanned from the local
// $MODEL_CACHE_DIR) from "Public models" (hardcoded curated list —
// Roboflow's public catalogue).

import { useEffect, useMemo, useState } from "react";
import { listLocalModels } from "./api";

type Curated = {
  id: string;
  name: string;
  description: string;
  size?: string;
  tag?: "featured" | "popular" | null;
};

const PUBLIC_MODELS: Curated[] = [
  {
    id: "rf-detr-medium-coco",
    name: "RF-DETR Medium",
    description: "Transformer detector with strong zero-shot COCO performance.",
    size: "Medium (576×576)",
    tag: "featured",
  },
  {
    id: "yolov8n-640",
    name: "YOLOv8 Nano",
    description: "Fast baseline for realtime detection. Good default.",
    size: "Nano (640×640)",
    tag: "popular",
  },
  {
    id: "yolov8s-640",
    name: "YOLOv8 Small",
    description: "Balanced speed/accuracy.",
    size: "Small (640×640)",
  },
  {
    id: "yolov8m-640",
    name: "YOLOv8 Medium",
    description: "Higher-quality detections at 2× the cost of Nano.",
    size: "Medium (640×640)",
  },
  {
    id: "yolo-nas-m-640",
    name: "YOLO-NAS Medium",
    description: "NAS-tuned detector from Deci. Strong throughput on edge.",
    size: "Medium (640×640)",
  },
  {
    id: "coco/3",
    name: "COCO General",
    description: "Generic object detection on 80 COCO classes.",
    size: "Medium",
  },
  {
    id: "vehicle-classification-eapcd/2",
    name: "Vehicle Classification",
    description: "Fine-grained vehicle classes.",
  },
];

export function ModelPicker({
  value,
  onPick,
  onClose,
}: {
  value: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"yours" | "public">("public");
  const [local, setLocal] = useState<Array<{ id: string; label: string }>>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listLocalModels()
      .then((d) => {
        setLocal(d);
        if (d.length > 0) setTab("yours");
      })
      .catch(() => setLocal([]))
      .finally(() => setLoading(false));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const publicFiltered = useMemo(() => {
    if (!q) return PUBLIC_MODELS;
    const needle = q.toLowerCase();
    return PUBLIC_MODELS.filter(
      (m) =>
        m.id.toLowerCase().includes(needle) ||
        m.name.toLowerCase().includes(needle) ||
        m.description.toLowerCase().includes(needle),
    );
  }, [q]);

  const yoursFiltered = useMemo(() => {
    if (!q) return local;
    const needle = q.toLowerCase();
    return local.filter(
      (m) =>
        m.id.toLowerCase().includes(needle) ||
        m.label.toLowerCase().includes(needle),
    );
  }, [local, q]);

  const list = tab === "yours" ? yoursFiltered : publicFiltered;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="model-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="header">
          <div className="title">Select a Model</div>
          <button className="icon-btn close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="tabs">
          <button
            className={tab === "yours" ? "tab active" : "tab"}
            onClick={() => setTab("yours")}
          >
            Your models{local.length ? ` · ${local.length}` : ""}
          </button>
          <button
            className={tab === "public" ? "tab active" : "tab"}
            onClick={() => setTab("public")}
          >
            Public models
          </button>
        </div>
        <input
          className="search"
          placeholder="Search models or enter a model id…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && q.trim()) {
              onPick(q.trim());
              onClose();
            }
          }}
        />
        <div className="model-list">
          {loading && tab === "yours" && <div className="empty">Scanning…</div>}
          {!loading && tab === "yours" && local.length === 0 && (
            <div className="empty">
              No local models found under <code>$MODEL_CACHE_DIR</code>.
              Switch to Public models or type a model id into Search.
            </div>
          )}
          {list.map((m: any) => {
            const id = m.id;
            const isSel = value === id;
            return (
              <button
                key={id}
                className={`model-row ${isSel ? "selected" : ""}`}
                onClick={() => {
                  onPick(id);
                  onClose();
                }}
              >
                <div className="main">
                  <div className="name">
                    {m.name || m.label || id}
                    {m.tag && <span className={`tag ${m.tag}`}>{m.tag}</span>}
                  </div>
                  <div className="id">{id}</div>
                  {m.description && <div className="desc">{m.description}</div>}
                </div>
                {m.size && <div className="size">{m.size}</div>}
              </button>
            );
          })}
        </div>
        <div className="footer">
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
