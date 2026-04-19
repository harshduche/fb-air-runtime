// Translation layer between the React Flow node/edge graph and the Roboflow
// Inference workflow-engine JSON format.
//
// Nodes come in three flavours:
//   • step:     a real block (e.g. roboflow_core/sam3@v3)
//   • input:    a workflow input (WorkflowImage / WorkflowParameter)
//   • output:   a workflow output (JsonField)
//
// Target spec shape:
// {
//   "version": "1.0",
//   "inputs":  [{ "type": "WorkflowImage"|"WorkflowParameter", "name": "..." }],
//   "steps":   [{ "type": "<block_id>", "name": "<step_name>", ...params }],
//   "outputs": [{ "type": "JsonField", "name": "...", "selector": "..." }]
// }

import { Edge, Node } from "reactflow";
import { BlockDef, BlockOutputDef } from "./api";

// Read the Roboflow `ui_manifest` block (may live under json_schema_extra
// or be hoisted). Used for popular/blockPriority/section/icon hints.
export function uiManifestFor(def: BlockDef): Record<string, any> {
  const schema = def.block_schema ?? {};
  if ((schema as any).ui_manifest) return (schema as any).ui_manifest;
  const jse = (schema as any).json_schema_extra ?? {};
  if (jse.ui_manifest) return jse.ui_manifest;
  return jse;
}

// Coarse category. Prefer the manifest's `section` field. Falls back to
// pattern-matching on the manifest id — same heuristic as Palette.
export function categoryFor(def: BlockDef): string {
  const ui = uiManifestFor(def);
  const explicit: string | undefined = ui.section || ui.category;
  if (explicit) {
    // Roboflow uses lowercase machine names like "model"/"sink";
    // capitalise for display.
    return explicit.charAt(0).toUpperCase() + explicit.slice(1);
  }
  const id = def.manifest_type_identifier;
  const base = (id.split("/").pop() || id).replace(/@.*$/, "");
  if (/roboflow.*model/.test(base)) return "Models";
  if (/^sam\d?$/.test(base) || base.startsWith("sam") || /florence|clip|perception|dinov|owlv|grounding|moondream|trocr|easy_ocr|depth/.test(base)) return "Foundation Models";
  if (/sink|upload|webhook|s3|local_file|onvif/.test(base)) return "Sinks";
  if (/visualization|label_visualization|color_visualization|polygon|heat_map|bounding_box|keypoint|mask|trace/.test(base)) return "Visualization";
  if (/crop|resize|stabilize|static_crop|dynamic_crop|byte_tracker|tracker|stitch/.test(base)) return "Transformations";
  if (/zone|line|polygon_zone|time_in_zone|path_deviation|velocity|distance|barcode|qr/.test(base)) return "Analytics";
  if (/filter|detections_consensus|detection_offset|aggregat|count|sample/.test(base)) return "Logic";
  return "Other";
}

// Kinds produced by a step, collated as a Set<string> of kind names.
// Used by the suggestive picker and the auto-wire helper.
export function outputKindsOf(def: BlockDef | undefined): Set<string> {
  const out = new Set<string>();
  if (!def) return out;
  for (const o of def.outputs_manifest ?? []) {
    for (const k of o.kind ?? []) {
      const name = typeof k === "string" ? k : k?.name;
      if (name) out.add(name);
    }
  }
  return out;
}

// Per-output kinds — { output_name → Set<kind_name> }
export function outputsByName(def: BlockDef | undefined): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  for (const o of def?.outputs_manifest ?? []) {
    const kinds = new Set<string>();
    for (const k of o.kind ?? []) {
      const name = typeof k === "string" ? k : k?.name;
      if (name) kinds.add(name);
    }
    map[o.name] = kinds;
  }
  return map;
}

export function flattenOutputDefs(def: BlockDef | undefined): BlockOutputDef[] {
  return def?.outputs_manifest ?? [];
}

// ---- Auto-wire helper ---------------------------------------------------
//
// Given a source node (step or input) and a target step, compute which
// target-block fields can be filled with a selector pointing at the
// source. This is used both when the user manually draws an edge AND
// when they pick a block from the inline suggestive popover.
//
// Heuristic:
//  1. Skip fields already filled or hidden (`type`, `name`).
//  2. Only consider fields whose name or description looks like a
//     reference (image/input/predictions/crops/detections/...).
//  3. For step sources, match target field name against source output
//     names so e.g. `image` maps to the source's `image` output, and
//     `predictions`/`detections` maps to `predictions`/`tracked_detections`.
//  4. If no exact match, fall back to a preferred-name list
//     (`image`, `predictions`, `tracked_detections`, `crops`), then to
//     the first output, then to `*`.

const REF_FIELD_RE = /image|input|reference|from|selector|prediction|detections|crops|tracks/i;
const PREFERRED_OUTPUTS = ["image", "predictions", "tracked_detections", "crops"];

export function isRefField(key: string, descr?: string): boolean {
  if (REF_FIELD_RE.test(key)) return true;
  if (descr && /\$steps|selector/i.test(descr)) return true;
  return false;
}

function pickSourceOutputForField(
  fieldKey: string,
  outs: string[],
  acceptableOuts: Set<string> | null,
): string | null {
  if (outs.length === 0) return "*";
  // Restrict candidates to ones whose kind is accepted by the target
  // field. If nothing overlaps, return null so the caller knows to skip
  // this field rather than silently fill with a kind mismatch.
  const pool = acceptableOuts
    ? outs.filter((o) => acceptableOuts.has(o))
    : outs;
  if (pool.length === 0) return null;
  const keyLc = fieldKey.toLowerCase();
  const exact = pool.find((o) => o.toLowerCase() === keyLc);
  if (exact) return exact;
  const partial = pool.find(
    (o) =>
      o.toLowerCase().includes(keyLc) ||
      keyLc.includes(o.toLowerCase()),
  );
  if (partial) return partial;
  for (const p of PREFERRED_OUTPUTS) {
    if (pool.includes(p)) return p;
  }
  return pool[0];
}

// Inspect a property schema to see whether it accepts a $steps/$inputs
// selector (via an anyOf branch with `reference: true`), what kinds it
// accepts, and whether the selector is the *only* accepted shape.
export function refInfoForSchema(schema: any): {
  canRef: boolean;
  refOnly: boolean;
  kinds: Set<string>;
} {
  const extractKinds = (branch: any): Set<string> => {
    const out = new Set<string>();
    const k = branch?.kind;
    if (!Array.isArray(k)) return out;
    for (const x of k) {
      const name = typeof x === "string" ? x : x?.name;
      if (name) out.add(name);
    }
    return out;
  };
  if (!schema || typeof schema !== "object") {
    return { canRef: false, refOnly: false, kinds: new Set() };
  }
  if (Array.isArray(schema.anyOf)) {
    let refBranch: any = null;
    const otherNonNull: any[] = [];
    for (const b of schema.anyOf) {
      if (b?.reference) refBranch = b;
      else if (b?.type !== "null") otherNonNull.push(b);
    }
    if (!refBranch) return { canRef: false, refOnly: false, kinds: new Set() };
    return {
      canRef: true,
      refOnly: otherNonNull.length === 0,
      kinds: extractKinds(refBranch),
    };
  }
  if (schema.reference) {
    return { canRef: true, refOnly: true, kinds: extractKinds(schema) };
  }
  return { canRef: false, refOnly: false, kinds: new Set() };
}

// Reverse lookup: given (block, field), what kinds does that field accept?
// Walks `kinds_connections` (kind → [{block_id, property_name}, …]) and
// collects every kind that lists this target.
export function acceptedKindsFor(
  blockId: string,
  property: string,
  kindsConnections:
    | Record<
        string,
        Array<{ manifest_type_identifier: string; property_name: string }>
      >
    | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!kindsConnections) return out;
  for (const [kind, list] of Object.entries(kindsConnections)) {
    for (const c of list) {
      if (
        c.manifest_type_identifier === blockId &&
        c.property_name === property
      ) {
        out.add(kind);
        break;
      }
    }
  }
  return out;
}

// Returns true for fields whose type is "just a string / selector" and
// therefore safe to auto-fill with a $steps/$inputs reference. Fields
// declared as boolean / integer / number / enum are skipped — crucial
// because many blocks have booleans named like `copy_image` or
// `include_predictions` that match our ref regex purely by substring.
function isAutoFillableType(ps: any): boolean {
  // Gather every type declaration we might see: direct `type`, arrays
  // (`["string","null"]`), and anyOf members.
  const types: string[] = [];
  const push = (t: unknown) => {
    if (typeof t === "string") types.push(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") types.push(x);
  };
  push(ps?.type);
  if (Array.isArray(ps?.anyOf)) {
    for (const m of ps.anyOf) push(m?.type);
  }
  if (types.length === 0) return true; // untyped → assume string-shaped
  const allowed = new Set(["string", "null"]);
  return types.every((t) => allowed.has(t));
}

export function autoWireFields(
  srcData: FlytNodeData,
  tgtData: FlytNodeData,
  kindsConnections?: Record<
    string,
    Array<{ manifest_type_identifier: string; property_name: string }>
  >,
): Record<string, string> {
  if (tgtData.kind !== "step") return {};
  const schema = tgtData.block?.block_schema;
  if (!schema) return {};
  const existing = tgtData.params || {};
  const props = schema.properties || {};
  const targetBlockId = tgtData.block?.manifest_type_identifier ?? "";

  const outsMap = srcData.kind === "step" ? outputsByName(srcData.block) : {};
  const srcOutputs = Object.keys(outsMap);

  const fills: Record<string, string> = {};
  for (const [key, ps] of Object.entries(props)) {
    if (key === "type" || key === "name") continue;
    if (existing[key] !== undefined && existing[key] !== "") continue;
    const pss = ps as { description?: string; enum?: unknown[] };
    if (pss.enum && pss.enum.length > 0) continue;
    if (!isAutoFillableType(ps)) continue;
    if (!isRefField(key, pss.description)) continue;

    // Kinds this field accepts, per the workflow registry. Empty set =
    // we don't know → be lenient (treat all outputs as acceptable).
    const accepted = acceptedKindsFor(targetBlockId, key, kindsConnections);

    if (srcData.kind === "input") {
      if (!srcData.inputName) continue;
      // Only wire a WorkflowImage source into a field that accepts
      // "image" kind (or when we have no kind info).
      if (accepted.size > 0) {
        const kindForInput =
          srcData.inputType === "WorkflowImage" ? "image" : null;
        if (!kindForInput || !accepted.has(kindForInput)) continue;
      } else {
        // Fallback name-based check when kinds aren't known.
        const wantsImage = /(^|_)image($|_)/i.test(key);
        if (wantsImage && srcData.inputType !== "WorkflowImage") continue;
      }
      fills[key] = `$inputs.${srcData.inputName}`;
    } else if (srcData.kind === "step") {
      if (!srcData.stepName) continue;
      // Build set of source outputs whose kind overlaps with `accepted`.
      // If `accepted` is empty we pass null (accept any).
      let acceptableOuts: Set<string> | null = null;
      if (accepted.size > 0) {
        acceptableOuts = new Set<string>();
        for (const [outName, kinds] of Object.entries(outsMap)) {
          for (const k of kinds) {
            if (accepted.has(k)) {
              acceptableOuts.add(outName);
              break;
            }
          }
        }
        if (acceptableOuts.size === 0) continue; // no compatible output
      }
      const out = pickSourceOutputForField(key, srcOutputs, acceptableOuts);
      if (!out) continue;
      fills[key] = `$steps.${srcData.stepName}.${out}`;
    }
  }
  return fills;
}

// ---- Pre-flight validator ---------------------------------------------
//
// Walk a compiled spec and report required fields left empty. The run
// button hits the engine on every click; surfacing this locally saves
// users a 400 round-trip with a cryptic WorkflowSyntaxError.

export function validateRequiredFields(
  spec: { steps?: Array<Record<string, unknown>> },
  blocks: BlockDef[],
): Array<{ step: string; missing: string[] }> {
  const issues: Array<{ step: string; missing: string[] }> = [];
  const byId: Record<string, BlockDef> = {};
  for (const b of blocks) byId[b.manifest_type_identifier] = b;

  for (const step of spec.steps ?? []) {
    const stepType = String(step.type ?? "");
    const def = byId[stepType];
    if (!def) continue;
    const required: string[] = def.block_schema?.required ?? [];
    const missing = required.filter(
      (r) => r !== "type" && r !== "name" && (step[r] === undefined || step[r] === ""),
    );
    if (missing.length > 0) {
      issues.push({ step: String(step.name ?? stepType), missing });
    }
  }
  return issues;
}

export type NodeKind = "step" | "input" | "output";

export type FlytNodeData = {
  kind: NodeKind;
  // step
  block?: BlockDef;
  stepName?: string;
  params?: Record<string, unknown>;
  // input
  inputName?: string;
  inputType?: "WorkflowImage" | "WorkflowParameter";
  inputDefault?: string;
  // Per-input "test value" used when Run executes the workflow. For
  // WorkflowImage this can be an http(s) URL, a data: URL (from an
  // uploaded file), or raw base64. For WorkflowParameter it's a plain
  // string that will be coerced to a number if numeric.
  testValue?: string;
  // Preview metadata for the Inspector thumbnail (not serialized).
  testMime?: string;
  testFilename?: string;
  // output
  outputName?: string;
  outputSelector?: string;
};

export const PSEUDO_INPUT_IMAGE = "flyt/input_image";
export const PSEUDO_INPUT_PARAM = "flyt/input_parameter";
export const PSEUDO_OUTPUT = "flyt/output";

export function isPseudoBlock(id: string): boolean {
  return id === PSEUDO_INPUT_IMAGE || id === PSEUDO_INPUT_PARAM || id === PSEUDO_OUTPUT;
}

export function pseudoBlockDefs(): BlockDef[] {
  return [
    {
      manifest_type_identifier: PSEUDO_INPUT_IMAGE,
      human_friendly_block_name: "Input · Image",
    },
    {
      manifest_type_identifier: PSEUDO_INPUT_PARAM,
      human_friendly_block_name: "Input · Parameter",
    },
    {
      manifest_type_identifier: PSEUDO_OUTPUT,
      human_friendly_block_name: "Output · Field",
    },
  ];
}

export function kindForBlock(id: string): NodeKind {
  if (id === PSEUDO_INPUT_IMAGE || id === PSEUDO_INPUT_PARAM) return "input";
  if (id === PSEUDO_OUTPUT) return "output";
  return "step";
}

export function defaultDataForBlock(
  block: BlockDef,
  existing: string[],
): FlytNodeData {
  const kind = kindForBlock(block.manifest_type_identifier);
  if (kind === "input") {
    const isImage = block.manifest_type_identifier === PSEUDO_INPUT_IMAGE;
    const base = isImage ? "image" : "param";
    return {
      kind: "input",
      inputName: uniqueName(base, existing),
      inputType: isImage ? "WorkflowImage" : "WorkflowParameter",
      inputDefault: "",
    };
  }
  if (kind === "output") {
    return {
      kind: "output",
      outputName: uniqueName("out", existing),
      outputSelector: "",
    };
  }
  return {
    kind: "step",
    block,
    stepName: uniqueName(
      block.manifest_type_identifier.split("/").pop()!.replace(/@.*$/, ""),
      existing,
    ),
    params: {},
  };
}

export function nameOf(data: FlytNodeData): string {
  if (data.kind === "step") return data.stepName!;
  if (data.kind === "input") return data.inputName!;
  return data.outputName!;
}

export function setNameOf(data: FlytNodeData, next: string): FlytNodeData {
  if (data.kind === "step") return { ...data, stepName: next };
  if (data.kind === "input") return { ...data, inputName: next };
  return { ...data, outputName: next };
}

export function uniqueName(base: string, existing: string[]): string {
  const clean = base.replace(/[^a-z0-9]/gi, "_").toLowerCase() || "node";
  const taken = new Set(existing);
  if (!taken.has(clean)) return clean;
  let i = 2;
  while (taken.has(`${clean}_${i}`)) i += 1;
  return `${clean}_${i}`;
}

export function compileWorkflow(
  nodes: Node<FlytNodeData>[],
  edges: Edge[],
): {
  version: string;
  inputs: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
} {
  const inputs = nodes
    .filter((n) => n.data.kind === "input")
    .map((n) => ({
      type: n.data.inputType || "WorkflowParameter",
      name: n.data.inputName || "input",
      ...(n.data.inputDefault ? { default_value: n.data.inputDefault } : {}),
    }));

  const steps = nodes
    .filter((n) => n.data.kind === "step")
    .map((n) => {
      const step: Record<string, unknown> = {
        type: n.data.block!.manifest_type_identifier,
        name: n.data.stepName!,
      };
      for (const [k, v] of Object.entries(n.data.params || {})) {
        if (v === undefined || v === "" || v === null) continue;
        step[k] = v;
      }
      return step;
    });

  // Build an id→node lookup so we can auto-derive output selectors from any
  // incoming edge if the user hasn't typed a manual selector.
  const byId: Record<string, Node<FlytNodeData>> = {};
  for (const n of nodes) byId[n.id] = n;

  const outputs = nodes
    .filter((n) => n.data.kind === "output")
    .map((n) => {
      const name = n.data.outputName || "out";
      let selector = (n.data.outputSelector || "").trim();
      if (!selector) {
        const incoming = edges.find((e) => e.target === n.id);
        if (incoming) {
          const src = byId[incoming.source];
          if (src?.data.kind === "step") {
            selector = `$steps.${src.data.stepName}.*`;
          } else if (src?.data.kind === "input") {
            selector = `$inputs.${src.data.inputName}`;
          }
        }
      }
      return {
        type: "JsonField",
        name,
        selector: selector || "$steps.unknown.*",
      };
    });

  return { version: "1.0", inputs, steps, outputs };
}
