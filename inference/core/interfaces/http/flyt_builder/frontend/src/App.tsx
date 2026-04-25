import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  addEdge,
  Background,
  BackgroundVariant,
  Connection,
  Controls,
  Edge,
  EdgeLabelRenderer,
  EdgeProps,
  getBezierPath,
  Handle,
  Node,
  NodeProps,
  Position,
  ReactFlowInstance,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  BlockDef,
  BlocksDescribeResponse,
  describeBlocks,
  downloadBundle,
  loadWorkflowMeta,
  publishWorkflow,
  saveWorkflow,
} from "./api";
import {
  FlytNodeData,
  WorkflowIssues,
  autoWireFields,
  compileWorkflow,
  defaultDataForBlock,
  nameOf,
  outputsByName,
  validateRequiredFields,
  validateWorkflow,
} from "./compile";
import { FloatingInspector } from "./FloatingInspector";
import { Palette } from "./Palette";
import { Dashboard } from "./Dashboard";
import { BlockPickerModal, InlineBlockPicker } from "./BlockPicker";
import { ModelPicker } from "./ModelPicker";
import { RunPanel, InputDef, InputSource } from "./RunPanel";
import { VersionHistory } from "./VersionHistory";
import { Resizer } from "./Resizer";
import { layoutVertical } from "./layout";
import {
  BudgetEstimate,
  DEFAULT_BUDGET_MB,
  estimateWorkflowVram,
  formatVram,
  severityFor,
} from "./budget";
import flytbaseMotif from "./assets/flytbase-motif.svg";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; msg: string }
  | { kind: "ok"; msg: string }
  | { kind: "err"; msg: string };

// ---- Node component -----------------------------------------------------

function FbNode({ id, data, selected }: NodeProps<FlytNodeData>) {
  const rf = useReactFlow();
  // Drag emitter: when a user drags the grip out of a node, the Inspector
  // picks it up via `text/flyt-ref` and fills the target field.
  const refForThisNode = (): string | null => {
    if (data.kind === "input" && data.inputName) {
      return `$inputs.${data.inputName}`;
    }
    if (data.kind === "step" && data.stepName) {
      return `$steps.${data.stepName}.*`;
    }
    return null;
  };
  const onGripDragStart = (e: React.DragEvent) => {
    const ref = refForThisNode();
    if (!ref) return;
    e.dataTransfer.setData("text/flyt-ref", ref);
    e.dataTransfer.effectAllowed = "copy";
    e.stopPropagation();
  };

  if (data.kind === "input") {
    const color = data.inputType === "WorkflowImage" ? "#22c55e" : "#8b5cf6";
    return (
      <div
        className={`custom-node input-node ${selected ? "selected" : ""}`}
        style={{ borderColor: color }}
      >
        <div className="title" style={{ color, borderBottomColor: color }}>
          {data.inputType === "WorkflowImage" ? "▶ Image Input" : "▶ Param Input"}
          <span
            className="drag-grip"
            draggable
            onDragStart={onGripDragStart}
            title="Drag into an Inspector field to wire this input"
          >
            ⠿
          </span>
        </div>
        <div className="body">
          <div className="id">{data.inputName}</div>
          <div className="sub">$inputs.{data.inputName}</div>
        </div>
        <Handle
          type="source"
          position={Position.Bottom}
          style={{ background: color }}
        />
      </div>
    );
  }
  if (data.kind === "output") {
    return (
      <div
        className={`custom-node output-node ${selected ? "selected" : ""}`}
        style={{ borderColor: "#ef4444" }}
      >
        <Handle
          type="target"
          position={Position.Top}
          style={{ background: "#ef4444" }}
        />
        <div className="title" style={{ color: "#ef4444", borderBottomColor: "#ef4444" }}>
          ◀ Output
        </div>
        <div className="body">
          <div className="id">{data.outputName}</div>
          <div className="sub">{data.outputSelector || "(auto)"}</div>
        </div>
      </div>
    );
  }

  const duplicate = () => {
    const node = rf.getNode(id);
    if (!node) return;
    const newId = `n${Date.now()}`;
    rf.addNodes({
      ...node,
      id: newId,
      selected: true,
      position: {
        x: node.position.x + 40,
        y: node.position.y + 40,
      },
      data: {
        ...node.data,
        stepName: `${node.data.stepName}_copy`,
      },
    });
  };
  const remove = () => {
    rf.deleteElements({ nodes: [{ id }] });
  };

  const issues = data.issues || [];
  const hasErrors = issues.some((i) => i.severity === "error");
  const issueTooltip = issues.length
    ? issues
        .slice(0, 4)
        .map((i) => (i.field ? `${i.field}: ${i.message}` : i.message))
        .join("\n") +
      (issues.length > 4 ? `\n…and ${issues.length - 4} more` : "")
    : undefined;

  return (
    <div
      className={`custom-node step-node ${selected ? "selected" : ""} ${hasErrors ? "has-errors" : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="node-toolbar">
        <span
          className="drag-grip"
          draggable
          onDragStart={onGripDragStart}
          title="Drag into an Inspector field to use this step's output"
        >
          ⠿
        </span>
        <button onClick={duplicate} title="Duplicate">⧉</button>
        <button onClick={remove} title="Delete">×</button>
      </div>
      {issues.length > 0 && (
        <div
          className={`issue-badge ${hasErrors ? "err" : "warn"}`}
          title={issueTooltip}
          aria-label={`${issues.length} issue${issues.length === 1 ? "" : "s"}`}
        >
          {hasErrors ? "!" : "?"} {issues.length}
        </div>
      )}
      <div className="title">
        {data.block!.human_friendly_block_name || data.block!.manifest_type_identifier}
      </div>
      <div className="body">
        <div className="id">{data.stepName}</div>
        <div className="sub">{data.block!.manifest_type_identifier}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// ---- Custom edge with inline "+" button --------------------------------

function PlusEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerEnd,
    style,
    data,
  } = props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <path id={id} className="react-flow__edge-path" d={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          className="edge-plus-wrap"
          style={{
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
          }}
        >
          <button
            className="edge-plus"
            onClick={(e) => {
              e.stopPropagation();
              (data as any)?.onPlus?.({ x: e.clientX, y: e.clientY, edgeId: id });
            }}
            title="Insert a block here"
          >
            +
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { fb: FbNode };
const edgeTypes = { plus: PlusEdge };

// ---- Spec hydration ----------------------------------------------------

function rehydrate(
  spec: any,
  blocks: BlockDef[],
  startCounter: number,
): { nodes: Node<FlytNodeData>[]; edges: Edge[]; nextCounter: number } {
  const newNodes: Node<FlytNodeData>[] = [];
  const newEdges: Edge[] = [];
  const nameToId: Record<string, string> = {};
  let counter = startCounter;
  const mkId = () => {
    counter += 1;
    return `n${counter}`;
  };

  (spec?.inputs || []).forEach((inp: any) => {
    const id = mkId();
    newNodes.push({
      id,
      type: "fb",
      position: { x: 0, y: 0 },
      data: {
        kind: "input",
        inputName: inp.name,
        inputType: inp.type === "WorkflowImage" ? "WorkflowImage" : "WorkflowParameter",
        inputDefault: inp.default_value ?? "",
        testValue: inp.__testValue ?? undefined,
      },
    });
    nameToId[`$inputs.${inp.name}`] = id;
  });

  (spec?.steps || []).forEach((step: any) => {
    const def = blocks.find((b) => b.manifest_type_identifier === step.type);
    if (!def) return;
    const { type: _type, name, ...params } = step;
    const id = mkId();
    newNodes.push({
      id,
      type: "fb",
      position: { x: 0, y: 0 },
      data: { kind: "step", block: def, stepName: name, params },
    });
    nameToId[`$steps.${name}`] = id;
  });

  (spec?.outputs || []).forEach((out: any) => {
    const id = mkId();
    newNodes.push({
      id,
      type: "fb",
      position: { x: 0, y: 0 },
      data: {
        kind: "output",
        outputName: out.name,
        outputSelector: out.selector || "",
      },
    });
    const sel: string = out.selector || "";
    const mRef = sel.match(/^\$(steps|inputs)\.([^.]+)/);
    if (mRef) {
      const key = `$${mRef[1]}.${mRef[2]}`;
      const srcId = nameToId[key];
      if (srcId) {
        newEdges.push({
          id: `e-${srcId}-${id}`,
          source: srcId,
          target: id,
          type: "plus",
          animated: true,
        });
      }
    }
  });

  for (const n of newNodes) {
    if (n.data.kind !== "step") continue;
    for (const v of Object.values(n.data.params || {})) {
      if (typeof v !== "string") continue;
      const m = v.match(/^\$(inputs|steps)\.([^.*]+)/);
      if (!m) continue;
      const key = `$${m[1]}.${m[2]}`;
      const srcId = nameToId[key];
      if (srcId && srcId !== n.id) {
        const edgeId = `e-${srcId}-${n.id}`;
        if (!newEdges.some((e) => e.id === edgeId)) {
          newEdges.push({
            id: edgeId,
            source: srcId,
            target: n.id,
            type: "plus",
            animated: true,
          });
        }
      }
    }
  }

  return { nodes: newNodes, edges: newEdges, nextCounter: counter };
}

function formatAgo(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 5_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

// Build a map blockId → accepts-these-kinds sets of ids that would be
// compatible as the *next* block in a chain. Used by InlineBlockPicker.
function buildCompatibleIdSet(
  kindsConnections: BlocksDescribeResponse["kinds_connections"] | undefined,
  sourceKinds: Set<string>,
): Set<string> | null {
  if (!kindsConnections || sourceKinds.size === 0) return null;
  const ids = new Set<string>();
  for (const k of sourceKinds) {
    const conns = kindsConnections[k] || [];
    for (const c of conns) ids.add(c.manifest_type_identifier);
  }
  return ids;
}

// ---- Builder component ------------------------------------------------

type BuilderProps = {
  workflowId: string;
  onBack: () => void;
};

function BuilderInner({ workflowId, onBack }: BuilderProps) {
  const [blocks, setBlocks] = useState<BlockDef[]>([]);
  const [kindsConnections, setKindsConnections] = useState<
    BlocksDescribeResponse["kinds_connections"] | undefined
  >(undefined);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlytNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<{ onPlus?: any }>([]);
  const [selected, setSelected] = useState<Node<FlytNodeData> | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  const nodeIdCounter = useRef(0);
  const [hydrated, setHydrated] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedSpecJson, setSavedSpecJson] = useState<string | null>(null);
  const [, setNowTick] = useState(0);
  const [runOpen, setRunOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRefreshTok, setHistoryRefreshTok] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [inlinePicker, setInlinePicker] = useState<{
    anchor: { x: number; y: number };
    compatibleIds: Set<string> | null;
    hint?: string;
    /** Edge id if originated from an edge click. */
    edgeId?: string;
    /** Source node id for handle-originated pickers. */
    sourceNodeId?: string;
  } | null>(null);
  const [modelPicker, setModelPicker] = useState<{
    value: string;
    onPick: (v: string) => void;
  } | null>(null);
  const [autoWire, setAutoWire] = useState(true);

  // Resizable panel widths, persisted so reloading keeps the user's
  // layout. Tuned defaults: palette wide enough to show category names
  // at a glance, run panel wide enough to host per-input cards.
  const [paletteW, setPaletteW] = useState<number>(() => {
    const v = Number(localStorage.getItem("flyt.layout.paletteW"));
    return Number.isFinite(v) && v >= 180 ? v : 320;
  });
  const [rightW, setRightW] = useState<number>(() => {
    const v = Number(localStorage.getItem("flyt.layout.rightW"));
    return Number.isFinite(v) && v >= 280 ? v : 440;
  });
  useEffect(() => {
    localStorage.setItem("flyt.layout.paletteW", String(paletteW));
  }, [paletteW]);
  useEffect(() => {
    localStorage.setItem("flyt.layout.rightW", String(rightW));
  }, [rightW]);
  const [version, setVersion] = useState<number>(1);
  const [runSources, setRunSources] = useState<Record<string, InputSource>>({});

  useEffect(() => {
    const t = window.setInterval(() => setNowTick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    setStatus({ kind: "busy", msg: "Loading blocks…" });
    describeBlocks()
      .then((d) => {
        setBlocks(d.blocks || []);
        setKindsConnections(d.kinds_connections);
        setStatus({ kind: "ok", msg: `${(d.blocks || []).length} blocks loaded` });
      })
      .catch((e) => setStatus({ kind: "err", msg: `Block load failed: ${e}` }));
  }, []);

  useEffect(() => {
    if (!blocks.length || hydrated) return;
    let cancelled = false;
    (async () => {
      try {
        const meta = await loadWorkflowMeta(workflowId);
        if (cancelled) return;
        setVersion(meta.version);
        const spec = meta.spec;
        if (spec && (spec.inputs || spec.steps || spec.outputs)) {
          const { nodes: n, edges: e, nextCounter } = rehydrate(
            spec,
            blocks,
            nodeIdCounter.current,
          );
          nodeIdCounter.current = nextCounter;
          const laidOut = layoutVertical(n, e);
          setNodes(laidOut);
          setEdges(e);
          setSavedSpecJson(JSON.stringify(spec));
          setSavedAt(Date.now());
          setStatus({
            kind: "ok",
            msg: `Loaded '${workflowId}' v${meta.version} (${n.length} nodes)`,
          });
        } else {
          setStatus({ kind: "ok", msg: `New workflow '${workflowId}'` });
        }
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (/\b404\b/.test(msg)) {
          if (!cancelled) setStatus({ kind: "ok", msg: `New workflow '${workflowId}'` });
        } else if (!cancelled) {
          setStatus({ kind: "err", msg: `Load failed: ${msg}` });
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blocks, hydrated, workflowId, setNodes, setEdges]);

  // ---- Graph mutators -----------------------------------------------

  const addNodeAtCenter = useCallback(
    (block: BlockDef): string => {
      const existingNames = nodes.map((n) => nameOf(n.data));
      const data = defaultDataForBlock(block, existingNames);
      nodeIdCounter.current += 1;
      const id = `n${nodeIdCounter.current}`;
      const vp = rfInstance?.getViewport?.();
      const center = rfInstance?.screenToFlowPosition
        ? rfInstance.screenToFlowPosition({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          })
        : { x: 200 + (vp?.x ?? 0), y: 200 + (vp?.y ?? 0) };
      setNodes((nds) =>
        nds.concat({
          id,
          type: "fb",
          position: center,
          data,
        }),
      );
      return id;
    },
    [nodes, rfInstance, setNodes],
  );

  const onDragStart = (event: React.DragEvent, block: BlockDef) => {
    event.dataTransfer.setData("application/flyt-block", JSON.stringify(block));
    event.dataTransfer.effectAllowed = "move";
  };

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      if (!rfInstance) return;
      const payload = event.dataTransfer.getData("application/flyt-block");
      if (!payload) return;
      const block: BlockDef = JSON.parse(payload);
      const position = rfInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      nodeIdCounter.current += 1;
      const id = `n${nodeIdCounter.current}`;
      const existingNames = nodes.map((n) => nameOf(n.data));
      const data = defaultDataForBlock(block, existingNames);
      setNodes((nds) => nds.concat({ id, type: "fb", position, data }));
    },
    [rfInstance, nodes, setNodes],
  );

  const onDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  // Auto-wire ref fields on new connections.
  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => addEdge({ ...params, type: "plus", animated: true }, eds));
      connectMadeRef.current = true;
      if (!autoWire) return;
      const src = nodes.find((n) => n.id === params.source);
      const tgt = nodes.find((n) => n.id === params.target);
      if (!src || !tgt) return;
      const fills = autoWireFields(src.data, tgt.data, kindsConnections);
      if (Object.keys(fills).length === 0) return;
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== tgt.id || n.data.kind !== "step") return n;
          return {
            ...n,
            data: {
              ...n.data,
              params: { ...(n.data.params || {}), ...fills },
            },
          };
        }),
      );
    },
    [autoWire, nodes, kindsConnections, setEdges, setNodes],
  );

  // Wire-drop-to-picker state. The callbacks that reference
  // `openInlinePicker` are defined further down, once that function
  // exists in lexical scope.
  const dragSourceRef = useRef<{ nodeId: string; handleType: "source" | "target" } | null>(null);
  const connectMadeRef = useRef(false);

  const onSelectionChange = useCallback(
    ({ nodes: ns }: { nodes: Node[] }) => {
      setSelected((ns[0] as Node<FlytNodeData>) || null);
    },
    [],
  );

  const updateSelected = useCallback(
    (next: FlytNodeData) => {
      if (!selected) return;
      setNodes((nds) =>
        nds.map((n) => (n.id === selected.id ? { ...n, data: next } : n)),
      );
      setSelected((s) => (s && s.id === selected.id ? { ...s, data: next } : s));
    },
    [selected, setNodes],
  );

  // Thread onPlus callback into every edge's data so the PlusEdge can
  // call it when the `+` button is clicked.
  const openInlinePicker = useCallback(
    (args: { x: number; y: number; edgeId?: string; sourceNodeId?: string }) => {
      // Determine compatible blocks based on upstream kinds.
      let srcKinds = new Set<string>();
      if (args.edgeId) {
        const ed = edges.find((e) => e.id === args.edgeId);
        if (ed) {
          const src = nodes.find((n) => n.id === ed.source);
          if (src?.data.kind === "step") {
            // Union of all of this step's output kinds.
            for (const s of Object.values(outputsByName(src.data.block))) {
              for (const k of s) srcKinds.add(k);
            }
          } else if (src?.data.kind === "input" && src.data.inputType === "WorkflowImage") {
            srcKinds.add("image");
          }
          args.sourceNodeId = src?.id;
        }
      } else if (args.sourceNodeId) {
        const src = nodes.find((n) => n.id === args.sourceNodeId);
        if (src?.data.kind === "step") {
          for (const s of Object.values(outputsByName(src.data.block))) {
            for (const k of s) srcKinds.add(k);
          }
        } else if (src?.data.kind === "input" && src.data.inputType === "WorkflowImage") {
          srcKinds.add("image");
        }
      }
      const compat = buildCompatibleIdSet(kindsConnections, srcKinds);
      setInlinePicker({
        anchor: { x: args.x, y: args.y },
        compatibleIds: compat,
        hint: [...srcKinds].slice(0, 4).join(", "),
        edgeId: args.edgeId,
        sourceNodeId: args.sourceNodeId,
      });
    },
    [edges, nodes, kindsConnections],
  );

  // Now that `openInlinePicker` is defined, wire up the ReactFlow
  // connect-start / connect-end hooks. A drag that ends on empty canvas
  // (react-flow__pane) opens the suggestive picker at the cursor with
  // the source node pre-wired.
  const onConnectStart = useCallback(
    (
      _e: any,
      params: { nodeId: string | null; handleType: "source" | "target" | null },
    ) => {
      if (!params.nodeId || !params.handleType) return;
      dragSourceRef.current = {
        nodeId: params.nodeId,
        handleType: params.handleType,
      };
      connectMadeRef.current = false;
    },
    [],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const source = dragSourceRef.current;
      dragSourceRef.current = null;
      if (!source) return;
      if (connectMadeRef.current) return;
      const target = event.target as HTMLElement | null;
      if (!target || !target.classList.contains("react-flow__pane")) return;
      const clientX =
        "clientX" in event
          ? event.clientX
          : (event as TouchEvent).changedTouches?.[0]?.clientX ?? 0;
      const clientY =
        "clientY" in event
          ? event.clientY
          : (event as TouchEvent).changedTouches?.[0]?.clientY ?? 0;
      if (source.handleType !== "source") return;
      openInlinePicker({
        x: clientX,
        y: clientY,
        sourceNodeId: source.nodeId,
      });
    },
    [openInlinePicker],
  );

  const edgesWithHandlers = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        type: "plus",
        data: {
          ...(e.data || {}),
          onPlus: (args: { x: number; y: number; edgeId: string }) =>
            openInlinePicker(args),
        },
      })),
    [edges, openInlinePicker],
  );

  // Compile the spec early — `nodesWithIssues`, `validity`, and the
  // budget all depend on it. The save/publish path below picks up the
  // same memoised value.
  const compiled = useMemo(
    () => compileWorkflow(nodes as Node<FlytNodeData>[], edges as Edge[]),
    [nodes, edges],
  );
  const compiledJson = useMemo(() => JSON.stringify(compiled), [compiled]);

  // VRAM estimate for the chip pill in the topbar. Re-walks the spec
  // on any node/edge change — the cost is trivial (linear in step
  // count). The breakdown popover reuses this value.
  const budget: BudgetEstimate = useMemo(
    () => estimateWorkflowVram(compiled),
    [compiled],
  );
  const budgetCap = ((window as any).__FLYBUILD__?.budget_mb as number) || DEFAULT_BUDGET_MB;
  const budgetSev = severityFor(budget.total_mb, budgetCap);
  const [budgetOpen, setBudgetOpen] = useState(false);

  // Inline validation: missing required fields + dangling refs. Drives
  // the red border + badge in FbNode, the Issues panel in the
  // inspector, and the topbar count chip.
  const validity: WorkflowIssues = useMemo(
    () => validateWorkflow(compiled, blocks),
    [compiled, blocks],
  );

  // Overlay per-step issues onto the React Flow node data so FbNode
  // can render the red border + count badge without re-running the
  // validator. New object identity only when validity actually
  // changes, so dragging nodes around doesn't re-render every node.
  const nodesWithIssues = useMemo(
    () =>
      nodes.map((n) => {
        const stepName = (n.data as FlytNodeData).stepName;
        const issues = stepName
          ? validity.byStep[stepName] || []
          : [];
        // Avoid creating a new object when nothing changed — keeps
        // React Flow's reconciliation cheap.
        const prevIssues = (n.data as FlytNodeData).issues || [];
        if (
          issues.length === prevIssues.length &&
          issues.every(
            (it, i) =>
              it.message === prevIssues[i]?.message &&
              it.field === prevIssues[i]?.field,
          )
        ) {
          return n;
        }
        return { ...n, data: { ...n.data, issues } as FlytNodeData };
      }),
    [nodes, validity],
  );

  const onPickInline = useCallback(
    (block: BlockDef) => {
      if (!inlinePicker) return;
      const existingNames = nodes.map((n) => nameOf(n.data));
      const fresh = defaultDataForBlock(block, existingNames);
      nodeIdCounter.current += 1;
      const id = `n${nodeIdCounter.current}`;

      // Resolve the source node (always present for the two insertion
      // modes the picker supports). We use it below to pre-fill any
      // compatible ref fields on the newly-inserted block so the user
      // doesn't have to go hunt for `image` / `predictions` manually.
      let sourceNodeData: FlytNodeData | undefined;
      if (inlinePicker.edgeId) {
        const ed = edges.find((e) => e.id === inlinePicker.edgeId);
        sourceNodeData = nodes.find((n) => n.id === ed?.source)?.data;
      } else if (inlinePicker.sourceNodeId) {
        sourceNodeData = nodes.find((n) => n.id === inlinePicker.sourceNodeId)
          ?.data;
      }

      const fills = sourceNodeData && autoWire
        ? autoWireFields(sourceNodeData, fresh, kindsConnections)
        : {};
      const data: FlytNodeData =
        fresh.kind === "step" && Object.keys(fills).length > 0
          ? { ...fresh, params: { ...(fresh.params || {}), ...fills } }
          : fresh;

      if (inlinePicker.edgeId) {
        const ed = edges.find((e) => e.id === inlinePicker.edgeId);
        if (!ed) return;
        const src = nodes.find((n) => n.id === ed.source);
        const tgt = nodes.find((n) => n.id === ed.target);
        const position = {
          x: ((src?.position.x ?? 0) + (tgt?.position.x ?? 0)) / 2,
          y: ((src?.position.y ?? 0) + (tgt?.position.y ?? 0)) / 2,
        };
        setNodes((nds) => nds.concat({ id, type: "fb", position, data }));
        setEdges((eds) => {
          const filtered = eds.filter((e) => e.id !== ed.id);
          return [
            ...filtered,
            {
              id: `e-${ed.source}-${id}`,
              source: ed.source,
              target: id,
              type: "plus",
              animated: true,
            },
            {
              id: `e-${id}-${ed.target}`,
              source: id,
              target: ed.target,
              type: "plus",
              animated: true,
            },
          ];
        });
      } else if (inlinePicker.sourceNodeId) {
        const src = nodes.find((n) => n.id === inlinePicker.sourceNodeId);
        const position = {
          x: src?.position.x ?? 0,
          y: (src?.position.y ?? 0) + 160,
        };
        setNodes((nds) => nds.concat({ id, type: "fb", position, data }));
        setEdges((eds) =>
          eds.concat({
            id: `e-${inlinePicker.sourceNodeId}-${id}`,
            source: inlinePicker.sourceNodeId!,
            target: id,
            type: "plus",
            animated: true,
          }),
        );
      }
      setInlinePicker(null);
    },
    [inlinePicker, nodes, edges, autoWire, kindsConnections, setNodes, setEdges],
  );

  // ---- Save / publish ---------------------------------------------

  const dirty = useMemo(() => {
    if (savedSpecJson == null) return nodes.length > 0 || edges.length > 0;
    return savedSpecJson !== compiledJson;
  }, [savedSpecJson, compiledJson, nodes.length, edges.length]);

  const onSave = useCallback(async () => {
    setStatus({ kind: "busy", msg: "Saving…" });
    try {
      await saveWorkflow(workflowId, compiled);
      setSavedSpecJson(compiledJson);
      setSavedAt(Date.now());
      setStatus({ kind: "ok", msg: `Saved '${workflowId}' v${version}` });
    } catch (e) {
      setStatus({ kind: "err", msg: `Save failed: ${e}` });
    }
  }, [workflowId, compiled, compiledJson, version]);

  const onPublish = useCallback(async () => {
    setStatus({ kind: "busy", msg: "Publishing…" });
    try {
      const { version: v } = await publishWorkflow(workflowId, compiled);
      setVersion(v);
      setSavedSpecJson(compiledJson);
      setSavedAt(Date.now());
      setHistoryRefreshTok((x) => x + 1);
      setStatus({ kind: "ok", msg: `Published v${v}` });
    } catch (e) {
      setStatus({ kind: "err", msg: `Publish failed: ${e}` });
    }
  }, [workflowId, compiled, compiledJson]);

  // Download the current published version as a .flyttmpl bundle. Hits
  // /bundle which assembles the zip on demand from the workflow's most
  // recent published version on disk.
  const onDownloadBundle = useCallback(async () => {
    setStatus({ kind: "busy", msg: "Bundling…" });
    try {
      const { filename, size } = await downloadBundle(workflowId);
      const kb = Math.max(1, Math.round(size / 1024));
      setStatus({ kind: "ok", msg: `Downloaded ${filename} (${kb} KB)` });
    } catch (e) {
      setStatus({ kind: "err", msg: `Bundle failed: ${e}` });
    }
  }, [workflowId]);

  // Re-hydrate graph when a version is restored in the history drawer.
  const onRestored = useCallback(
    async (newVersion: number) => {
      try {
        const meta = await loadWorkflowMeta(workflowId);
        setVersion(meta.version);
        const { nodes: n, edges: e, nextCounter } = rehydrate(
          meta.spec,
          blocks,
          nodeIdCounter.current,
        );
        nodeIdCounter.current = nextCounter;
        const laidOut = layoutVertical(n, e);
        setNodes(laidOut);
        setEdges(e);
        setSavedSpecJson(JSON.stringify(meta.spec));
        setSavedAt(Date.now());
        setHistoryRefreshTok((x) => x + 1);
        setStatus({ kind: "ok", msg: `Restored as v${newVersion}` });
      } catch (e) {
        setStatus({ kind: "err", msg: `Reload after restore failed: ${e}` });
      }
    },
    [blocks, setNodes, setEdges, workflowId],
  );

  const onArrange = useCallback(() => {
    setNodes((nds) =>
      layoutVertical(nds as Node<FlytNodeData>[], edges as Edge[]),
    );
  }, [edges, setNodes]);

  const onClear = useCallback(() => {
    if (nodes.length > 0 && !window.confirm("Clear the canvas? Unsaved changes will be lost.")) return;
    setNodes([]);
    setEdges([]);
    setSelected(null);
  }, [nodes.length, setNodes, setEdges]);

  // ---- Keyboard shortcuts -----------------------------------------

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in inputs.
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        if (e.key === "Escape") (target as HTMLInputElement).blur();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        setRunOpen(true);
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        setPickerOpen(true);
        return;
      }
      if (e.key === "Escape") {
        setPickerOpen(false);
        setInlinePicker(null);
        setModelPicker(null);
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selected) {
        e.preventDefault();
        setNodes((nds) => nds.filter((n) => n.id !== selected.id));
        setEdges((eds) =>
          eds.filter((e) => e.source !== selected.id && e.target !== selected.id),
        );
        setSelected(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selected) {
        e.preventDefault();
        const nid = `n${Date.now()}`;
        setNodes((nds) =>
          nds.concat({
            ...(selected as any),
            id: nid,
            position: {
              x: selected.position.x + 40,
              y: selected.position.y + 40,
            },
            selected: true,
          }),
        );
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected, setNodes, setEdges, onSave]);

  // beforeunload warning on dirty.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ---- Inputs for RunPanel ----------------------------------------

  const runInputs: InputDef[] = useMemo(() => {
    const seen = new Set<string>();
    const out: InputDef[] = [];
    for (const n of nodes) {
      if (n.data.kind !== "input") continue;
      const name = n.data.inputName;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        type: n.data.inputType || "WorkflowParameter",
        defaultValue: n.data.inputDefault,
      });
    }
    return out;
  }, [nodes]);

  // ---- Render ------------------------------------------------------

  return (
    <div className="app">
      <div className="topbar">
        <img
          src={flytbaseMotif}
          alt="FlytBase"
          className="brand-logo-motif"
          onClick={onBack}
          style={{ cursor: "pointer" }}
          title="Back to workflows"
        />
        <button
          className="btn back-btn"
          onClick={() => {
            if (dirty && !window.confirm("You have unsaved changes. Leave anyway?")) return;
            onBack();
          }}
          title="Back to workflows"
        >
          ← Workflows
        </button>
        <span className="sep">·</span>
        <span className="workflow-id" title={workflowId}>
          {workflowId}
        </span>
        <span className="version-badge" title="Current version">
          v{version}
        </span>
        {dirty && <span className="dirty-dot" title="Unsaved changes">●</span>}
        {!dirty && savedAt && (
          <span className="saved-ago" title={new Date(savedAt).toLocaleString()}>
            Saved {formatAgo(savedAt)}
          </span>
        )}
        <button
          className={`btn auto-toggle ${autoWire ? "on" : ""}`}
          onClick={() => setAutoWire((x) => !x)}
          title="Auto-wire ref fields on connect"
        >
          Auto-wire: {autoWire ? "on" : "off"}
        </button>
        <button className="btn" onClick={onArrange} title="Arrange (Dagre TB)">
          ⇅ Arrange
        </button>
        <button
          className="btn"
          onClick={() => setPickerOpen(true)}
          title="Add a block"
        >
          + Add Block
        </button>
        <button
          className="btn"
          onClick={() => setHistoryOpen((x) => !x)}
          title="Version history"
        >
          ⧗ History
        </button>
        {validity.total > 0 && (
          <button
            type="button"
            className={`issues-chip ${validity.byStep && Object.values(validity.byStep).some((arr) => arr.some((i) => i.severity === "error")) || validity.workflow.some((i) => i.severity === "error") ? "err" : "warn"}`}
            onClick={() => {
              // Click → focus the first node that has issues. Falls
              // through to scrolling to a workflow-level issue if all
              // issues are workflow-scoped.
              const firstStepWithIssues = nodes.find(
                (n) =>
                  (n.data as FlytNodeData).stepName &&
                  (validity.byStep[
                    (n.data as FlytNodeData).stepName!
                  ]?.length ?? 0) > 0,
              );
              if (firstStepWithIssues && rfInstance) {
                rfInstance.fitView({
                  nodes: [{ id: firstStepWithIssues.id }],
                  duration: 300,
                  padding: 0.4,
                });
                // Also select it so the inspector opens.
                setNodes((prev) =>
                  prev.map((n) => ({
                    ...n,
                    selected: n.id === firstStepWithIssues.id,
                  })),
                );
              }
            }}
            title={`${validity.total} issue${validity.total === 1 ? "" : "s"} — click to focus the first one`}
          >
            ⚠ {validity.total}
          </button>
        )}
        {budget.steps.length > 0 && (
          <div className="budget-wrap">
            <button
              className={`budget-pill ${budgetSev}`}
              onClick={() => setBudgetOpen((x) => !x)}
              title={
                budgetSev === "over"
                  ? `Over budget: ~${formatVram(budget.total_mb)} > ${formatVram(budgetCap)}. Edge devices will OOM.`
                  : budgetSev === "warn"
                    ? `Tight: ~${formatVram(budget.total_mb)} of ${formatVram(budgetCap)} budget`
                    : `Estimated VRAM. Click for breakdown.`
              }
            >
              ≈ {formatVram(budget.total_mb)}
              {budget.unknown_blocks.length > 0 && <span className="hint">?</span>}
            </button>
            {budgetOpen && (
              <div
                className="budget-popover"
                role="dialog"
                aria-label="VRAM breakdown"
              >
                <div className="hd">
                  <span>VRAM estimate</span>
                  <button className="x" onClick={() => setBudgetOpen(false)}>×</button>
                </div>
                <div className="rows">
                  {budget.steps.map((s) => (
                    <div className="row" key={s.step_name}>
                      <span className="name">{s.step_name}</span>
                      <span className="ty">
                        {s.model_id || s.block_type.split("/").pop() || s.block_type}
                      </span>
                      <span className={`mb ${s.is_estimate ? "est" : ""}`}>
                        {formatVram(s.mb)}
                        {s.is_estimate && "*"}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="ft">
                  <div className="total">
                    <span>Total</span>
                    <span className={budgetSev}>{formatVram(budget.total_mb)} / {formatVram(budgetCap)}</span>
                  </div>
                  {budget.unknown_blocks.length > 0 && (
                    <div className="note">
                      * estimated — block recipes for{" "}
                      {budget.unknown_blocks.slice(0, 3).join(", ")}
                      {budget.unknown_blocks.length > 3 ? ", …" : ""} not in cost
                      table. Total may be low.
                    </div>
                  )}
                  <div className="note muted">
                    Cap is the typical FlytBase edge device's GPU
                    headroom. Override via window.__FLYBUILD__.budget_mb.
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <button className="btn" onClick={onSave} disabled={!dirty}>
          Save
        </button>
        <button
          className="btn"
          onClick={onPublish}
          title="Snapshot current spec as a new version"
        >
          Publish
        </button>
        <button
          className="btn"
          onClick={onDownloadBundle}
          title="Download the current version as a .flyttmpl bundle (workflow spec + manifest)"
        >
          ⬇ .flyttmpl
        </button>
        <button className="btn" onClick={onClear}>
          Clear
        </button>
        <button
          className="btn primary"
          onClick={() => setRunOpen(true)}
          disabled={nodes.length === 0}
        >
          ▶ Run
        </button>
        <span
          className={`status ${status.kind === "ok" ? "ok" : status.kind === "err" ? "err" : status.kind === "busy" ? "busy" : ""}`}
        >
          {status.kind !== "idle" ? status.msg : ""}
        </span>
        <div className="spacer" />
        <a
          href="/build"
          className="compare"
          title="Open the upstream Roboflow iframe builder side-by-side"
        >
          Compare with /build ↗
        </a>
      </div>
      <div className="main">
        <div className="palette-wrap" style={{ width: paletteW }}>
          <Palette blocks={blocks} onDragStart={onDragStart} />
        </div>
        <Resizer width={paletteW} onChange={setPaletteW} side="left" />

        {historyOpen && (
          <VersionHistory
            workflowId={workflowId}
            onClose={() => setHistoryOpen(false)}
            onRestored={onRestored}
            refreshToken={historyRefreshTok}
          />
        )}

        <div className="canvas" onDrop={onDrop} onDragOver={onDragOver}>
          {validity.workflow.length > 0 && (
            <div className="workflow-issue-banner">
              {validity.workflow.map((it, i) => (
                <div key={i} className={`row ${it.severity}`}>
                  <span className="ico">
                    {it.severity === "error" ? "✕" : "⚠"}
                  </span>
                  <span>{it.message}</span>
                </div>
              ))}
            </div>
          )}
          <ReactFlow
            nodes={nodesWithIssues}
            edges={edgesWithHandlers as Edge[]}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onInit={setRfInstance}
            onSelectionChange={onSelectionChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={true}
            fitView
            attributionPosition="bottom-left"
            defaultEdgeOptions={{ type: "plus", animated: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#25324e" />
            <Controls />
          </ReactFlow>

          {nodes.length === 0 && (
            <div className="canvas-empty">
              <div className="hero">Empty canvas</div>
              <div className="sub">
                Drag a block from the left, press <kbd>/</kbd>, or click the
                button below.
              </div>
              <button className="btn primary" onClick={() => setPickerOpen(true)}>
                + Add Block
              </button>
            </div>
          )}

          {/* Floating inspector mounts inside the canvas area so its
              coords are relative to the viewport. Only renders when a
              node is selected and the Run panel isn't open (to avoid
              stacking two large panels). */}
          {!runOpen && (
            <FloatingInspector
              node={selected}
              onChange={updateSelected}
              allNodes={nodes as Node<FlytNodeData>[]}
              edges={edges as Edge[]}
              kindsConnections={kindsConnections}
              onOpenModelPicker={(value, onPick) =>
                setModelPicker({ value, onPick })
              }
              onClose={() => setSelected(null)}
              rfInstance={rfInstance}
            />
          )}
        </div>

        {runOpen && (
          <>
            <Resizer width={rightW} onChange={setRightW} side="right" />
            <div className="right-rail-wrap" style={{ width: rightW }}>
              <RunPanel
                workflowId={workflowId}
                workflowSpec={compiled}
                inputs={runInputs}
                blocks={blocks}
                initialSources={runSources}
                onSourcesChange={setRunSources}
                onClose={() => setRunOpen(false)}
              />
            </div>
          </>
        )}
      </div>

      {pickerOpen && (
        <BlockPickerModal
          blocks={blocks}
          onPick={(def) => {
            addNodeAtCenter(def);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {inlinePicker && (
        <InlineBlockPicker
          blocks={blocks}
          compatibleIds={inlinePicker.compatibleIds}
          anchor={inlinePicker.anchor}
          hint={inlinePicker.hint}
          onPick={onPickInline}
          onClose={() => setInlinePicker(null)}
        />
      )}
      {modelPicker && (
        <ModelPicker
          value={modelPicker.value}
          onPick={(next) => modelPicker.onPick(next)}
          onClose={() => setModelPicker(null)}
        />
      )}
    </div>
  );
}

// ---- Router ------------------------------------------------------------

function matchBuilderPath(pathname: string): string | null {
  const m = pathname.match(/^\/flybuild\/edit\/([\w\-]+)\/?$/);
  return m ? m[1] : null;
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, "", to);
    setPath(to);
  }, []);

  const workflowId = matchBuilderPath(path);

  if (workflowId) {
    return (
      <ReactFlowProvider key={workflowId}>
        <BuilderInner
          workflowId={workflowId}
          onBack={() => navigate("/flybuild")}
        />
      </ReactFlowProvider>
    );
  }

  return (
    <Dashboard
      onOpen={(id) => navigate(`/flybuild/edit/${encodeURIComponent(id)}`)}
    />
  );
}
