// Right-rail Run panel. Consolidates:
//   • per-input cards (File / URL / Webcam / RTSP / USB)
//   • Image mode  → one-shot POST /infer/workflows
//   • Stream mode → POST /inference_pipelines/initialise (or ..._webrtc
//                   for in-browser webcam) + poll /consume for frames
//   • Config-changed pill + JSON/Visual output tabs + fullscreen modal.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BlockDef,
  ConsumeTimeoutError,
  PipelineGoneError,
  consumePipeline,
  initPipeline,
  listDevices,
  runWorkflow,
  terminatePipeline,
} from "./api";
import { validateRequiredFields } from "./compile";
import { startWebRTCStream, WebRTCHandle } from "./WebRTCStream";

// ---- Types --------------------------------------------------------------

export type InputSource =
  | { kind: "file"; dataUrl: string; filename?: string; mime?: string }
  | { kind: "url"; value: string; maxFps?: number }
  | { kind: "webcam"; deviceId?: string; width?: number; height?: number; fps?: number }
  | { kind: "rtsp"; url: string; maxFps?: number }
  | { kind: "usb"; path: string; maxFps?: number }
  | { kind: "param"; value: string };

export type InputDef = {
  name: string;
  type: "WorkflowImage" | "WorkflowParameter";
  defaultValue?: string;
};

type Props = {
  workflowSpec: any;
  inputs: InputDef[];
  blocks: BlockDef[];
  initialSources?: Record<string, InputSource>;
  onSourcesChange?: (s: Record<string, InputSource>) => void;
  onClose: () => void;
};

type RunMode = "image" | "stream";

type ResultState =
  | { kind: "idle" }
  | { kind: "running"; msg?: string }
  | { kind: "image"; data: any }
  | { kind: "stream"; frames: number; latest: any; pipelineId: string; lastFrameAt: number }
  | { kind: "error"; msg: string };

// Estimate instantaneous fps from a rolling window of frame timestamps
// (ms). Returns null if we don't have enough data yet.
function computeFps(timestamps: number[]): number | null {
  if (timestamps.length < 2) return null;
  const cutoff = Date.now() - 5000;
  const recent = timestamps.filter((t) => t >= cutoff);
  if (recent.length < 2) return null;
  const span = (recent[recent.length - 1] - recent[0]) / 1000;
  if (span <= 0) return null;
  return (recent.length - 1) / span;
}

// Rank image outputs and pick the "hero" — the one worth showing big.
// Names like `mask_visualization_output` or `bbox_viz.image` are
// overlays worth putting front and center. Fall back to the first.
function pickHeroImage<T extends { path: string }>(images: T[]): T | null {
  if (!images.length) return null;
  const byScore = (img: T) => {
    const p = img.path.toLowerCase();
    let s = 0;
    if (/visualization|viz|overlay|annotat|trace|bbox|mask/.test(p)) s -= 100;
    if (p === "image" || p.endsWith(".image")) s -= 20;
    // Prefer shallower paths (closer to top-level "outputs[*].foo").
    s += p.split(".").length;
    return s;
  };
  return [...images].sort((a, b) => byScore(a) - byScore(b))[0];
}

// ---- Helpers ------------------------------------------------------------

function coerceParam(v: string): unknown {
  if (v === "") return "";
  const n = Number(v);
  return !Number.isNaN(n) ? n : v;
}

function hashInputs(obj: unknown): string {
  // Cheap djb2-ish — good enough to detect config changes between runs.
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

function collectImages(obj: any, path: string, out: Array<{ path: string; src: string }>) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => collectImages(v, `${path}[${i}]`, out));
    return;
  }
  if (obj.type === "base64" && typeof obj.value === "string") {
    out.push({ path: path || "image", src: `data:image/jpeg;base64,${obj.value}` });
    return;
  }
  if (obj.type === "url" && typeof obj.value === "string" && /^https?:|^data:/.test(obj.value)) {
    out.push({ path: path || "image", src: obj.value });
    return;
  }
  for (const [k, v] of Object.entries(obj)) collectImages(v, path ? `${path}.${k}` : k, out);
}

function redactImages(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactImages);
  if (obj.type === "base64" && typeof obj.value === "string") {
    const kb = Math.max(1, Math.round(obj.value.length / 1024));
    return { ...obj, value: `<base64 ${kb}KB — rendered above>` };
  }
  const o: any = {};
  for (const [k, v] of Object.entries(obj)) o[k] = redactImages(v);
  return o;
}

// ---- Input card --------------------------------------------------------

type TabKind = "file" | "url" | "webcam" | "rtsp" | "usb";

function InputCard({
  input,
  source,
  onChange,
  devices,
  webcamDevices,
}: {
  input: InputDef;
  source: InputSource | null;
  onChange: (s: InputSource) => void;
  devices: Array<{ path: string; label: string }>;
  webcamDevices: Array<{ deviceId: string; label: string }>;
}) {
  if (input.type === "WorkflowParameter") {
    const v = source && source.kind === "param" ? source.value : (input.defaultValue ?? "");
    return (
      <div className="input-card">
        <div className="name">
          {input.name}
          <span className="type">param</span>
        </div>
        <input
          className="text"
          placeholder={input.defaultValue || "string or number"}
          value={v}
          onChange={(e) => onChange({ kind: "param", value: e.target.value })}
        />
      </div>
    );
  }

  const activeTab: TabKind =
    source?.kind === "file"
      ? "file"
      : source?.kind === "url"
      ? "url"
      : source?.kind === "webcam"
      ? "webcam"
      : source?.kind === "rtsp"
      ? "rtsp"
      : source?.kind === "usb"
      ? "usb"
      : "file";

  const setTab = (t: TabKind) => {
    if (t === activeTab) return;
    if (t === "file") onChange({ kind: "file", dataUrl: "" });
    if (t === "url") onChange({ kind: "url", value: "" });
    if (t === "webcam") onChange({ kind: "webcam", deviceId: webcamDevices[0]?.deviceId });
    if (t === "rtsp") onChange({ kind: "rtsp", url: "" });
    if (t === "usb") onChange({ kind: "usb", path: devices[0]?.path || "" });
  };

  return (
    <div className="input-card">
      <div className="name">
        {input.name}
        <span className="type">image</span>
      </div>
      <div className="tabs">
        {(["file", "url", "webcam", "rtsp", "usb"] as TabKind[]).map((t) => (
          <button
            key={t}
            className={t === activeTab ? "tab active" : "tab"}
            onClick={() => setTab(t)}
          >
            {t === "file"
              ? "📁 File"
              : t === "url"
              ? "🔗 URL"
              : t === "webcam"
              ? "📷 Webcam"
              : t === "rtsp"
              ? "📡 RTSP"
              : "🔌 USB"}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {activeTab === "file" && (
          <div>
            <input
              type="file"
              accept="image/*,video/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () =>
                  onChange({
                    kind: "file",
                    dataUrl: String(reader.result || ""),
                    filename: f.name,
                    mime: f.type,
                  });
                reader.readAsDataURL(f);
              }}
            />
            {source?.kind === "file" && source.dataUrl?.startsWith("data:image/") && (
              <img className="thumb" src={source.dataUrl} alt={source.filename} />
            )}
            {source?.kind === "file" && source.filename && (
              <div className="hint">
                {source.filename} · {source.mime}
              </div>
            )}
          </div>
        )}
        {activeTab === "url" && (
          <div>
            <input
              className="text"
              placeholder="https://… (image or video)"
              value={source?.kind === "url" ? source.value : ""}
              onChange={(e) => onChange({ kind: "url", value: e.target.value })}
            />
            {source?.kind === "url" && isVideoUrl(source.value) && (
              <>
                <div className="hint">
                  🎬 Video URL detected — run will use Stream mode
                  (InferencePipeline) and stream frames.
                </div>
                <label className="fps-row">
                  <span>max fps</span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    placeholder="auto"
                    value={source.maxFps ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...source,
                        maxFps: e.target.value === "" ? undefined : Number(e.target.value),
                      })
                    }
                  />
                  <span className="muted">(throttle decode to keep the model in its happy zone — SAM3 does 1–3 fps on CPU)</span>
                </label>
              </>
            )}
          </div>
        )}
        {activeTab === "webcam" && (
          <div>
            {webcamDevices.length === 0 ? (
              <div className="hint">
                No webcams detected. Grant camera permission and reopen this
                panel.
              </div>
            ) : (
              <>
                <select
                  className="text"
                  value={source?.kind === "webcam" ? source.deviceId ?? "" : ""}
                  onChange={(e) =>
                    onChange({
                      kind: "webcam",
                      deviceId: e.target.value,
                      width:
                        source?.kind === "webcam" ? source.width : 1280,
                      height:
                        source?.kind === "webcam" ? source.height : 720,
                    })
                  }
                >
                  {webcamDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || d.deviceId}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  Runs via browser WebRTC — no camera access on the server
                  needed.
                </div>
              </>
            )}
          </div>
        )}
        {activeTab === "rtsp" && (
          <div>
            <input
              className="text"
              placeholder="rtsp://user:pass@host:554/stream"
              value={source?.kind === "rtsp" ? source.url : ""}
              onChange={(e) =>
                onChange({
                  kind: "rtsp",
                  url: e.target.value,
                  maxFps: source?.kind === "rtsp" ? source.maxFps : undefined,
                })
              }
            />
            <div className="hint">
              Server opens this stream directly. Uses InferencePipeline with a
              string video_reference.
            </div>
          </div>
        )}
        {activeTab === "usb" && (
          <div>
            {devices.length === 0 ? (
              <div className="hint">
                No <code>/dev/video*</code> devices visible to the server.
                Mount <code>--device=/dev/video0</code> when running the
                container.
              </div>
            ) : (
              <select
                className="text"
                value={source?.kind === "usb" ? source.path : ""}
                onChange={(e) =>
                  onChange({ kind: "usb", path: e.target.value })
                }
              >
                {devices.map((d) => (
                  <option key={d.path} value={d.path}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Run panel -----------------------------------------------------------

// Turn a WorkflowSyntaxError string into something the user can act on.
// The engine's error body is nested:
//   {message, inner_error_message: "N validation errors for …\nsteps.1.foo.field\n  Field required …"}
// We prefer inner_error_message verbatim but chop the URL tail Pydantic
// appends.
function formatRunError(raw: string): string {
  try {
    const m = raw.match(/\{.*\}$/s);
    if (!m) return raw;
    const parsed = JSON.parse(m[0]);
    const inner = parsed.inner_error_message || parsed.message || raw;
    const cleaned = String(inner).replace(/\s*For further information.*$/gs, "");
    // Targeted hint when the user hit Image mode with a video URL.
    if (/Could not decode bytes as image/.test(cleaned)) {
      return `${cleaned}\n\nHint: if this is a video (mp4, mov, avi, …), switch the input tab to Webcam / RTSP / or enter the video URL — the run will auto-flip to Stream mode and feed each frame through the pipeline.`;
    }
    return cleaned;
  } catch {
    return raw;
  }
}

const VIDEO_EXT_RE = /\.(mp4|m4v|mov|avi|mkv|webm|flv|ts|m3u8|mpd)(?:$|[?#])/i;
export function isVideoUrl(s: string): boolean {
  return VIDEO_EXT_RE.test(s);
}

export function RunPanel({
  workflowSpec,
  inputs,
  blocks,
  initialSources,
  onSourcesChange,
  onClose,
}: Props) {
  const [sources, setSources] = useState<Record<string, InputSource>>(initialSources || {});
  const [devices, setDevices] = useState<Array<{ path: string; label: string }>>([]);
  const [webcamDevices, setWebcamDevices] = useState<
    Array<{ deviceId: string; label: string }>
  >([]);
  const [mode, setMode] = useState<RunMode>("image");
  const [result, setResult] = useState<ResultState>({ kind: "idle" });
  const [outputTab, setOutputTab] = useState<"visual" | "json">("visual");
  const [fullscreenSrc, setFullscreenSrc] = useState<string | null>(null);
  const [lastRunHash, setLastRunHash] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const webRtcRef = useRef<WebRTCHandle | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const frameTimestampsRef = useRef<number[]>([]);
  const pausedRef = useRef(false);
  // Flipped by stopPipeline. The adaptive poll loop checks this before
  // scheduling the next tick so Stop is guaranteed to halt the loop
  // even if a fetch is in flight.
  const pollCancelledRef = useRef(false);
  // AbortController for an in-flight initPipeline request. Lets the Stop
  // button actually cancel a Run stuck in "Starting pipeline…" when the
  // server's stream manager is wedged.
  const initAbortRef = useRef<AbortController | null>(null);
  const [paused, setPaused] = useState(false);

  // ---- Recording state ----------------------------------------------
  // A hidden <canvas> mirrors the hero image each time a new frame
  // arrives. When the user hits Record we capture the canvas stream via
  // MediaRecorder; saved clips live in `recordedClips` for playback /
  // download.
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef<number | null>(null);
  const [recording, setRecording] = useState(false);
  type Clip = { id: string; url: string; size: number; durationMs: number; createdAt: number };
  const [recordedClips, setRecordedClips] = useState<Clip[]>([]);

  // When on, Stop halts client-side polling but doesn't terminate the
  // pipeline server-side — the model stays loaded in its Python child
  // process, so the next Run resumes almost instantly instead of paying
  // the 60-120s SAM3 cold-start cost again. Persisted to localStorage.
  const [keepAlive, setKeepAlive] = useState<boolean>(() => {
    return localStorage.getItem("flyt.run.keepAlive") === "1";
  });
  useEffect(() => {
    localStorage.setItem("flyt.run.keepAlive", keepAlive ? "1" : "0");
  }, [keepAlive]);
  // Remember the pipeline id of a kept-alive pipeline so we can
  // reconnect (by polling its output) instead of spawning new on next Run.
  const [warmPipelineId, setWarmPipelineId] = useState<string | null>(null);
  // Force a re-render every 500 ms while streaming so the "since last
  // frame" text stays live and the FPS readout updates smoothly even
  // when no new frames arrive.
  const [, setTick] = useState(0);

  // Detect devices.
  useEffect(() => {
    listDevices().then((d) => setDevices(d.map((x) => ({ path: x.path, label: x.label }))));
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) =>
        setWebcamDevices(
          list
            .filter((d) => d.kind === "videoinput")
            .map((d) => ({
              deviceId: d.deviceId,
              label: d.label || `Camera ${d.deviceId.slice(0, 6)}`,
            })),
        ),
      )
      .catch(() => setWebcamDevices([]));
  }, []);

  // Auto-flip to stream mode if any image input requires it. Webcam /
  // RTSP / USB are obviously streaming; a URL that points at a video
  // file is also a stream because the engine can't single-decode an
  // mp4/mov/etc. as a still image.
  useEffect(() => {
    const streamy = Object.values(sources).some((s) => {
      if (!s) return false;
      if (s.kind === "webcam" || s.kind === "rtsp" || s.kind === "usb") return true;
      if (s.kind === "url" && isVideoUrl(s.value)) return true;
      return false;
    });
    setMode(streamy ? "stream" : "image");
  }, [sources]);

  // Propagate state up so the Builder can persist it on Save.
  useEffect(() => {
    onSourcesChange?.(sources);
  }, [sources, onSourcesChange]);

  // Heartbeat while streaming: keeps the "since last frame" label and
  // FPS readout live even when no frame has arrived in a while.
  useEffect(() => {
    if (result.kind !== "stream") return;
    const t = window.setInterval(() => setTick((x) => x + 1), 500);
    return () => window.clearInterval(t);
  }, [result.kind]);

  const setSource = useCallback((name: string, s: InputSource) => {
    setSources((prev) => ({ ...prev, [name]: s }));
  }, []);

  const stopPipeline = useCallback(async () => {
    pollCancelledRef.current = true;
    // Cancel a Run that's still blocked in initPipeline (the "Starting
    // pipeline…" state). Without this, Stop only halts polling.
    initAbortRef.current?.abort();
    initAbortRef.current = null;
    if (pollRef.current) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    if (webRtcRef.current) {
      // WebRTC always terminates — the peer connection is local to
      // this browser tab and can't survive a reload anyway.
      await webRtcRef.current.stop();
      webRtcRef.current = null;
    }
    if (result.kind === "stream") {
      if (keepAlive) {
        // Leave the pipeline running server-side. Stash its id so
        // nextRun can reconnect by polling its output rather than
        // paying the cold-start cost again.
        setWarmPipelineId(result.pipelineId);
      } else {
        await terminatePipeline(result.pipelineId);
        setWarmPipelineId(null);
      }
    }
  }, [result, keepAlive]);

  useEffect(() => {
    // Tear down on unmount.
    return () => {
      stopPipeline();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configHash = useMemo(
    () => hashInputs({ workflowSpec, sources, mode }),
    [workflowSpec, sources, mode],
  );
  const configChanged = lastRunHash !== null && lastRunHash !== configHash;

  // ---- Run handlers --------------------------------------------------

  const runImage = useCallback(async () => {
    setResult({ kind: "running", msg: "Running…" });
    try {
      const issues = validateRequiredFields(workflowSpec, blocks);
      if (issues.length > 0) {
        const lines = issues
          .map((i) => `• ${i.step}: missing ${i.missing.join(", ")}`)
          .join("\n");
        throw new Error(
          `Workflow has unset required fields:\n${lines}\n\nOpen the step in the Inspector and fill them (required fields are at the top).`,
        );
      }
      const inputsPayload: Record<string, unknown> = {};
      for (const inp of inputs) {
        const s = sources[inp.name];
        if (inp.type === "WorkflowParameter") {
          const v = s && s.kind === "param" ? s.value : inp.defaultValue ?? "";
          inputsPayload[inp.name] = coerceParam(v);
          continue;
        }
        if (!s) throw new Error(`Missing value for input '${inp.name}'`);
        if (s.kind === "file") {
          inputsPayload[inp.name] = {
            type: "base64",
            value: s.dataUrl.replace(/^data:[^;]+;base64,/, ""),
          };
        } else if (s.kind === "url") {
          inputsPayload[inp.name] = { type: "url", value: s.value };
        } else {
          throw new Error(
            `Input '${inp.name}' is set to ${s.kind}, which needs Stream mode. Switch to File/URL or use Stream.`,
          );
        }
      }
      const data = await runWorkflow(workflowSpec, inputsPayload);
      setResult({ kind: "image", data });
      setLastRunHash(configHash);
    } catch (e: any) {
      setResult({ kind: "error", msg: formatRunError(String(e?.message || e)) });
    }
  }, [workflowSpec, inputs, sources, configHash, blocks]);

  const runStream = useCallback(async () => {
    setResult({ kind: "running", msg: "Starting pipeline…" });
    // Tick a counter while initialise is in flight so the user sees the
    // wait isn't frozen. First-run SAM3 load is ~60-120s on CPU.
    const runStartedAt = Date.now();
    const runTicker = window.setInterval(() => {
      const secs = Math.round((Date.now() - runStartedAt) / 1000);
      setResult((prev) =>
        prev.kind === "running"
          ? {
              kind: "running",
              msg: `Starting pipeline… ${secs}s (first SAM3 run loads weights — up to ~90s is normal)`,
            }
          : prev,
      );
    }, 1000);
    const finishTicker = () => window.clearInterval(runTicker);
    try {
      const issues = validateRequiredFields(workflowSpec, blocks);
      if (issues.length > 0) {
        const lines = issues
          .map((i) => `• ${i.step}: missing ${i.missing.join(", ")}`)
          .join("\n");
        throw new Error(
          `Workflow has unset required fields:\n${lines}\n\nOpen the step in the Inspector and fill them.`,
        );
      }
      // Pick the first WorkflowImage input as the pipeline's live source;
      // pack the rest into workflows_parameters.
      const imageInput = inputs.find(
        (i) => i.type === "WorkflowImage" && sources[i.name],
      );
      if (!imageInput) {
        throw new Error("Stream mode needs an image input wired to a source.");
      }
      const src = sources[imageInput.name];
      const workflowsParameters: Record<string, unknown> = {};
      for (const inp of inputs) {
        if (inp === imageInput) continue;
        if (inp.type === "WorkflowParameter") {
          const s = sources[inp.name];
          const v = s && s.kind === "param" ? s.value : inp.defaultValue ?? "";
          workflowsParameters[inp.name] = coerceParam(v);
        }
      }

      if (src.kind === "webcam") {
        const handle = await startWebRTCStream({
          specification: workflowSpec,
          deviceId: src.deviceId,
          width: src.width ?? 1280,
          height: src.height ?? 720,
          imageInputName: imageInput.name,
          workflowsParameters,
        });
        webRtcRef.current = handle;
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = handle.remoteStream;
          remoteVideoRef.current.play().catch(() => undefined);
        }
        let frames = 0;
        handle.onPredictions((data) => {
          frames += 1;
          frameTimestampsRef.current.push(Date.now());
          if (frameTimestampsRef.current.length > 30) {
            frameTimestampsRef.current.shift();
          }
          setResult({
            kind: "stream",
            frames,
            latest: data,
            pipelineId: handle.pipelineId,
            lastFrameAt: Date.now(),
          });
        });
        setResult({
          kind: "stream",
          frames: 0,
          latest: null,
          pipelineId: handle.pipelineId,
          lastFrameAt: 0,
        });
        setLastRunHash(configHash);
        return;
      }

      let videoReference: string | number;
      let maxFps: number | undefined;
      if (src.kind === "rtsp") {
        videoReference = src.url;
        maxFps = src.maxFps;
      } else if (src.kind === "usb") {
        videoReference = src.path;
      } else if (src.kind === "url") {
        videoReference = src.value;
        maxFps = src.maxFps;
      } else if (src.kind === "file") {
        throw new Error(
          "Uploaded files run in Image mode, not Stream mode.",
        );
      } else {
        throw new Error(`Unsupported source '${(src as any).kind}' for Stream mode.`);
      }

      // Fast path: reconnect to a kept-alive pipeline instead of
      // paying another cold-start. Only valid if the spec/inputs hash
      // matches the last successful run — otherwise we'd be polling
      // the wrong workflow. We detect that via `lastRunHash` (unchanged
      // since Stop means same workflow is being resumed).
      let pipeline_id: string;
      if (warmPipelineId && lastRunHash === configHash) {
        pipeline_id = warmPipelineId;
        finishTicker();
      } else {
        // If we had a warm pipeline for a DIFFERENT spec, terminate it
        // now so we don't leak server-side processes.
        if (warmPipelineId) {
          await terminatePipeline(warmPipelineId);
          setWarmPipelineId(null);
        }
        // Replace any previous abort controller. Stop button triggers
        // its abort(), unblocking this fetch even if the server never
        // replies.
        initAbortRef.current?.abort();
        initAbortRef.current = new AbortController();
        const r = await initPipeline({
          specification: workflowSpec,
          video_reference: videoReference,
          image_input_name: imageInput.name,
          max_fps: maxFps,
          workflows_parameters: workflowsParameters,
          signal: initAbortRef.current.signal,
        });
        pipeline_id = r.pipeline_id;
        initAbortRef.current = null;
        finishTicker();
      }

      setResult({
        kind: "stream",
        frames: 0,
        latest: null,
        pipelineId: pipeline_id,
        lastFrameAt: 0,
      });
      setLastRunHash(configHash);

      // Adaptive loop: fire the next consume as soon as the previous
      // one returns, with a short delay that ramps down on hit and up
      // on miss. Removes the fixed 750ms floor so when the pipeline
      // happens to be producing faster than that we don't throttle it.
      //
      //   hit (outputs.length > 0) → 50ms then next poll (pull flood)
      //   miss (empty response)    → 400ms → 700ms → 1000ms (back off)
      //   fail (fetch error)       → 500ms, count strikes, give up at 8
      const MAX_FAILS = 8;
      const HIT_DELAY = 50;
      const BASE_MISS_DELAY = 400;
      const MAX_MISS_DELAY = 1000;
      let consecutiveFails = 0;
      let missDelay = BASE_MISS_DELAY;
      pollCancelledRef.current = false;

      const tick = async () => {
        if (pollCancelledRef.current) return;
        if (pausedRef.current) {
          pollRef.current = window.setTimeout(tick, 300);
          return;
        }
        try {
          const { outputs } = await consumePipeline(pipeline_id);
          consecutiveFails = 0;
          if (outputs.length === 0) {
            missDelay = Math.min(MAX_MISS_DELAY, missDelay + 200);
            pollRef.current = window.setTimeout(tick, missDelay);
            return;
          }
          missDelay = BASE_MISS_DELAY;
          const now = Date.now();
          for (let i = 0; i < outputs.length; i += 1) {
            frameTimestampsRef.current.push(now);
          }
          while (frameTimestampsRef.current.length > 30) {
            frameTimestampsRef.current.shift();
          }
          setResult((prev) => {
            if (prev.kind !== "stream" || prev.pipelineId !== pipeline_id) {
              return prev;
            }
            return {
              kind: "stream",
              frames: prev.frames + outputs.length,
              latest: outputs[outputs.length - 1],
              pipelineId: pipeline_id,
              lastFrameAt: now,
            };
          });
          pollRef.current = window.setTimeout(tick, HIT_DELAY);
        } catch (err: any) {
          // Timeouts are expected on heavy workloads (SAM3 CPU-bound) —
          // don't count them as a hard failure. Just back off and retry.
          // 404 = the pipeline has been evicted (either it finished
          // processing the source, crashed, or was terminated). Stop
          // polling with a friendly message — it's not a manager wedge.
          if (err instanceof PipelineGoneError) {
            pollCancelledRef.current = true;
            setResult((prev) =>
              prev.kind === "stream" && prev.frames > 0
                ? {
                    kind: "image",
                    data: prev.latest,
                  }
                : {
                    kind: "error",
                    msg:
                      "Pipeline ended before producing any frames — the " +
                      "video source may be unreachable, or the workflow " +
                      "errored on the first frame. Check the workflow in " +
                      "the Inspector and try Run again.",
                  },
            );
            return;
          }
          // Timeouts are expected on heavy workloads (SAM3 CPU-bound).
          // Hard failures (500s, network errors) count toward the
          // "manager wedged" circuit breaker.
          const isTimeout = err instanceof ConsumeTimeoutError;
          if (!isTimeout) consecutiveFails += 1;
          if (consecutiveFails >= MAX_FAILS) {
            pollCancelledRef.current = true;
            setResult({
              kind: "error",
              msg:
                "Lost connection to the InferencePipeline Manager after " +
                `${MAX_FAILS} consecutive failed polls. The server-side ` +
                "manager is likely wedged — restart the inference " +
                "container (docker restart flytbase-infer-v122). Recent: " +
                String(err?.message || err).slice(0, 160),
            });
            return;
          }
          // Longer back-off for timeouts (the server is probably still
          // grinding through a frame; no point hammering).
          pollRef.current = window.setTimeout(tick, isTimeout ? 1500 : 500);
        }
      };

      pollRef.current = window.setTimeout(tick, 0);
    } catch (e: any) {
      finishTicker();
      setResult({ kind: "error", msg: formatRunError(String(e?.message || e)) });
    }
  }, [workflowSpec, inputs, sources, configHash, blocks]);

  const doRun = useCallback(() => {
    if (mode === "image") runImage();
    else runStream();
  }, [mode, runImage, runStream]);

  const doStop = useCallback(async () => {
    await stopPipeline();
    setResult({ kind: "idle" });
    frameTimestampsRef.current = [];
    pausedRef.current = false;
    setPaused(false);
  }, [stopPipeline]);

  const togglePaused = useCallback(() => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  }, []);

  // ---- Recording helpers --------------------------------------------

  /** Draw an image URL onto the hidden capture canvas. Called once per
   *  frame while recording. Returns false if the draw failed (e.g. the
   *  canvas isn't mounted yet). */
  const drawToCaptureCanvas = useCallback((src: string) => {
    const canvas = captureCanvasRef.current;
    if (!canvas) return false;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Auto-size the canvas to the first frame so the recording's
      // pixel ratio matches the source.
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth || 640;
        canvas.height = img.naturalHeight || 360;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = src;
    return true;
  }, []);

  const startRecording = useCallback(() => {
    if (recording) return;
    const canvas = captureCanvasRef.current;
    if (!canvas || !canvas.width) {
      alert("Wait until at least one frame has rendered before recording.");
      return;
    }
    const stream = canvas.captureStream(30);
    // Prefer VP9 if available; fall back to browser default.
    let options: MediaRecorderOptions = {};
    if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9")) {
      options = { mimeType: "video/webm;codecs=vp9" };
    } else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) {
      options = { mimeType: "video/webm;codecs=vp8" };
    }
    const rec = new MediaRecorder(stream, options);
    recordingChunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordingChunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(recordingChunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const durationMs = recordingStartedAtRef.current
        ? Date.now() - recordingStartedAtRef.current
        : 0;
      setRecordedClips((prev) => [
        {
          id: String(Date.now()),
          url,
          size: blob.size,
          durationMs,
          createdAt: Date.now(),
        },
        ...prev,
      ]);
      recordingChunksRef.current = [];
      recordingStartedAtRef.current = null;
    };
    rec.start(250); // chunk every 250ms so long recordings don't buffer forever
    mediaRecorderRef.current = rec;
    recordingStartedAtRef.current = Date.now();
    setRecording(true);
  }, [recording]);

  const stopRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    try {
      if (rec.state !== "inactive") rec.stop();
    } catch {
      /* ignore */
    }
    mediaRecorderRef.current = null;
    setRecording(false);
  }, []);

  const toggleRecording = useCallback(() => {
    if (recording) stopRecording();
    else startRecording();
  }, [recording, startRecording, stopRecording]);

  /** Save the current hero frame as a PNG. */
  const saveSnapshot = useCallback((src: string | null) => {
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `flybuild-snapshot-${ts}.png`;
    a.click();
  }, []);

  // Revoke clip URLs on unmount so we don't leak blobs.
  useEffect(() => {
    return () => {
      for (const c of recordedClips) URL.revokeObjectURL(c.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Output rendering --------------------------------------------

  const latestPayload =
    result.kind === "image"
      ? result.data
      : result.kind === "stream"
      ? result.latest
      : null;

  const images = useMemo(() => {
    const acc: Array<{ path: string; src: string }> = [];
    if (latestPayload) collectImages(latestPayload, "", acc);
    return acc;
  }, [latestPayload]);

  const heroSrc = useMemo(() => pickHeroImage(images)?.src ?? null, [images]);

  // Mirror the live hero image onto the hidden canvas. Doing it here
  // (effect) instead of inline inside the render makes sure the canvas
  // gets a frame even while recording is off — so starting the recorder
  // later has a valid frame size to size itself against.
  useEffect(() => {
    if (!heroSrc) return;
    drawToCaptureCanvas(heroSrc);
  }, [heroSrc, drawToCaptureCanvas]);

  return (
    <div className="run-panel">
      <div className="header">
        <div className="title">
          ▶ Run Workflow
          <span className="mode-pill">{mode === "stream" ? "Stream" : "Image"}</span>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close">
          ×
        </button>
      </div>

      <div className="section-title">Inputs</div>
      <div className="inputs">
        {inputs.length === 0 && (
          <div className="empty">Add an Input block to the canvas to run.</div>
        )}
        {inputs.map((inp) => (
          <InputCard
            key={inp.name}
            input={inp}
            source={sources[inp.name] || null}
            onChange={(s) => setSource(inp.name, s)}
            devices={devices}
            webcamDevices={webcamDevices}
          />
        ))}
      </div>

      <div className="actions">
        <label className="keep-alive-toggle" title="When on, Stop leaves the pipeline running on the server so the next Run skips the 60-120s SAM3 cold-start. Switch off and press Stop to fully terminate.">
          <input
            type="checkbox"
            checked={keepAlive}
            onChange={(e) => setKeepAlive(e.target.checked)}
          />
          <span>Keep warm</span>
        </label>
        {warmPipelineId && result.kind !== "stream" && result.kind !== "running" && (
          <span
            className="pill warm"
            title="A warm pipeline is still running on the server — next Run will reconnect to it instantly. Uncheck 'Keep warm' and press Stop to terminate."
          >
            🔥 warm
          </span>
        )}
        {configChanged && result.kind !== "stream" && (
          <span className="pill changed">Configuration changed</span>
        )}
        {result.kind === "stream" && (
          <button
            className="btn"
            onClick={togglePaused}
            title={paused ? "Resume polling" : "Pause — keep pipeline running, stop updating preview"}
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
        )}
        {(result.kind === "stream" || result.kind === "running") ? (
          <button className="btn danger" onClick={doStop}>
            {keepAlive ? "■ Stop (keep warm)" : "■ Stop"}
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={doRun}
            disabled={inputs.length === 0}
          >
            ▶ {warmPipelineId ? "Run (warm)" : lastRunHash ? "New Run" : "Run"}
          </button>
        )}
      </div>

      <div className="section-title">Output</div>
      <div className="output-tabs">
        <button
          className={outputTab === "visual" ? "tab active" : "tab"}
          onClick={() => setOutputTab("visual")}
        >
          Visual
        </button>
        <button
          className={outputTab === "json" ? "tab active" : "tab"}
          onClick={() => setOutputTab("json")}
        >
          JSON
        </button>
      </div>
      <div className="output-body">
        {result.kind === "idle" && (
          <div className="empty">Run to see the output.</div>
        )}
        {result.kind === "running" && (
          <div className="empty">
            {result.msg || "Loading…"}
            <div className="sub">
              First run after inactivity often takes longer.
            </div>
          </div>
        )}
        {result.kind === "error" && (
          <div className="empty err">{result.msg}</div>
        )}

        {/* ---- Live WebRTC webcam — dedicated video element, always shown. */}
        {webRtcRef.current && outputTab === "visual" && (
          <div className="stream-viewer">
            <div className="stream-chrome">
              <span className={`live-dot ${paused ? "paused" : "on"}`} />
              <span className="live-label">
                {paused ? "PAUSED" : "LIVE · WebRTC"}
              </span>
              <button
                className={`chrome-btn ${recording ? "rec-on" : ""}`}
                onClick={toggleRecording}
                title={recording ? "Stop recording" : "Record to WebM"}
              >
                {recording ? "⏹ Recording" : "⏺ Record"}
              </button>
              <div className="spacer" />
              {result.kind === "stream" && (
                <span className="stat">{result.frames} frames</span>
              )}
            </div>
            <video
              ref={remoteVideoRef}
              className="hero-video"
              playsInline
              muted
              onClick={() => {
                const v = remoteVideoRef.current;
                if (!v) return;
                v.requestFullscreen?.().catch(() => undefined);
              }}
            />
          </div>
        )}

        {/* ---- Polled stream (RTSP / USB / video URL): single hero image
               that refreshes in place + secondary thumbs. */}
        {outputTab === "visual" &&
          !webRtcRef.current &&
          result.kind === "stream" &&
          (() => {
            const hero = pickHeroImage(images);
            const secondaries = hero
              ? images.filter((i) => i !== hero)
              : [];
            const fps = computeFps(frameTimestampsRef.current);
            const sinceLast = result.lastFrameAt
              ? `${Math.round((Date.now() - result.lastFrameAt) / 100) / 10}s`
              : "…";
            return (
              <div className="stream-viewer">
                <div className="stream-chrome">
                  <span
                    className={`live-dot ${paused ? "paused" : result.lastFrameAt ? "on" : "waiting"}`}
                  />
                  <span className="live-label">
                    {paused
                      ? "PAUSED"
                      : result.lastFrameAt
                      ? "LIVE"
                      : "CONNECTING…"}
                  </span>
                  <span className="stat">{result.frames} frames</span>
                  {fps != null && (
                    <span
                      className={`stat ${fps < 2 ? "slow" : ""}`}
                      title={
                        fps < 2
                          ? "Effective framerate is low because inference on each frame is slow. SAM3 is the likely bottleneck — try a lighter model (YOLOv8-nano) for realtime, or throttle the source with max fps."
                          : undefined
                      }
                    >
                      {fps.toFixed(1)} fps{fps < 2 ? " ⚠" : ""}
                    </span>
                  )}
                  <button
                    className={`chrome-btn ${recording ? "rec-on" : ""}`}
                    onClick={toggleRecording}
                    title={
                      recording
                        ? "Stop recording — clip will be saved below"
                        : "Record the live annotated stream to a local WebM you can download"
                    }
                    disabled={!hero}
                  >
                    {recording ? "⏹ Recording" : "⏺ Record"}
                  </button>
                  <button
                    className="chrome-btn"
                    onClick={() => saveSnapshot(hero?.src ?? null)}
                    disabled={!hero}
                    title="Save the current frame as a PNG"
                  >
                    📸 Snap
                  </button>
                  <div className="spacer" />
                  <span className="stat muted">last {sinceLast}</span>
                </div>
                {hero ? (
                  <img
                    className="hero-image"
                    src={hero.src}
                    alt={hero.path}
                    onClick={() => setFullscreenSrc(hero.src)}
                  />
                ) : (
                  <div className="empty">
                    Pipeline running — waiting for the first annotated
                    frame…
                  </div>
                )}
                {hero && (
                  <div className="hero-caption">
                    {hero.path}
                    <span className="hint">click to expand</span>
                  </div>
                )}
                {secondaries.length > 0 && (
                  <div className="secondary-tiles">
                    {secondaries.map((img, i) => (
                      <div className="tile" key={`${img.path}-${i}`}>
                        <img
                          src={img.src}
                          alt={img.path}
                          onClick={() => setFullscreenSrc(img.src)}
                        />
                        <div className="caption">{img.path}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

        {/* ---- One-shot Image mode: gallery of every image output. */}
        {outputTab === "visual" &&
          !webRtcRef.current &&
          result.kind === "image" &&
          images.length > 0 && (
            <div className="output-images">
              {images.map((img, i) => (
                <div className="output-image" key={`${img.path}-${i}`}>
                  <img
                    src={img.src}
                    alt={img.path}
                    onClick={() => setFullscreenSrc(img.src)}
                  />
                  <div className="caption">{img.path}</div>
                </div>
              ))}
            </div>
          )}
        {outputTab === "visual" &&
          !webRtcRef.current &&
          result.kind === "image" &&
          images.length === 0 && (
            <div className="empty">No image-shaped outputs. Switch to JSON.</div>
          )}

        {outputTab === "json" && latestPayload && (
          <pre>{JSON.stringify(redactImages(latestPayload), null, 2)}</pre>
        )}

        {/* Hidden canvas used by MediaRecorder. Always present while the
            panel is mounted so recording can start at any moment. */}
        <canvas
          ref={captureCanvasRef}
          style={{ display: "none" }}
          width={640}
          height={360}
        />

        {recordedClips.length > 0 && (
          <div className="recorded-clips">
            <div className="section-title">
              Recorded clips ({recordedClips.length})
            </div>
            {recordedClips.map((c) => {
              const secs = (c.durationMs / 1000).toFixed(1);
              const kb = Math.round(c.size / 1024);
              const display = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
              return (
                <div className="clip" key={c.id}>
                  <video
                    src={c.url}
                    controls
                    playsInline
                    className="clip-video"
                  />
                  <div className="clip-meta">
                    <span className="stat">{secs}s · {display}</span>
                    <div className="spacer" />
                    <a
                      href={c.url}
                      download={`flybuild-${new Date(c.createdAt).toISOString().replace(/[:.]/g, "-")}.webm`}
                      className="chrome-btn"
                    >
                      ⬇ Download
                    </a>
                    <button
                      className="chrome-btn danger"
                      onClick={() => {
                        URL.revokeObjectURL(c.url);
                        setRecordedClips((prev) =>
                          prev.filter((x) => x.id !== c.id),
                        );
                      }}
                      title="Delete clip"
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {fullscreenSrc && (
        <div
          className="fullscreen-backdrop"
          onClick={() => setFullscreenSrc(null)}
        >
          <img src={fullscreenSrc} alt="full" />
          <button
            className="icon-btn close"
            onClick={() => setFullscreenSrc(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
