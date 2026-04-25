// Image + SVG overlay. Draws bboxes / polygons / keypoints / labels on
// top of an image at the image's native coordinate system, so labels
// stay readable at any zoom and stroke widths don't blow up when the
// image is rendered small.
//
// We use SVG (not canvas) because:
//   - viewBox handles arbitrary scaling without re-rasterising
//   - text labels are crisp at any zoom
//   - hover targets per detection come for free
//   - DOM inspector lets us debug bbox geometry visually
//
// Coordinate convention (matches serialise_sv_detections):
//   detection.x, detection.y = CENTER of bbox
//   detection.width, detection.height = bbox dimensions
//   polygon points are absolute pixel coords inside image space
//   keypoints are absolute pixel coords

import { useEffect, useRef, useState } from "react";
import { Detection, colorForClass, formatLabel } from "./predictions";

export type Layers = {
  bbox: boolean;
  mask: boolean;
  label: boolean;
  track: boolean;
  conf: boolean;
  keypoints: boolean;
};

export const DEFAULT_LAYERS: Layers = {
  bbox: true,
  mask: true,
  label: true,
  track: true,
  conf: true,
  keypoints: true,
};

type Props = {
  imageSrc: string;
  imageAlt?: string;
  // Native pixel dims. If 0/undefined we'll measure from the loaded
  // <img> and use those instead — keeps the overlay aligned even when
  // the engine didn't ship image dims (rare, but happens).
  imageWidth?: number;
  imageHeight?: number;
  detections: Detection[];
  layers: Layers;
  onClick?: () => void;
  className?: string;
};

export function DetectionOverlay({
  imageSrc,
  imageAlt,
  imageWidth,
  imageHeight,
  detections,
  layers,
  onClick,
  className,
}: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Fallback dims when the engine didn't provide image.width/height.
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    setMeasured(null);
  }, [imageSrc]);

  const onLoad = () => {
    const el = imgRef.current;
    if (!el) return;
    if (!imageWidth || !imageHeight) {
      setMeasured({ w: el.naturalWidth, h: el.naturalHeight });
    }
  };

  const w = imageWidth || measured?.w || 0;
  const h = imageHeight || measured?.h || 0;
  const ready = w > 0 && h > 0;

  // Stroke width and font size scale with image size so a 4K frame
  // doesn't get drawn with hairline strokes and a 320×240 thumb doesn't
  // get drowned in fat strokes.
  const stroke = Math.max(1.5, Math.min(w, h) / 360);
  const fontSize = Math.max(11, Math.min(w, h) / 48);

  return (
    <div
      className={`detection-overlay ${className ?? ""}`}
      onClick={onClick}
      style={{ cursor: onClick ? "zoom-in" : undefined }}
    >
      <img
        ref={imgRef}
        src={imageSrc}
        alt={imageAlt}
        onLoad={onLoad}
        draggable={false}
      />
      {ready && (
        <svg
          className="detection-svg"
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          {detections.map((d, i) => (
            <DetectionShape
              key={d.detection_id ?? `det-${i}`}
              detection={d}
              layers={layers}
              stroke={stroke}
              fontSize={fontSize}
              imageWidth={w}
              imageHeight={h}
            />
          ))}
        </svg>
      )}
    </div>
  );
}

function DetectionShape({
  detection: d,
  layers,
  stroke,
  fontSize,
  imageWidth,
  imageHeight,
}: {
  detection: Detection;
  layers: Layers;
  stroke: number;
  fontSize: number;
  imageWidth: number;
  imageHeight: number;
}) {
  const color = colorForClass(d.class_id, d.class);
  const halfW = (d.width ?? 0) / 2;
  const halfH = (d.height ?? 0) / 2;
  const x1 = (d.x ?? 0) - halfW;
  const y1 = (d.y ?? 0) - halfH;
  const hasPoly = Array.isArray(d.points) && d.points.length >= 3;
  const hasKeypoints = Array.isArray(d.keypoints) && d.keypoints.length > 0;

  const labelText = formatLabel(d, { showConf: layers.conf, showTrack: layers.track });
  const showLabel = layers.label && labelText.length > 0;

  // Approximate label box width — SVG can't measure text without
  // hitting the DOM, so we estimate from char count. ~0.55em per char
  // is conservative for Roboto.
  const labelPadX = Math.max(4, fontSize * 0.4);
  const labelPadY = Math.max(2, fontSize * 0.18);
  const labelW = labelText.length * fontSize * 0.55 + labelPadX * 2;
  const labelH = fontSize + labelPadY * 2;

  // Pin the label inside the image: prefer above the bbox, but if it
  // would clip the top, drop it below the bbox top edge instead.
  let labelY = y1 - labelH - stroke / 2;
  if (labelY < 0) labelY = y1 + stroke / 2;
  let labelX = x1;
  if (labelX + labelW > imageWidth) labelX = Math.max(0, imageWidth - labelW);

  return (
    <g>
      {layers.mask && hasPoly && (
        <polygon
          points={d.points!.map((p) => `${p.x},${p.y}`).join(" ")}
          fill={color}
          fillOpacity={0.18}
          stroke={color}
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
      )}
      {layers.bbox && d.width > 0 && d.height > 0 && (
        <rect
          x={x1}
          y={y1}
          width={d.width}
          height={d.height}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          // Mask-only detections (zero bbox) get skipped; otherwise the
          // bbox is the universal anchor.
          rx={stroke * 0.6}
        />
      )}
      {layers.keypoints && hasKeypoints && (
        <g>
          {d.keypoints!.map((k, i) => (
            <circle
              key={i}
              cx={k.x}
              cy={k.y}
              r={Math.max(stroke * 1.4, 2.5)}
              fill={color}
              stroke="rgba(0,0,0,0.6)"
              strokeWidth={stroke * 0.4}
            />
          ))}
        </g>
      )}
      {showLabel && (
        <g>
          <rect
            x={labelX}
            y={labelY}
            width={labelW}
            height={labelH}
            rx={Math.min(4, stroke * 1.5)}
            fill={color}
          />
          <text
            x={labelX + labelPadX}
            y={labelY + labelH - labelPadY - fontSize * 0.18}
            fontFamily='"Roboto", system-ui, -apple-system, sans-serif'
            fontSize={fontSize}
            fontWeight={600}
            fill="#0b121e"
          >
            {labelText}
          </text>
        </g>
      )}
    </g>
  );
}

// Small, inline classification badge — top-left corner overlay used
// when the workflow ships a classification head (no bboxes to anchor
// to, so a corner ribbon is the right shape).
export function ClassificationBadge({
  topClass,
  topConfidence,
  classes,
}: {
  topClass?: string;
  topConfidence?: number;
  classes?: Array<{ class: string; confidence: number }>;
}) {
  if (!topClass && !classes?.length) return null;
  const list = classes && classes.length > 0
    ? classes.slice(0, 3)
    : topClass != null
      ? [{ class: topClass, confidence: topConfidence ?? 0 }]
      : [];
  return (
    <div className="classification-badge">
      {list.map((c) => (
        <div className="row" key={c.class}>
          <span className="cls">{c.class}</span>
          <span className="conf">{Math.round(c.confidence * 100)}%</span>
        </div>
      ))}
    </div>
  );
}
