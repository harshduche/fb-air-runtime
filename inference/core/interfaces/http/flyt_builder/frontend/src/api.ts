// Thin fetch wrappers for the FlytBase builder backend.
//
// All mutating /flybuild/api/* calls require the CSRF token injected at page
// load by routes.py via window.__FLYBUILD__. /workflows/* and /infer/* are
// CORS-enabled and take no auth for local use.

declare global {
  interface Window {
    __FLYBUILD__?: { csrf: string };
  }
}

const CSRF = window.__FLYBUILD__?.csrf ?? "";

export type BlockOutputDef = {
  name: string;
  kind?: Array<{ name?: string } | string>;
};

export type BlockDef = {
  manifest_type_identifier: string;
  human_friendly_block_name?: string;
  block_schema?: {
    type?: string;
    properties?: Record<string, BlockParamSchema>;
    required?: string[];
    // Roboflow stashes rich UI metadata here. Shape is not fully typed
    // upstream; we only read a handful of hints.
    json_schema_extra?: Record<string, any>;
    // Sometimes the UI manifest is hoisted to the top level of block_schema.
    ui_manifest?: Record<string, any>;
  };
  block_source?: string;
  outputs_manifest?: BlockOutputDef[];
};

export type BlockParamSchema = {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  anyOf?: Array<{ type?: string; enum?: unknown[]; $ref?: string }>;
  allOf?: unknown[];
  items?: any;
  title?: string;
  minimum?: number;
  maximum?: number;
  // Roboflow-specific hints tucked under json_schema_extra or similar
  json_schema_extra?: Record<string, any>;
  // For step-reference fields — not always present, used as a hint.
  reference?: boolean;
};

export type BlocksDescribeResponse = {
  blocks: BlockDef[];
  kinds_connections?: Record<
    string,
    Array<{ manifest_type_identifier: string; property_name: string }>
  >;
  declared_kinds?: Array<{ name: string; description?: string }>;
};

export async function describeBlocks(): Promise<BlocksDescribeResponse> {
  const res = await fetch("/workflows/blocks/describe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`blocks/describe ${res.status}`);
  return (await res.json()) as BlocksDescribeResponse;
}

// ---- Workflow CRUD ----

export async function saveWorkflow(id: string, specification: unknown): Promise<void> {
  const res = await fetch(`/flybuild/api/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF": CSRF },
    body: JSON.stringify({ id, specification }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`save ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function loadWorkflow(id: string, version?: number): Promise<any> {
  const q = version != null ? `?version=${version}` : "";
  const res = await fetch(`/flybuild/api/${encodeURIComponent(id)}${q}`, {
    headers: { "X-CSRF": CSRF },
  });
  if (!res.ok) throw new Error(`load ${res.status}`);
  const d = await res.json();
  return d.data?.config?.specification ?? d.data?.config ?? {};
}

// Load but also return the version metadata — used by the Builder topbar
// to show the current version badge.
export async function loadWorkflowMeta(
  id: string,
): Promise<{
  spec: any;
  version: number;
  versions: number[];
  current_version: number;
}> {
  const res = await fetch(`/flybuild/api/${encodeURIComponent(id)}`, {
    headers: { "X-CSRF": CSRF },
  });
  if (!res.ok) throw new Error(`load ${res.status}`);
  const d = await res.json();
  const data = d.data || {};
  return {
    spec: data.config?.specification ?? data.config ?? {},
    version: Number(data.version ?? 1),
    versions: Array.isArray(data.versions) ? data.versions : [],
    current_version: Number(data.current_version ?? 1),
  };
}

export async function listWorkflows(): Promise<Record<string, any>> {
  const res = await fetch(`/flybuild/api`, { headers: { "X-CSRF": CSRF } });
  if (!res.ok) throw new Error(`list ${res.status}`);
  const d = await res.json();
  return d.data || {};
}

export async function deleteWorkflow(id: string): Promise<void> {
  const res = await fetch(`/flybuild/api/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-CSRF": CSRF },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`delete ${res.status} ${text.slice(0, 200)}`);
  }
}

// ---- Versioning ----

export async function publishWorkflow(
  id: string,
  specification?: unknown,
): Promise<{ version: number }> {
  const body = specification ? { id, specification } : undefined;
  const res = await fetch(`/flybuild/api/${encodeURIComponent(id)}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF": CSRF },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`publish ${res.status}`);
  const d = await res.json();
  return { version: Number(d.version ?? 1) };
}

export async function listVersions(id: string): Promise<{
  current_version: number;
  versions: Array<{
    version: number;
    createTime: number;
    updateTime: number;
    is_current: boolean;
  }>;
}> {
  const res = await fetch(
    `/flybuild/api/${encodeURIComponent(id)}/versions`,
    { headers: { "X-CSRF": CSRF } },
  );
  if (!res.ok) throw new Error(`versions ${res.status}`);
  const d = await res.json();
  return {
    current_version: Number(d.data?.current_version ?? 1),
    versions: d.data?.versions || [],
  };
}

export async function restoreVersion(
  id: string,
  version: number,
): Promise<{ version: number }> {
  const res = await fetch(
    `/flybuild/api/${encodeURIComponent(id)}/restore?version=${version}`,
    { method: "POST", headers: { "X-CSRF": CSRF } },
  );
  if (!res.ok) throw new Error(`restore ${res.status}`);
  const d = await res.json();
  return { version: Number(d.version ?? 1) };
}

// ---- Fixtures (per-workflow scene-image library) ----

export type Fixture = {
  name: string;
  size: number;
  mtime: number;
};

export type FixtureLimits = {
  max_per_workflow: number;
  max_bytes_per_file: number;
};

export async function listFixtures(id: string): Promise<{
  data: Fixture[];
  limits: FixtureLimits;
}> {
  const res = await fetch(
    `/flybuild/api/${encodeURIComponent(id)}/fixtures`,
    { headers: { "X-CSRF": CSRF } },
  );
  if (!res.ok) throw new Error(`fixtures ${res.status}`);
  const d = await res.json();
  return {
    data: Array.isArray(d.data) ? d.data : [],
    limits: d.limits || { max_per_workflow: 0, max_bytes_per_file: 0 },
  };
}

export async function uploadFixture(
  id: string,
  file: File,
): Promise<{ name: string; size: number; replaced: boolean }> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch(
    `/flybuild/api/${encodeURIComponent(id)}/fixtures`,
    { method: "POST", headers: { "X-CSRF": CSRF }, body: fd },
  );
  if (!res.ok) {
    let msg = `upload ${res.status}`;
    try {
      const err = await res.json();
      if (err.error) msg = err.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

export async function deleteFixture(id: string, name: string): Promise<void> {
  const res = await fetch(
    `/flybuild/api/${encodeURIComponent(id)}/fixtures/${encodeURIComponent(name)}`,
    { method: "DELETE", headers: { "X-CSRF": CSRF } },
  );
  if (!res.ok) throw new Error(`delete fixture ${res.status}`);
}

// Build a same-origin fetch-then-data-URL for a fixture. We need a
// data URL (not the raw URL) so it round-trips through the existing
// `runtime_parameters.image: {type: base64, value}` path the engine
// expects on /infer/workflows.
export async function fixtureToDataUrl(
  id: string,
  name: string,
): Promise<string> {
  const res = await fetch(
    `/flybuild/api/${encodeURIComponent(id)}/fixtures/${encodeURIComponent(name)}`,
    { headers: { "X-CSRF": CSRF } },
  );
  if (!res.ok) throw new Error(`fixture ${res.status}`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

// Import a `.flyttmpl.tar.gz` as a new workflow. Accepts both the
// builder's slim variant and Studio's full bundle — the importer
// extracts only `manifest.yaml`, `postprocess/workflow.json`, and
// `fixtures/test_inputs/` (model weights / widget / alerts / card are
// dropped, since the builder doesn't author those).
export async function importBundle(
  file: File,
): Promise<{
  id: string;
  name: string;
  version: number;
  fixtures_count: number;
  source: { root: string; schema_version: string; provenance: any };
}> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch(`/flybuild/api/import_bundle`, {
    method: "POST",
    headers: { "X-CSRF": CSRF },
    body: fd,
  });
  if (!res.ok) {
    let msg = `import ${res.status}`;
    try {
      const err = await res.json();
      if (err.error) msg = err.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

// Fetch the .flyttmpl bundle for a workflow version and trigger a save
// dialog in the browser. We pull as Blob (not <a href>) because the
// download endpoint requires the X-CSRF header — anchor downloads can't
// carry custom headers.
export async function downloadBundle(
  id: string,
  version?: number,
): Promise<{ filename: string; size: number }> {
  const url = version != null
    ? `/flybuild/api/${encodeURIComponent(id)}/bundle?version=${version}`
    : `/flybuild/api/${encodeURIComponent(id)}/bundle`;
  const res = await fetch(url, { headers: { "X-CSRF": CSRF } });
  if (!res.ok) throw new Error(`bundle ${res.status}`);
  // Pull filename out of Content-Disposition; fall back to a sensible
  // default if the server omitted it.
  const cd = res.headers.get("Content-Disposition") || "";
  const m = cd.match(/filename="?([^";]+)"?/i);
  const filename = m ? m[1] : `${id}.flyttmpl`;
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click handler has had a chance to start the
  // download. 1s is comfortably more than any browser needs.
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  return { filename, size: blob.size };
}

// ---- Templates + devices + local models ----

export type Template = {
  id: string;
  name: string;
  description: string;
  specification: any;
};

export async function listTemplates(): Promise<Template[]> {
  const res = await fetch(`/flybuild/api/templates`, {
    headers: { "X-CSRF": CSRF },
  });
  if (!res.ok) throw new Error(`templates ${res.status}`);
  const d = await res.json();
  return (d.data || []) as Template[];
}

export async function listDevices(): Promise<Array<{ path: string; index: number | null; label: string }>> {
  const res = await fetch(`/flybuild/api/devices`, {
    headers: { "X-CSRF": CSRF },
  });
  if (!res.ok) return [];
  const d = await res.json();
  return d.data || [];
}

export async function listLocalModels(): Promise<Array<{ id: string; label: string }>> {
  const res = await fetch(`/flybuild/api/local_models`, {
    headers: { "X-CSRF": CSRF },
  });
  if (!res.ok) return [];
  const d = await res.json();
  return d.data || [];
}

// ---- Run: one-shot /infer/workflows ----

export async function runWorkflow(
  specification: unknown,
  inputs: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`/infer/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: "",
      inputs,
      specification,
    }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(
      `run ${res.status}: ${typeof parsed === "string" ? parsed.slice(0, 500) : JSON.stringify(parsed).slice(0, 500)}`,
    );
  }
  return parsed;
}

// ---- Streaming: /inference_pipelines/* ----

export type PipelineInitResult = {
  pipeline_id: string;
};

export async function initPipeline(opts: {
  specification: any;
  video_reference: string | number;
  image_input_name?: string;
  max_fps?: number;
  workflows_parameters?: Record<string, unknown>;
  /** Optional abort signal so the caller can cancel a Run while it's
   *  still initialising (useful when the stream-manager is wedged —
   *  clicking Stop will actually release the UI from "Starting…"). */
  signal?: AbortSignal;
}): Promise<PipelineInitResult> {
  const body = {
    api_key: "",
    video_configuration: {
      type: "VideoConfiguration",
      video_reference: opts.video_reference,
      max_fps: opts.max_fps ?? null,
    },
    processing_configuration: {
      type: "WorkflowConfiguration",
      workflow_specification: opts.specification,
      image_input_name: opts.image_input_name ?? "image",
      workflows_parameters: opts.workflows_parameters ?? {},
    },
    sink_configuration: {
      type: "MemorySinkConfiguration",
      results_buffer_size: 16,
    },
  };
  // Combined signal: caller's abort + a 180s ceiling, matching the
  // server-side `RESPONSE_WAIT_TIMEOUT` in manager_app/app.py. Cold-
  // start init legitimately needs ~60-120s on CPU (torch + cv2 imports
  // in the spawned process + SAM3 weights load). Going below the
  // server's own deadline just produces false positives where the
  // client gives up on an init that's still making progress.
  const localController = new AbortController();
  const timer = window.setTimeout(() => localController.abort(), 180000);
  const combined = new AbortController();
  const onExternal = () => combined.abort();
  opts.signal?.addEventListener("abort", onExternal);
  localController.signal.addEventListener("abort", () => combined.abort());
  let res: Response;
  try {
    res = await fetch(`/inference_pipelines/initialise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: combined.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(
        opts.signal?.aborted
          ? "Run cancelled"
          : "Initialise timed out after 180s — stream manager is likely wedged (docker restart flytbase-infer-v122)",
      );
    }
    throw e;
  } finally {
    window.clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternal);
  }
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    throw new Error(
      `init_pipeline ${res.status}: ${text.slice(0, 400)}`,
    );
  }
  const pid =
    parsed.pipeline_id ||
    parsed.context?.pipeline_id ||
    parsed.response?.context?.pipeline_id;
  if (!pid) {
    throw new Error(`init_pipeline: missing pipeline_id in ${text.slice(0, 200)}`);
  }
  return { pipeline_id: pid };
}

export class ConsumeTimeoutError extends Error {
  constructor() {
    super("consume timed out");
    this.name = "ConsumeTimeoutError";
  }
}

/** 404 from /consume/<id> — the pipeline has been evicted from the
 *  manager's table. Either it finished the video, hit an error in the
 *  child process (and our upstream patch reaped it), or was manually
 *  terminated. Caller should stop polling, not retry. */
export class PipelineGoneError extends Error {
  constructor() {
    super("pipeline no longer exists");
    this.name = "PipelineGoneError";
  }
}

export async function consumePipeline(
  pipelineId: string,
): Promise<{ outputs: any[]; frames_metadata: any[] }> {
  // Per-request timeout. The inference server's manager has historically
  // wedged with stuck connections; without a bound here those fetches
  // hang forever and exhaust Chrome's 6-per-host connection pool. But
  // the timeout also has to be long enough to tolerate SAM3-style heavy
  // inference where a consume might legitimately take 3–8s on CPU.
  // Throw a typed error so the caller can distinguish "slow" from "dead".
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(
      `/inference_pipelines/${encodeURIComponent(pipelineId)}/consume?excluded_fields=`,
      { method: "GET", signal: controller.signal },
    );
    if (res.status === 404) throw new PipelineGoneError();
    if (!res.ok) throw new Error(`consume ${res.status}`);
    const d = await res.json();
    return {
      outputs: d.outputs || d.result?.outputs || [],
      frames_metadata: d.frames_metadata || d.result?.frames_metadata || [],
    };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new ConsumeTimeoutError();
    throw e;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function terminatePipeline(pipelineId: string): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(
      `/inference_pipelines/${encodeURIComponent(pipelineId)}/terminate`,
      { method: "POST", signal: controller.signal },
    );
  } catch {
    /* best-effort: if the manager is already wedged there's nothing we
       can do from the browser; pipeline will be reaped when the server
       restarts. */
  } finally {
    window.clearTimeout(timer);
  }
}

// WebRTC offer → server answer.
export async function initPipelineWebRTC(opts: {
  specification: any;
  offer: RTCSessionDescriptionInit;
  image_input_name?: string;
  workflows_parameters?: Record<string, unknown>;
}): Promise<{ pipeline_id: string; answer: RTCSessionDescriptionInit }> {
  const body = {
    api_key: "",
    video_configuration: {
      type: "VideoConfiguration",
      // WebRTC implementations ignore video_reference on the server
      // side (frames come via the peer connection), but the Pydantic
      // model still requires the field. Use a stable sentinel.
      video_reference: "webrtc://browser",
    },
    processing_configuration: {
      type: "WorkflowConfiguration",
      workflow_specification: opts.specification,
      image_input_name: opts.image_input_name ?? "image",
      workflows_parameters: opts.workflows_parameters ?? {},
    },
    sink_configuration: {
      type: "MemorySinkConfiguration",
      results_buffer_size: 16,
    },
    webrtc_offer: opts.offer,
    webrtc_realtime_processing: true,
    stream_output: [],
    data_output: [],
  };
  const res = await fetch(`/inference_pipelines/initialise_webrtc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    throw new Error(`init_webrtc ${res.status}: ${text.slice(0, 400)}`);
  }
  const pid =
    parsed.pipeline_id ||
    parsed.context?.pipeline_id ||
    parsed.response?.context?.pipeline_id;
  const answer =
    parsed.sdp && parsed.type
      ? ({ sdp: parsed.sdp, type: parsed.type } as RTCSessionDescriptionInit)
      : parsed.answer || parsed.webrtc_answer;
  if (!pid || !answer) {
    throw new Error(`init_webrtc: malformed response ${text.slice(0, 300)}`);
  }
  return { pipeline_id: pid, answer };
}
