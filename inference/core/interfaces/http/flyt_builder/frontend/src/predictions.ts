// Walks workflow output payloads and extracts prediction blocks so the
// RunPanel can overlay bboxes / polygons / keypoints / labels on the
// hero image, regardless of whether the workflow contains a server-side
// visualization block.
//
// Shape contract (from serialise_sv_detections in
// inference/core/workflows/core_steps/common/serializers.py):
//
//   {
//     "image": { "width": 640, "height": 480 },
//     "predictions": [
//       {
//         "x": 320, "y": 240,            // CENTER of bbox, not top-left
//         "width": 100, "height": 200,
//         "confidence": 0.92,
//         "class": "person", "class_id": 0,
//         "tracker_id": 5,                       // optional
//         "detection_id": "uuid",
//         "points": [{x, y}, ...],               // polygon (segmentation)
//         "keypoints": [{x, y, class, confidence, class_id}, ...]
//       }
//     ]
//   }
//
// Classification predictions land in a different shape and aren't
// drawn as overlays — surfaced as a corner badge instead.

export type Detection = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
  class?: string;
  class_id?: number;
  tracker_id?: number;
  detection_id?: string;
  points?: Array<{ x: number; y: number }>;
  keypoints?: Array<{
    x: number;
    y: number;
    class?: string;
    class_id?: number;
    confidence?: number;
  }>;
};

export type DetectionBlock = {
  // Dotted path to the predictions array in the payload (e.g.
  // `outputs[0].predictions`). Used to pair detections with the image
  // that lives next to them.
  path: string;
  // The closest path that an image was attached to in the payload (e.g.
  // the `image` field next to the predictions array). Empty if none.
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  detections: Detection[];
};

export type ClassificationBlock = {
  path: string;
  topClass?: string;
  topConfidence?: number;
  classes?: Array<{ class: string; confidence: number }>;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const looksLikeDetection = (v: unknown): v is Detection => {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  // bbox-style (object detection / segmentation / keypoint) — needs
  // x, y, width, height (numbers). Polygon-only entries are also ok if
  // they carry x/y/width/height even if all four are 0.
  const hasBox =
    typeof v.x === "number" &&
    typeof v.y === "number" &&
    typeof v.width === "number" &&
    typeof v.height === "number";
  // some serialisers don't include class_id (e.g. anchor-free models)
  // so accept either class or class_id.
  const hasClass = "class" in v || "class_id" in v;
  return hasBox && (hasClass || keys.includes("detection_id"));
};

const looksLikeDetectionList = (v: unknown): v is Detection[] =>
  Array.isArray(v) && v.length > 0 && looksLikeDetection(v[0]);

const looksLikeClassification = (
  v: unknown,
): { topClass?: string; topConfidence?: number; classes?: Array<{ class: string; confidence: number }> } | null => {
  if (!isPlainObject(v)) return null;
  // Single-label: { top: "cat", confidence: 0.9, predictions: {cat: {confidence:..}} }
  if (typeof v.top === "string" && typeof v.confidence === "number") {
    return { topClass: v.top as string, topConfidence: v.confidence as number };
  }
  // Multi-label: { predicted_classes: ["a","b"], predictions: {a: {confidence}, b: {confidence}} }
  if (Array.isArray(v.predicted_classes) && isPlainObject(v.predictions)) {
    const classes: Array<{ class: string; confidence: number }> = [];
    for (const name of v.predicted_classes as string[]) {
      const entry = (v.predictions as Record<string, unknown>)[name];
      if (isPlainObject(entry) && typeof entry.confidence === "number") {
        classes.push({ class: name, confidence: entry.confidence as number });
      }
    }
    if (classes.length > 0) {
      classes.sort((a, b) => b.confidence - a.confidence);
      return { topClass: classes[0].class, topConfidence: classes[0].confidence, classes };
    }
  }
  return null;
};

export function collectPredictions(payload: unknown): {
  detections: DetectionBlock[];
  classifications: ClassificationBlock[];
} {
  const detections: DetectionBlock[] = [];
  const classifications: ClassificationBlock[] = [];

  const visit = (node: unknown, path: string) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (!isPlainObject(node)) return;

    // Canonical detection block: { image: {width, height}, predictions: [...] }
    if (
      isPlainObject(node.image) &&
      typeof node.image.width === "number" &&
      typeof node.image.height === "number" &&
      looksLikeDetectionList(node.predictions)
    ) {
      detections.push({
        path: path ? `${path}.predictions` : "predictions",
        imagePath: path ? `${path}.image` : "image",
        imageWidth: node.image.width as number,
        imageHeight: node.image.height as number,
        detections: node.predictions as Detection[],
      });
      // continue walking — siblings might hold classification or
      // nested image outputs.
    }

    // Bare predictions array without image dims (some blocks emit this).
    // Render still possible if the consumer attaches dims later.
    if (
      looksLikeDetectionList(node.predictions) &&
      !(isPlainObject(node.image) && typeof (node.image as any).width === "number")
    ) {
      detections.push({
        path: path ? `${path}.predictions` : "predictions",
        imagePath: "",
        imageWidth: 0,
        imageHeight: 0,
        detections: node.predictions as Detection[],
      });
    }

    // Classification at this node.
    const cls = looksLikeClassification(node);
    if (cls) {
      classifications.push({ path: path || "(root)", ...cls });
    }

    for (const [k, v] of Object.entries(node)) {
      // Skip the image+predictions pair we already handled at this node
      // — visiting `predictions` again would duplicate the block.
      if (
        k === "predictions" &&
        looksLikeDetectionList(v) &&
        isPlainObject(node.image)
      ) {
        continue;
      }
      visit(v, path ? `${path}.${k}` : k);
    }
  };

  visit(payload, "");
  return { detections, classifications };
}

// Stable HSL palette — same class_id maps to the same color across
// frames so a tracked object reads as continuous to the eye.
export function colorForClass(classId: number | undefined, className?: string): string {
  // Hash class_id (or fall back to className) into a hue. Golden-ratio
  // offset spreads adjacent class_ids to opposite sides of the wheel.
  let key: number;
  if (typeof classId === "number" && Number.isFinite(classId)) {
    key = classId;
  } else if (className) {
    let h = 5381;
    for (let i = 0; i < className.length; i++) {
      h = ((h << 5) + h + className.charCodeAt(i)) | 0;
    }
    key = Math.abs(h);
  } else {
    key = 0;
  }
  const hue = Math.floor((key * 137.508) % 360);
  return `hsl(${hue} 78% 58%)`;
}

export function formatLabel(d: Detection, opts: { showConf: boolean; showTrack: boolean }): string {
  const parts: string[] = [];
  if (d.tracker_id != null && opts.showTrack) parts.push(`#${d.tracker_id}`);
  if (d.class) parts.push(d.class);
  if (opts.showConf && typeof d.confidence === "number") {
    parts.push(`${Math.round(d.confidence * 100)}%`);
  }
  return parts.join(" ");
}

// Heuristic: an image whose path screams "viz / overlay / annotated"
// almost certainly already has detections drawn on it server-side. We
// don't want to double-draw, so the RunPanel can use this to skip the
// SVG overlay on those.
export function imagePathLooksAnnotated(path: string): boolean {
  return /visuali[sz]ation|viz|overlay|annotat|trace|bbox|mask/i.test(path);
}
