import { useMemo, useState } from "react";
import { Edge, Node } from "reactflow";
import { BlockParamSchema } from "./api";
import {
  FlytNodeData,
  acceptedKindsFor,
  outputsByName,
  refInfoForSchema,
} from "./compile";

type Props = {
  node: Node<FlytNodeData> | null;
  onChange: (next: FlytNodeData) => void;
  allNodes: Node<FlytNodeData>[];
  edges: Edge[];
  /** kinds_connections from /workflows/blocks/describe — used for
   *  filtering the reference combobox. May be undefined during load. */
  kindsConnections?: Record<
    string,
    Array<{ manifest_type_identifier: string; property_name: string }>
  >;
  /** Called when a `model_id`-shaped field wants to open the modal. */
  onOpenModelPicker: (currentValue: string, onPick: (v: string) => void) => void;
};

const HIDDEN_FIELDS = new Set(["type", "name"]);

function schemaTypeOf(schema: BlockParamSchema): string {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type))
    return schema.type.find((t) => t !== "null") || "string";
  if (schema.anyOf) {
    const nonNull = schema.anyOf.find((s) => s.type && s.type !== "null");
    if (nonNull?.type) return nonNull.type;
  }
  return "string";
}

function modelIdLikely(key: string, schema: BlockParamSchema): boolean {
  if (/model_id$/i.test(key)) return true;
  const desc = String(schema.description || "").toLowerCase();
  return /model id|model_id/.test(desc);
}

// ---- Slider widget ----------------------------------------------------

function NumberField({
  value,
  onChange,
  schema,
  isInt,
}: {
  value: number | "" | undefined;
  onChange: (v: number | "") => void;
  schema: BlockParamSchema;
  isInt: boolean;
}) {
  const hasRange =
    typeof schema.minimum === "number" && typeof schema.maximum === "number";
  const step = isInt ? 1 : 0.01;
  return (
    <div className={`number-field ${hasRange ? "with-slider" : ""}`}>
      {hasRange && (
        <input
          type="range"
          min={schema.minimum}
          max={schema.maximum}
          step={step}
          value={value === "" || value == null ? schema.minimum! : value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
      <input
        type="number"
        step={step}
        min={schema.minimum}
        max={schema.maximum}
        value={value ?? ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? "" : Number(e.target.value))
        }
      />
    </div>
  );
}

// ---- Chip multi-select ------------------------------------------------

function ChipMultiSelect({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  const add = (v: string) => {
    const trim = v.trim();
    if (!trim || value.includes(trim)) return;
    onChange([...value, trim]);
  };
  return (
    <div className="chip-input">
      <div className="chips">
        {value.map((v) => (
          <span className="chip" key={v}>
            {v}
            <button
              onClick={() => onChange(value.filter((x) => x !== v))}
              title="Remove"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              if (draft) {
                add(draft);
                setDraft("");
              }
            }
            if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => {
            if (draft) {
              add(draft);
              setDraft("");
            }
          }}
          placeholder={value.length === 0 ? "Type and press Enter" : ""}
        />
      </div>
      {suggestions && suggestions.length > 0 && (
        <div className="chip-suggestions">
          {suggestions
            .filter((s) => !value.includes(s))
            .slice(0, 10)
            .map((s) => (
              <button key={s} onClick={() => add(s)}>
                + {s}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ---- Dict / object editor --------------------------------------------
//
// Roboflow blocks frequently declare `dict[str, str]` params (class
// mappings, label remaps, prompt dictionaries). The Inspector used to
// render those as a plain text input, so users typed a single string
// and the engine rejected it with `Input should be a valid dictionary`.
// This editor edits the dict as an array of {key, value} pairs and
// writes back a real `Record<string, string>`.

function DictEditor({
  value,
  onChange,
  valueKind,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
  /** Narrows the value-side input: "string" keeps it a text input. */
  valueKind: "string" | "any";
}) {
  const pairs = Object.entries(value || {});
  const updatePairs = (next: Array<[string, unknown]>) => {
    if (next.length === 0) return onChange(undefined);
    const out: Record<string, unknown> = {};
    for (const [k, v] of next) {
      if (k.trim() === "") continue;
      out[k] = v;
    }
    onChange(Object.keys(out).length === 0 ? undefined : out);
  };

  return (
    <div className="dict-editor">
      {pairs.length === 0 && (
        <div className="empty">
          No entries. Add a key/value pair below.
        </div>
      )}
      {pairs.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <input
            className="k"
            value={k}
            placeholder="key"
            onChange={(e) => {
              const next = [...pairs];
              next[i] = [e.target.value, v];
              updatePairs(next);
            }}
          />
          <span className="arrow">→</span>
          <input
            className="v"
            value={typeof v === "string" ? v : JSON.stringify(v)}
            placeholder={valueKind === "string" ? "value" : "value (string or JSON)"}
            onChange={(e) => {
              const next = [...pairs];
              let parsed: unknown = e.target.value;
              if (valueKind !== "string") {
                try {
                  parsed = JSON.parse(e.target.value);
                } catch {
                  parsed = e.target.value;
                }
              }
              next[i] = [k, parsed];
              updatePairs(next);
            }}
          />
          <button
            className="rm"
            title="Remove"
            onClick={() => updatePairs(pairs.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="add-pair"
        onClick={() => updatePairs([...pairs, ["", ""]])}
      >
        + Add entry
      </button>
    </div>
  );
}

// ---- Reference option type + combobox --------------------------------

type RefOption = {
  label: string;
  value: string;
  kinds: Set<string>;
  source: "input" | "step";
  // For step outputs: a visual badge like "img" / "pred" / "mask".
  kindHint?: string;
};

// Short human label for common kind names — so a chip reads
// "$steps.sam.predictions · mask" instead of "instance_segmentation_prediction".
function shortKind(kinds: Set<string>): string {
  const known: Array<[RegExp, string]> = [
    [/^image$/, "image"],
    [/^video_metadata$/, "video"],
    [/segmentation/, "mask"],
    [/keypoint/, "keypoints"],
    [/object_detection/, "bbox"],
    [/classification/, "class"],
    [/embedding/, "vec"],
    [/^string$/, "str"],
    [/^float$|^integer$|^number$|^boolean$/, "num"],
    [/prediction/, "pred"],
    [/list/, "list"],
    [/dict/, "dict"],
  ];
  for (const k of kinds) {
    for (const [re, label] of known) {
      if (re.test(k)) return label;
    }
  }
  const first = kinds.values().next().value;
  return first ? String(first).slice(0, 8) : "";
}

function RefCombobox({
  value,
  onChange,
  options,
  acceptedKinds,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: RefOption[];
  /** If non-empty, filter suggestions to entries whose kinds overlap. */
  acceptedKinds?: Set<string>;
  placeholder?: string;
}) {
  const listId = useMemo(
    () => `ref-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );
  const filtered = useMemo(() => {
    if (!acceptedKinds || acceptedKinds.size === 0) return options;
    return options.filter((o) => {
      if (o.kinds.size === 0) return true; // unknown kinds → allow
      for (const k of o.kinds) if (acceptedKinds.has(k)) return true;
      return false;
    });
  }, [options, acceptedKinds]);

  const [dragOver, setDragOver] = useState(false);

  return (
    <div className="ref-picker">
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || "$inputs.image or $steps.other.predictions"}
        className={dragOver ? "drop-target" : ""}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes("text/flyt-ref")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const v = e.dataTransfer.getData("text/flyt-ref");
          if (v) onChange(v);
        }}
      />
      <datalist id={listId}>
        {filtered.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </datalist>
      {filtered.length > 0 && (
        <div className="ref-chips">
          {filtered.slice(0, 12).map((o) => (
            <button
              key={o.value}
              className={`ref-chip src-${o.source}${value === o.value ? " active" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/flyt-ref", o.value);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onChange(o.value)}
              title={`${o.label}${o.kinds.size ? "\nkinds: " + [...o.kinds].join(", ") : ""}`}
            >
              <span className="ref-ico">{o.source === "input" ? "⬡" : "▸"}</span>
              <span className="ref-label">{o.label}</span>
              {o.kindHint && <span className="ref-kind">{o.kindHint}</span>}
            </button>
          ))}
          {filtered.length > 12 && (
            <span className="ref-more">+{filtered.length - 12} more</span>
          )}
        </div>
      )}
    </div>
  );
}

// A narrow, collapsible "use a reference" strip rendered under literal
// widgets (number slider, chip input, etc.) when the field *also* accepts
// a selector. It keeps the literal path as the default but makes "wire
// this to an input / previous step" discoverable with a single click.
function RefSuggestionStrip({
  options,
  acceptedKinds,
  onPick,
  defaultOpen,
}: {
  options: RefOption[];
  acceptedKinds?: Set<string>;
  onPick: (v: string) => void;
  /** Starts expanded when true — use for empty fields so the chips
   *  are visible without an extra click. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const filtered = useMemo(() => {
    if (!acceptedKinds || acceptedKinds.size === 0) return options;
    return options.filter((o) => {
      if (o.kinds.size === 0) return true;
      for (const k of o.kinds) if (acceptedKinds.has(k)) return true;
      return false;
    });
  }, [options, acceptedKinds]);

  if (filtered.length === 0) return null;
  return (
    <div className={`ref-strip ${open ? "open" : ""}`}>
      <button
        className="ref-strip-toggle"
        onClick={() => setOpen((x) => !x)}
        title="Use a reference instead of a literal value"
      >
        <span className="link-ico">🔗</span>
        Use reference
        <span className="count">· {filtered.length}</span>
      </button>
      {open && (
        <div className="ref-chips">
          {filtered.slice(0, 12).map((o) => (
            <button
              key={o.value}
              className={`ref-chip src-${o.source}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/flyt-ref", o.value);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onPick(o.value)}
              title={o.label}
            >
              <span className="ref-ico">{o.source === "input" ? "⬡" : "▸"}</span>
              <span className="ref-label">{o.label}</span>
              {o.kindHint && <span className="ref-kind">{o.kindHint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Main inspector ---------------------------------------------------

export function Inspector({ node, onChange, allNodes, edges, kindsConnections, onOpenModelPicker }: Props) {
  // All hooks at top to satisfy the Rules of Hooks — even though some
  // branches below early-return before using them, React still needs a
  // stable hook order across renders.
  const [showAdditional, setShowAdditional] = useState(false);
  if (!node) {
    return (
      <div className="inspector">
        <div className="empty-inspector">
          Drag a block from the palette or click the <b>+</b> button on any
          edge. Click a node on the canvas to edit its configuration.
        </div>
      </div>
    );
  }

  const d = node.data;

  // --- Input node (unchanged shape from phase A) --------------------

  if (d.kind === "input") {
    return (
      <div className="inspector">
        <h3>{d.inputType === "WorkflowImage" ? "Image Input" : "Parameter Input"}</h3>
        <div className="hint">
          Declares an input to the workflow. Reference it from any step
          param as <code>$inputs.{d.inputName}</code>.
        </div>

        <div className="field">
          <label>name *</label>
          <input
            value={d.inputName || ""}
            onChange={(e) =>
              onChange({ ...d, inputName: e.target.value.replace(/[^a-z0-9_]/gi, "_") })
            }
          />
        </div>

        <div className="field">
          <label>type</label>
          <select
            value={d.inputType}
            onChange={(e) =>
              onChange({
                ...d,
                inputType: e.target.value as "WorkflowImage" | "WorkflowParameter",
              })
            }
          >
            <option value="WorkflowImage">WorkflowImage</option>
            <option value="WorkflowParameter">WorkflowParameter</option>
          </select>
        </div>

        {d.inputType === "WorkflowParameter" && (
          <div className="field">
            <label>default</label>
            <input
              value={d.inputDefault || ""}
              onChange={(e) => onChange({ ...d, inputDefault: e.target.value })}
              placeholder="(optional)"
            />
            <div className="hint">
              Used when the caller doesn't supply this input.
            </div>
          </div>
        )}
      </div>
    );
  }

  // --- Output node --------------------------------------------------

  if (d.kind === "output") {
    const stepOptions = allNodes
      .filter((n) => n.data.kind === "step")
      .map((n) => n.data.stepName!)
      .filter(Boolean);
    return (
      <div className="inspector">
        <h3>Output</h3>
        <div className="hint">
          Exposed as a top-level field in the <code>/infer/workflows</code>
          response. Connect a step to this node, or type a selector manually.
        </div>

        <div className="field">
          <label>name *</label>
          <input
            value={d.outputName || ""}
            onChange={(e) =>
              onChange({
                ...d,
                outputName: e.target.value.replace(/[^a-z0-9_]/gi, "_"),
              })
            }
          />
        </div>

        <div className="field">
          <label>selector</label>
          <input
            list="flyt-sel-options"
            value={d.outputSelector || ""}
            onChange={(e) => onChange({ ...d, outputSelector: e.target.value })}
            placeholder="(auto from incoming edge)"
          />
          <datalist id="flyt-sel-options">
            {stepOptions.map((s) => (
              <option key={s} value={`$steps.${s}.*`} />
            ))}
            {stepOptions.map((s) => (
              <option key={`p-${s}`} value={`$steps.${s}.predictions`} />
            ))}
          </datalist>
          <div className="hint">
            Leave empty to auto-derive from the connected step.
          </div>
        </div>
      </div>
    );
  }

  // --- Step node ----------------------------------------------------

  const schema = d.block?.block_schema;
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);

  const keys = Object.keys(props).filter((k) => !HIDDEN_FIELDS.has(k));
  const requiredKeys = keys.filter((k) => required.has(k)).sort();
  const additionalKeys = keys.filter((k) => !required.has(k)).sort();

  const inCount = edges.filter((e) => e.target === node.id).length;
  const outCount = edges.filter((e) => e.source === node.id).length;

  const setParam = (k: string, v: unknown) => {
    const next = { ...(d.params || {}) };
    if (v === "" || v === undefined || (Array.isArray(v) && v.length === 0)) {
      delete next[k];
    } else {
      next[k] = v;
    }
    onChange({ ...d, params: next });
  };

  // Build ref options from all other nodes in the graph.
  const inputNodes = allNodes.filter((n) => n.data.kind === "input");
  const otherSteps = allNodes.filter(
    (n) => n.data.kind === "step" && n.id !== node.id,
  );

  const refOptions = useMemo(() => {
    const opts: RefOption[] = [];
    for (const n of inputNodes) {
      if (!n.data.inputName) continue;
      const kinds = new Set<string>();
      if (n.data.inputType === "WorkflowImage") kinds.add("image");
      // Parameters are untyped — leave kinds empty so they match anything.
      opts.push({
        label: `$inputs.${n.data.inputName}`,
        value: `$inputs.${n.data.inputName}`,
        kinds,
        source: "input",
      });
    }
    for (const n of otherSteps) {
      if (!n.data.stepName) continue;
      const outs = outputsByName(n.data.block);
      const entries = Object.keys(outs);
      if (entries.length === 0) {
        opts.push({
          label: `$steps.${n.data.stepName}.* (any)`,
          value: `$steps.${n.data.stepName}.*`,
          kinds: new Set(),
          source: "step",
        });
        continue;
      }
      for (const outName of entries) {
        const kinds = outs[outName];
        opts.push({
          label: `$steps.${n.data.stepName}.${outName}`,
          value: `$steps.${n.data.stepName}.${outName}`,
          kinds,
          source: "step",
          kindHint: shortKind(kinds),
        });
      }
    }
    return opts;
  }, [inputNodes, otherSteps]);

  const targetBlockId = d.block?.manifest_type_identifier ?? "";
  const acceptedKindsForField = (fieldName: string) =>
    acceptedKindsFor(targetBlockId, fieldName, kindsConnections);

  const renderField = (k: string) => {
    const ps = props[k];
    const t = schemaTypeOf(ps);
    const v = (d.params || {})[k];
    const ref = refInfoForSchema(ps);
    // Prefer schema-declared kinds first; fall back to kinds_connections
    // reverse-lookup for blocks that don't enumerate them in anyOf.
    const acceptedKinds =
      ref.kinds.size > 0 ? ref.kinds : acceptedKindsForField(k);
    const isRefValue = typeof v === "string" && v.startsWith("$");
    const label = (
      <label>
        {k}
        {required.has(k) ? " *" : ""}
      </label>
    );
    const hint = ps.description ? (
      <div className="hint">{ps.description.slice(0, 220)}</div>
    ) : null;

    // If the field is selector-only OR currently holds a selector value,
    // always render the reference picker. The RefCombobox handles both
    // typing a selector and clicking/dragging a suggestion chip.
    if (ref.refOnly || (ref.canRef && isRefValue)) {
      return (
        <div className="field" key={k}>
          <div className="field-label-row">
            {label}
            {ref.canRef && !ref.refOnly && (
              <button
                className="ref-toggle"
                onClick={() => setParam(k, undefined)}
                title="Clear and use a literal value"
              >
                × ref
              </button>
            )}
          </div>
          <RefCombobox
            value={(v as string) ?? ""}
            onChange={(next) => setParam(k, next)}
            options={refOptions}
            acceptedKinds={acceptedKinds}
          />
          {hint}
        </div>
      );
    }

    // Small helper — literal widgets below append a ref chip strip when
    // the field also accepts a selector, so a user can switch to "use
    // a reference" with one click without having to clear manually.
    //
    // Auto-open when the field is empty: users who've just landed on a
    // fresh field should see their wiring options immediately. Once
    // they've typed a literal value we collapse so the chips don't
    // fight for vertical space.
    const fieldIsEmpty =
      v === undefined ||
      v === "" ||
      v === null ||
      (Array.isArray(v) && v.length === 0);
    const refSwitcher = ref.canRef ? (
      <RefSuggestionStrip
        options={refOptions}
        acceptedKinds={acceptedKinds}
        onPick={(next) => setParam(k, next)}
        defaultOpen={fieldIsEmpty}
      />
    ) : null;

    // Array of strings (class filter etc.) — chip multi-select.
    const itemsType =
      typeof ps.items === "object" && ps.items
        ? (ps.items as BlockParamSchema).type
        : undefined;
    if (t === "array" && (itemsType === "string" || itemsType == null)) {
      const itemsEnum =
        typeof ps.items === "object" && ps.items
          ? ((ps.items as BlockParamSchema).enum as string[] | undefined)
          : undefined;
      const arr = Array.isArray(v) ? (v as string[]) : [];
      return (
        <div className="field" key={k}>
          {label}
          <ChipMultiSelect
            value={arr}
            onChange={(next) => setParam(k, next)}
            suggestions={itemsEnum}
          />
          {hint}
          {refSwitcher}
        </div>
      );
    }

    // Enum → select.
    if (Array.isArray(ps.enum) && ps.enum.length > 0) {
      return (
        <div className="field" key={k}>
          {label}
          <select
            value={(v as string) ?? ""}
            onChange={(e) => setParam(k, e.target.value)}
          >
            <option value="">(unset)</option>
            {ps.enum.map((o) => (
              <option key={String(o)} value={String(o)}>
                {String(o)}
              </option>
            ))}
          </select>
          {hint}
          {refSwitcher}
        </div>
      );
    }

    // Boolean → pill toggle.
    if (t === "boolean") {
      const cur = v === true ? "true" : v === false ? "false" : "";
      return (
        <div className="field" key={k}>
          {label}
          <div className="pill-toggle">
            {(["true", "false", ""] as const).map((opt) => (
              <button
                key={opt || "unset"}
                className={cur === opt ? "active" : ""}
                onClick={() =>
                  setParam(k, opt === "true" ? true : opt === "false" ? false : undefined)
                }
              >
                {opt || "unset"}
              </button>
            ))}
          </div>
          {hint}
          {refSwitcher}
        </div>
      );
    }

    // Number / integer.
    if (t === "integer" || t === "number") {
      return (
        <div className="field" key={k}>
          {label}
          <NumberField
            value={(v as number) ?? ""}
            onChange={(n) => setParam(k, n)}
            schema={ps}
            isInt={t === "integer"}
          />
          {hint}
          {refSwitcher}
        </div>
      );
    }

    // Model-id field — attach a "Browse" button that opens the modal.
    if (modelIdLikely(k, ps)) {
      const current = (v as string) ?? "";
      return (
        <div className="field" key={k}>
          {label}
          <div className="with-button">
            <input
              type="text"
              value={current}
              onChange={(e) => setParam(k, e.target.value)}
              placeholder="model-id / family/version"
            />
            <button
              className="btn"
              onClick={() =>
                onOpenModelPicker(current, (next) => setParam(k, next))
              }
              title="Browse models"
            >
              Browse
            </button>
          </div>
          {hint}
          {refSwitcher}
        </div>
      );
    }

    // Object / dict (e.g. class_mapping: dict[str, str]).
    if (t === "object") {
      const ap = (ps as any).additionalProperties;
      const valueType =
        typeof ap === "object" && ap && ap.type === "string" ? "string" : "any";
      return (
        <div className="field" key={k}>
          {label}
          <DictEditor
            value={(v as Record<string, unknown>) ?? undefined}
            onChange={(next) => setParam(k, next)}
            valueKind={valueType as "string" | "any"}
          />
          {hint}
          {refSwitcher}
        </div>
      );
    }

    // Plain string. The refSwitcher below gives this the same "click a
    // chip to make it a reference" affordance as the typed widgets.
    return (
      <div className="field" key={k}>
        {label}
        <input
          type="text"
          value={(v as string) ?? ""}
          onChange={(e) => setParam(k, e.target.value)}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes("text/flyt-ref")) {
              e.preventDefault();
            }
          }}
          onDrop={(e) => {
            const dropped = e.dataTransfer.getData("text/flyt-ref");
            if (dropped) {
              e.preventDefault();
              setParam(k, dropped);
            }
          }}
        />
        {hint}
        {refSwitcher}
      </div>
    );
  };

  return (
    <div className="inspector">
      <h3>
        {d.block!.human_friendly_block_name || d.block!.manifest_type_identifier}
      </h3>
      <div className="conn-summary">
        <span>
          <span className="dot in" /> {inCount} input{inCount === 1 ? "" : "s"}
        </span>
        <span>
          <span className="dot out" /> {outCount} output{outCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="hint block-id">{d.block!.manifest_type_identifier}</div>

      <div className="field">
        <label>step name</label>
        <input
          value={d.stepName || ""}
          onChange={(e) =>
            onChange({
              ...d,
              stepName: e.target.value.replace(/[^a-z0-9_]/gi, "_"),
            })
          }
        />
        <div className="hint">
          Reference as <code>$steps.{d.stepName}.*</code>
        </div>
      </div>

      {requiredKeys.length === 0 && additionalKeys.length === 0 && (
        <div className="empty-inspector">
          This block has no configurable params.
        </div>
      )}

      {requiredKeys.length > 0 && (
        <div className="field-group">
          <div className="group-title">Required</div>
          {requiredKeys.map(renderField)}
        </div>
      )}

      {additionalKeys.length > 0 && (
        <div className="field-group">
          <button
            className="group-title expandable"
            onClick={() => setShowAdditional((x) => !x)}
          >
            <span>Additional Properties · {additionalKeys.length}</span>
            <span className="chev">{showAdditional ? "▾" : "▸"}</span>
          </button>
          {showAdditional && additionalKeys.map(renderField)}
        </div>
      )}
    </div>
  );
}
