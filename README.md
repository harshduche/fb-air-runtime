# fb-air-runtime

FlytBase **AI-R Edge** runtime. A fork of [roboflow/inference](https://github.com/roboflow/inference) (Apache 2.0)
that runs the Roboflow Workflows execution engine locally — no Roboflow
cloud required at runtime — plus a drop-in local workflow builder at
`/flybuild`.

Used as the template-execution engine for FlytBase edge AI pipelines.

---

## What's different from upstream

| Area | Change |
|------|--------|
| **Local builder** | `inference/core/interfaces/http/flyt_builder/` — a React SPA served at `/flybuild` that replaces the cloud `/build` iframe. CRUD, versioning, live streaming, keep-warm pipelines. |
| **Stream manager** | `ThreadingMixIn` on the manager's TCP server + bounded response-wait timeout + dead-child eviction. Fixes head-of-line blocking when `SAM3` init takes tens of seconds. |
| **Templates** | Four seed workflows shipped in-container (`flyt_builder/templates/`): detect+visualize, SAM3 with prompts, crop+classify, people tracker. |
| **Brand/theme** | FlytBase palette (navy + teal→green + blue→cyan), Roboto/Montserrat/PT Mono type stack. |

Everything else tracks upstream. `origin` still points at
`roboflow/inference` so periodic rebases stay cheap.

---

## Quick start

**Hardware**: any Linux host with Docker + NVIDIA Container Toolkit.
CUDA GPU strongly recommended (SAM3 on CPU is 1–3 fps).

```bash
docker run -d --name flytbase-infer-v122 \
  --gpus all \
  -p 9001:9001 -p 9002:9002 \
  -e STREAM_API_PRELOADED_PROCESSES=1 \
  -v $PWD/inference/core/interfaces/http/flyt_builder:/app/inference/core/interfaces/http/flyt_builder \
  -v $PWD/inference/core/interfaces/stream_manager/manager_app/app.py:/app/inference/core/interfaces/stream_manager/manager_app/app.py \
  -v $PWD/inference/core/interfaces/stream_manager/manager_app/tcp_server.py:/app/inference/core/interfaces/stream_manager/manager_app/tcp_server.py \
  -v $PWD/inference/core/interfaces/http/http_api.py:/app/inference/core/interfaces/http/http_api.py \
  -v $PWD/inference/core/env.py:/app/inference/core/env.py \
  roboflow/roboflow-inference-server-gpu
```

Then open:

- **Flow builder**: <http://localhost:9001/flybuild>
- **Upstream Roboflow UI**: <http://localhost:9001>
- **API docs**: <http://localhost:9001/docs>

---

## Frontend development

The `/flybuild` SPA lives at
`inference/core/interfaces/http/flyt_builder/frontend/`.

```bash
cd inference/core/interfaces/http/flyt_builder/frontend

# If running on Alpine (musl), rollup needs its musl binary.
docker run --rm -v "$PWD":/app -w /app node:20-alpine sh -c \
  "npm install @rollup/rollup-linux-x64-musl --no-save && npm run build"

# Or natively:
npm install
npm run build
```

The container bind-mounts `flyt_builder/`, so a fresh `dist/` is picked
up on the next full-page reload (index HTML is served with `no-store`
to defeat SPA caching).

---

## Repo layout

```
inference/core/interfaces/http/flyt_builder/   # local builder backend + SPA
inference/core/interfaces/stream_manager/      # upstream patches (threaded TCP + timeouts)
flytbase/docs/                                 # internal design + implementation notes
```

Internal context (plans, phase reports, design decisions) lives under
`flytbase/docs/`. Start at `06_flow_builder_plan.md` and
`08_flow_builder_full_implementation_report.md`.

---

## Constraints (do not violate)

- **Apache 2.0**. Upstream license preserved as-is; retain attribution
  and the `LICENSE.core` file.
- **No Roboflow cloud at runtime.** Everything resolves against the
  local model cache and local workflow store. Do not reintroduce
  outbound Roboflow API calls on the hot path.
- **No telemetry exfil.** No phone-home in this fork.
- **`enterprise/` is untouchable.** Leave it exactly as upstream ships
  it. Any changes belong in `inference/` or `flyt_builder/`.

---

## Upstream tracking

```bash
git remote -v
# origin  https://github.com/roboflow/inference.git  (upstream)
# fork    https://github.com/harshduche/fb-air-runtime.git  (this repo)

git fetch origin
git rebase origin/main  # when you want to pick up upstream changes
```

---

## License

Apache 2.0. See [`LICENSE.core`](./LICENSE.core). Original work
© Roboflow, Inc.
