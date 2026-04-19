// Compact SVG icon library for block categories + a few specific blocks.
// Inline geometry, Lucide-inspired stroke-only look so each glyph sits
// comfortably next to a block label at 14–16 px. Keeps the bundle small
// (no FontAwesome or external icon package).

import { BlockDef } from "./api";
import { categoryFor, uiManifestFor } from "./compile";

type Glyph = (props: { size?: number; className?: string }) => JSX.Element;

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

// ---- Primitive glyphs -------------------------------------------------

const ArrowDown: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M12 5v14" />
      <path d="M19 12l-7 7-7-7" />
    </g>
  </svg>
);

const ArrowUp: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </g>
  </svg>
);

const Cpu: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
    </g>
  </svg>
);

const Sparkles: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" />
      <circle cx="12" cy="12" r="2.5" />
    </g>
  </svg>
);

const Eye: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  </svg>
);

const Scissors: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.12 15.88" />
      <path d="M14.47 14.48L20 20" />
      <path d="M8.12 8.12L12 12" />
    </g>
  </svg>
);

const Activity: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M3 12h4l3-9 4 18 3-9h4" />
    </g>
  </svg>
);

const GitBranch: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </g>
  </svg>
);

const Database: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
    </g>
  </svg>
);

const Bell: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </g>
  </svg>
);

const VideoIcon: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M22 8l-6 4 6 4V8z" />
    </g>
  </svg>
);

const Binary: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <rect x="4" y="3" width="5" height="7" rx="1" />
      <rect x="15" y="14" width="5" height="7" rx="1" />
      <path d="M9 10h1v7M15 3h1v7" />
    </g>
  </svg>
);

const Wrench: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M14.7 6.3a4 4 0 1 1-3 3L5 16a2.1 2.1 0 0 0 3 3l6.7-6.7a4 4 0 0 1 .1-6z" />
    </g>
  </svg>
);

const Factory: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M3 20V8l5 3V8l5 3V8l5 3V4h2v16H3z" />
      <path d="M7 20v-4M12 20v-4M17 20v-4" />
    </g>
  </svg>
);

const Box: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.27 6.96L12 12.01l8.73-5.05" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </g>
  </svg>
);

const Upload: Glyph = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
    <g {...stroke}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </g>
  </svg>
);

// ---- Category → glyph routing ----------------------------------------

const CATEGORY_ICON: Record<string, Glyph> = {
  "Inputs / Outputs": ArrowDown,
  Model: Cpu,
  Models: Cpu,
  "Models (Roboflow)": Cpu,
  "Foundation Models": Sparkles,
  Visualization: Eye,
  Transformations: Scissors,
  Analytics: Activity,
  Logic: GitBranch,
  "Logic and Branching": GitBranch,
  Sinks: Upload,
  "Data Storage": Database,
  Notification: Bell,
  Video: VideoIcon,
  "Classical Computer Vision": Binary,
  Advanced: Wrench,
  "Industrial Integration": Factory,
  Other: Box,
};

export function CategoryIcon({
  category,
  size = 14,
  className,
}: {
  category: string;
  size?: number;
  className?: string;
}) {
  const G = CATEGORY_ICON[category] || Box;
  return <G size={size} className={className} />;
}

// Icon for a specific block. Handles the pseudo input/output blocks
// (their `kind` is input/output), falls back to category icon otherwise.
// If the block's ui_manifest ships an emoji-style icon we use that.
export function BlockIcon({
  block,
  size = 14,
  className,
}: {
  block: BlockDef;
  size?: number;
  className?: string;
}) {
  const id = block.manifest_type_identifier;
  if (id === "flyt/input_image") return <ArrowDown size={size} className={className} />;
  if (id === "flyt/input_parameter") return <Sparkles size={size} className={className} />;
  if (id === "flyt/output") return <ArrowUp size={size} className={className} />;
  const ui = uiManifestFor(block);
  // Some manifests include an emoji shortcut that's cheap to render.
  if (typeof ui.emoji === "string" && ui.emoji.length <= 4) {
    return <span className={className} style={{ fontSize: size - 1 }}>{ui.emoji}</span>;
  }
  return <CategoryIcon category={categoryFor(block)} size={size} className={className} />;
}
