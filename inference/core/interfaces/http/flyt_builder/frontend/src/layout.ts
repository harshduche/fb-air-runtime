// Dagre-backed auto-layout for vertical (top→bottom) workflow graphs.
// React Flow ships no layout engine; every builder of note pipes its
// graph through Dagre to compute node positions. We re-run this on
// initial hydration (old phase-A workflows were laid out horizontally)
// and optionally on demand via a topbar "Arrange" button.

import dagre from "@dagrejs/dagre";
import { Edge, Node } from "reactflow";
import { FlytNodeData } from "./compile";

const NODE_W = 220;
const NODE_H = 96;

export function layoutVertical(
  nodes: Node<FlytNodeData>[],
  edges: Edge[],
): Node<FlytNodeData>[] {
  if (!nodes.length) return nodes;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 70, nodesep: 40, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    if (!pos) return n;
    // Dagre positions are node centers; React Flow positions are
    // top-left corners.
    return {
      ...n,
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      targetPosition: undefined,
      sourcePosition: undefined,
    } as Node<FlytNodeData>;
  });
}
