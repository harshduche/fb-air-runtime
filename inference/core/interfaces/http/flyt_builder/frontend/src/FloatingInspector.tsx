// Floating, draggable Inspector card. Positioned next to the selected
// node on first open, then freely movable by dragging the header. This
// mirrors Roboflow's in-flow dialogue pattern (screenshot 3.18.53): the
// inspector appears right where the user's attention is, rather than in
// a fixed right rail.

import { useCallback, useEffect, useRef, useState } from "react";
import { Edge, Node, ReactFlowInstance } from "reactflow";
import { BlockParamSchema } from "./api";
import { FlytNodeData } from "./compile";
import { Inspector } from "./Inspector";

type Props = {
  node: Node<FlytNodeData> | null;
  onChange: (next: FlytNodeData) => void;
  allNodes: Node<FlytNodeData>[];
  edges: Edge[];
  kindsConnections?: Record<
    string,
    Array<{ manifest_type_identifier: string; property_name: string }>
  >;
  onOpenModelPicker: (
    current: string,
    onPick: (v: string) => void,
  ) => void;
  onClose: () => void;
  /** React Flow instance — used to compute initial screen position from
   *  the node's flow coordinates. */
  rfInstance: ReactFlowInstance | null;
};

const PANEL_W = 340;

export function FloatingInspector({
  node,
  onChange,
  allNodes,
  edges,
  kindsConnections,
  onOpenModelPicker,
  onClose,
  rfInstance,
}: Props) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  // Compute initial position when the selected node changes. Puts the
  // panel just to the right of the node, clamped inside the viewport.
  useEffect(() => {
    if (!node || !rfInstance) {
      setPos(null);
      return;
    }
    const screen = rfInstance.flowToScreenPosition({
      x: node.position.x,
      y: node.position.y,
    });
    // Anchor: to the right of the node, nudged down a touch.
    const guessX = screen.x + 240;
    const guessY = screen.y - 10;
    const x = Math.max(
      16,
      Math.min(guessX, window.innerWidth - PANEL_W - 16),
    );
    const y = Math.max(
      64,
      Math.min(guessY, window.innerHeight - 200),
    );
    setPos({ x, y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id]);

  const onMouseMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      x: d.originX + (e.clientX - d.startX),
      y: d.originY + (e.clientY - d.startY),
    });
  }, []);

  const onMouseUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }, [onMouseMove]);

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const startDrag = (e: React.MouseEvent) => {
    if (!pos) return;
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  if (!node || !pos) return null;

  return (
    <div
      className="floating-inspector"
      style={{
        left: pos.x,
        top: pos.y,
        width: PANEL_W,
      }}
    >
      <div
        className="floating-inspector-header"
        onMouseDown={startDrag}
        title="Drag to reposition"
      >
        <span className="grip">⋮⋮</span>
        <span className="title">
          {node.data.kind === "step"
            ? node.data.block?.human_friendly_block_name ??
              node.data.block?.manifest_type_identifier
            : node.data.kind === "input"
            ? "Input"
            : "Output"}
        </span>
        <button
          className="close"
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}
          title="Close"
        >
          ×
        </button>
      </div>
      <div className="floating-inspector-body">
        <Inspector
          node={node}
          onChange={onChange}
          allNodes={allNodes}
          edges={edges}
          kindsConnections={kindsConnections}
          onOpenModelPicker={onOpenModelPicker}
        />
      </div>
    </div>
  );
}

// Re-export so App.tsx can use the same param schema type it already
// pulls from api.ts — keeps the import surface narrow.
export type { BlockParamSchema };
