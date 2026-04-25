// Resource-budget estimator for a workflow spec.
//
// The edge runtime is headless and runs on a fixed-VRAM GPU. If the
// authored workflow asks for more VRAM than the target edge device
// has, the runtime OOMs silently. This module gives the builder a
// rough "≈ X GB" readout so operators can catch over-budget workflows
// before publishing.
//
// Numbers are deliberate over-estimates by ~10-20% to give the
// runtime headroom. They cover steady-state model weights + typical
// activations for a single 640×640 frame at fp16. Multi-stream
// scaling, batch>1, and dynamic-shape models are NOT modelled — the
// readout will under-estimate those workloads.
//
// Sources:
//   - YOLOv8 family: ultralytics/ultralytics docs (model card sizes
//     × 1.5 fudge for activations).
//   - SAM3: matches the inline note in RunPanel that the model
//     "claims ~4 GB VRAM" when loaded; cross-checked against
//     phase_1_status.md hardware run.
//   - RF-DETR: roboflow/inference rf-detr v1 docs.
//   - Tracker / counter / viz blocks: small (~5-50 MB) for state
//     buffers; rounded to nice numbers.
//
// When a step's cost can't be looked up, `unknown_blocks` records the
// step type so we can surface "estimate may be low" warnings instead
// of pretending zero.

export type StepCost = {
  step_name: string;
  block_type: string;
  model_id: string | null;
  mb: number;
  // True when we don't have a recipe for this block — counted as
  // `UNKNOWN_BLOCK_FALLBACK_MB` so the readout doesn't read 0.
  is_estimate: boolean;
};

export type BudgetEstimate = {
  total_mb: number;
  steps: StepCost[];
  unknown_blocks: string[];
};

// Sensible default for "typical edge GPU" until we wire a per-device
// selector. Most FlytBase edge devices target 8 GB. Override at
// runtime by setting `window.__FLYBUILD__.budget_mb`.
export const DEFAULT_BUDGET_MB = 8 * 1024;

// 50 MB is the cost of a "small misc block we forgot to enumerate".
// Picked so a 4-block unknown workflow lands at ~200 MB rather than
// 0 — wrong but not silently-wrong.
const UNKNOWN_BLOCK_FALLBACK_MB = 50;

// Cost of model weights + activations, by literal model_id. Order
// matters when a key is a substring of another — we match longest
// first.
const VRAM_BY_MODEL_ID: Array<[RegExp, number]> = [
  [/^yolov8n[-_]?640$/i, 200],
  [/^yolov8n/i, 250],
  [/^yolov8s/i, 400],
  [/^yolov8m/i, 750],
  [/^yolov8l/i, 1300],
  [/^yolov8x/i, 2400],
  [/^yolov?-?nas/i, 600],
  [/^yolov11/i, 500],
  [/^rf-?detr/i, 2000],
  [/^sam[-_]?3/i, 4000],
  [/^sam[-_]?2/i, 2500],
  [/^grounding[-_]?dino/i, 2200],
  [/^clip/i, 600],
  // First-party Roboflow-style classifier models (eapcd suffix etc.)
  [/.*-eapcd\/\d+/i, 200],
];

// Cost of a block independent of any model_id it carries.
//
// Two flavours of entry:
//   1. Model-bearing blocks where the BLOCK TYPE implies a specific
//      model (sam3@v1 always means SAM 3, no model_id needed) — we
//      count the model weights + activations.
//   2. Stateful blocks that hold their own GPU tensors regardless of
//      input size (tracker embeddings, time-in-zone history) — we
//      count the state buffer.
//
// For model-bearing blocks where model_id is explicit (e.g.
// `roboflow_object_detection_model@v2` carries `model_id:
// "yolov8n-640"`), the model_id table wins and these entries don't
// fire.
const VRAM_BY_BLOCK_TYPE: Array<[RegExp, number]> = [
  // Block type implies a specific large model — these MUST run before
  // the small/state entries below so they win on substring matches.
  [/sam[_-]?3@/i, 4000],
  [/sam[_-]?2@/i, 2500],
  [/grounding[_-]?dino@/i, 2200],
  [/clip(_|@)/i, 600],
  // Stateful — running state lives in CPU RAM mostly, but cuda
  // tensors for embeddings still count.
  [/byte[_-]?tracker/i, 60],
  [/trackers_(byte|oc|sort)/i, 60],
  [/line[_-]?counter/i, 5],
  [/time[_-]?in[_-]?zone/i, 10],
  [/dynamic[_-]?zone/i, 5],
  [/property[_-]?definition/i, 1],
  [/expression/i, 1],
  // Visualizations are CPU + small staging buffers.
  [/_visualization/i, 10],
  [/visualization$/i, 10],
  // Crop blocks allocate GPU buffers proportional to input.
  [/(dynamic|absolute|relative)_(static_)?crop/i, 25],
  // Image slicer / SAHI is memory-hungry per slice.
  [/image_slicer/i, 200],
  // Filter / aggregator are tiny.
  [/detections_filter|first_non_empty|data_aggregator/i, 5],
  // Perspective correction allocates a homography buffer.
  [/perspective_correction/i, 20],
];

const MODEL_BEARING_BLOCK = /(_model$|@v\d+$)/i;

function findCost(table: Array<[RegExp, number]>, key: string): number | null {
  for (const [re, mb] of table) {
    if (re.test(key)) return mb;
  }
  return null;
}

export function estimateWorkflowVram(spec: unknown): BudgetEstimate {
  const out: BudgetEstimate = {
    total_mb: 0,
    steps: [],
    unknown_blocks: [],
  };
  if (!spec || typeof spec !== "object") return out;
  const steps: any[] = (spec as any).steps || [];
  if (!Array.isArray(steps)) return out;

  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const name = String(step.name || "?");
    const blockType = String(step.type || "");
    if (!blockType) continue;

    let mb = 0;
    let isEstimate = false;
    const modelId =
      typeof step.model_id === "string" && !step.model_id.startsWith("$")
        ? step.model_id
        : null;

    if (modelId) {
      const m = findCost(VRAM_BY_MODEL_ID, modelId);
      if (m != null) {
        mb = m;
      } else {
        // Block has a model_id but we don't recognise it — count
        // generic 300 MB so it shows on the breakdown.
        mb = 300;
        isEstimate = true;
        out.unknown_blocks.push(`${name} (${modelId})`);
      }
    } else {
      const b = findCost(VRAM_BY_BLOCK_TYPE, blockType);
      if (b != null) {
        mb = b;
      } else if (MODEL_BEARING_BLOCK.test(blockType) && !modelId) {
        // Block looks model-bearing but model_id is dynamic — assume
        // a typical detection model.
        mb = 300;
        isEstimate = true;
        out.unknown_blocks.push(`${name} (dynamic model_id)`);
      } else {
        mb = UNKNOWN_BLOCK_FALLBACK_MB;
        isEstimate = true;
        out.unknown_blocks.push(`${name} (${blockType})`);
      }
    }

    out.steps.push({
      step_name: name,
      block_type: blockType,
      model_id: modelId,
      mb,
      is_estimate: isEstimate,
    });
    out.total_mb += mb;
  }
  return out;
}

// Format a megabyte total for the chip pill. Sub-1024 → "256 MB",
// otherwise "≈ 4.2 GB" with one decimal so a 4096 MB SAM3 reads as
// 4.0 not 4.
export function formatVram(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export type BudgetSeverity = "ok" | "warn" | "over";

export function severityFor(mb: number, budgetMb: number): BudgetSeverity {
  if (mb > budgetMb) return "over";
  if (mb > budgetMb * 0.8) return "warn";
  return "ok";
}
