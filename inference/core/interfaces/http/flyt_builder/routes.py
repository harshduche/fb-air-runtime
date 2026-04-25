"""FastAPI router for the FlytBase flow builder (/flybuild).

Mirrors the shape of ``inference/core/interfaces/http/builder/routes.py``
but serves a locally-bundled React SPA instead of iframing the Roboflow
cloud editor, and uses an isolated workflow store at
``$MODEL_CACHE_DIR/workflow/flyt/`` so edits do not bleed across into
the upstream builder during A/B.

Storage layout (version-aware, added in phase B):

    $MODEL_CACHE_DIR/workflow/flyt/
    ├── .csrf
    ├── <sha256(id)>/
    │   ├── meta.json       # {id, current_version, versions[]}
    │   ├── v1.json         # {id, specification, created_at}
    │   └── v2.json
    └── <sha256(id2)>/...

Phase-A saved to ``<sha>.json`` (flat, no version). We migrate those
lazily on read: the first GET/LIST that encounters a flat file moves it
into ``<sha>/v1.json`` and writes a ``meta.json``. Migration is
idempotent.
"""

import datetime
import glob
import io
import json
import logging
import os
import re
import shutil
import tarfile
import time
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from starlette.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
)
from starlette.status import HTTP_201_CREATED, HTTP_400_BAD_REQUEST, HTTP_404_NOT_FOUND

from inference.core.env import MODEL_CACHE_DIR
from inference.core.interfaces.http.error_handlers import with_route_exceptions_async

logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).parent / "frontend" / "dist"
FRONTEND_ASSETS_DIR = FRONTEND_DIR / "assets"
TEMPLATES_DIR = Path(__file__).parent / "templates"

workflow_flyt_dir = Path(MODEL_CACHE_DIR) / "workflow" / "flyt"
workflow_flyt_dir.mkdir(parents=True, exist_ok=True)

router = APIRouter()

csrf_file = workflow_flyt_dir / ".csrf"
if csrf_file.exists():
    csrf = csrf_file.read_text()
else:
    csrf = os.urandom(16).hex()
    csrf_file.write_text(csrf)


def verify_csrf_token(x_csrf: str = Header(None)):
    if x_csrf != csrf:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Invalid CSRF token"
        )


_RESERVED_WORKFLOW_IDS: set = set()
_ID_RE = re.compile(r"^[\w\-]+$")


def _index_html() -> str:
    """Read the built SPA index.html and inject runtime config.

    The dev-mode fallback returns a minimal placeholder when the SPA
    has not been built yet — useful so the route still responds 200
    during local development.
    """
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        return (
            "<!doctype html><html><head><title>FlytBase Builder "
            "(not built)</title></head><body style='font-family:sans-serif;"
            "padding:2rem'><h1>FlytBase Flow Builder</h1><p>Frontend "
            "bundle not found. Run <code>npm install &amp;&amp; npm run "
            "build</code> in "
            "<code>inference/core/interfaces/http/flyt_builder/frontend/</code>.</p>"
            f"<p>CSRF token (for API calls): <code>{csrf}</code></p>"
            "</body></html>"
        )
    html = index_path.read_text(encoding="utf-8")
    injection = (
        f"<script>window.__FLYBUILD__={{csrf:{json.dumps(csrf)}}};</script>"
    )
    if "</head>" in html:
        html = html.replace("</head>", f"{injection}</head>", 1)
    else:
        html = injection + html
    return html


# ---------------------------------------------------------------------------
# Workflow storage helpers
# ---------------------------------------------------------------------------


def _dir_for(workflow_id: str) -> Path:
    return workflow_flyt_dir / sha256(workflow_id.encode()).hexdigest()


def _legacy_flat_path(workflow_id: str) -> Path:
    return workflow_flyt_dir / f"{sha256(workflow_id.encode()).hexdigest()}.json"


def _meta_path(workflow_id: str) -> Path:
    return _dir_for(workflow_id) / "meta.json"


def _version_path(workflow_id: str, version: int) -> Path:
    return _dir_for(workflow_id) / f"v{version}.json"


# ---- Fixture storage ---------------------------------------------------
#
# Fixtures live alongside the workflow at ``<sha>/fixtures/<safename>``,
# so deleting the workflow also deletes its fixtures (clean lifecycle).
# Caps are deliberately small for v0 — users who need bigger libraries
# should reach for Frame Storage (Studio's per-tenant object store)
# instead. Total per-workflow ceiling = 5 × 10 MB = 50 MB.

FIXTURES_DIR_NAME = "fixtures"
FIXTURE_MAX_BYTES = 10 * 1024 * 1024
FIXTURES_MAX_PER_WORKFLOW = 5
# Allow letters/digits/dash/underscore/dot, require an extension of
# 1-5 alphanumeric chars. Rejects path traversal and weird filenames.
_FIXTURE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,80}\.[A-Za-z0-9]{1,5}$")


def _fixtures_dir(workflow_id: str) -> Path:
    return _dir_for(workflow_id) / FIXTURES_DIR_NAME


def _sanitize_fixture_name(raw: str) -> Optional[str]:
    """Trim directory parts, normalise, accept only safe names.

    Returns the cleaned name, or None if it can't be made safe. We
    reject rather than silently rewriting so the user knows something
    happened (e.g. uploading "../../etc/passwd").
    """
    if not raw:
        return None
    # Strip any directory components (Windows + posix).
    raw = raw.replace("\\", "/").rsplit("/", 1)[-1].strip()
    # Map spaces and stray characters to underscore so a typical
    # "drone view 1.jpg" upload doesn't get rejected outright.
    cleaned = re.sub(r"[^A-Za-z0-9_.\-]", "_", raw)
    if cleaned.startswith("."):
        cleaned = cleaned.lstrip(".")
    if not _FIXTURE_NAME_RE.match(cleaned):
        return None
    return cleaned


def _migrate_if_flat(workflow_id: str) -> bool:
    """Move a phase-A flat ``<sha>.json`` into the versioned layout.

    Returns True if a migration happened. Idempotent: if the versioned
    directory already exists, the flat file is left alone so nothing
    gets overwritten, and we return False.
    """
    flat = _legacy_flat_path(workflow_id)
    vdir = _dir_for(workflow_id)
    if not flat.exists() or vdir.exists():
        return False
    try:
        with flat.open("r", encoding="utf-8") as f:
            contents = json.load(f)
    except Exception as e:
        logger.error(f"flyt migrate: could not read {flat}: {e}")
        return False
    vdir.mkdir(parents=True, exist_ok=True)
    created_at = int(flat.stat().st_ctime)
    contents["created_at"] = contents.get("created_at", created_at)
    _version_path(workflow_id, 1).write_text(
        json.dumps(contents, indent=2), encoding="utf-8"
    )
    _meta_path(workflow_id).write_text(
        json.dumps(
            {
                "id": workflow_id,
                "current_version": 1,
                "versions": [1],
                "migrated_from_flat": True,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    try:
        flat.unlink()
    except Exception as e:
        logger.warning(f"flyt migrate: flat file retained after copy: {e}")
    return True


def _migrate_all_flat() -> int:
    """Called at each LIST so stale flat files eventually all move."""
    migrated = 0
    for f in workflow_flyt_dir.glob("*.json"):
        if f.name == ".csrf":
            continue
        # Resolve the id by reading the file — we can't reverse sha256.
        try:
            with f.open("r", encoding="utf-8") as h:
                data = json.load(h)
            wid = data.get("id")
        except Exception:
            continue
        if not wid:
            continue
        if _migrate_if_flat(wid):
            migrated += 1
    return migrated


def _read_meta(workflow_id: str) -> Optional[dict]:
    p = _meta_path(workflow_id)
    if not p.exists():
        return None
    try:
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"flyt: bad meta {p}: {e}")
        return None


def _write_meta(workflow_id: str, meta: dict) -> None:
    p = _meta_path(workflow_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _read_version(workflow_id: str, version: int) -> Optional[dict]:
    p = _version_path(workflow_id, version)
    if not p.exists():
        return None
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)


def _write_version(workflow_id: str, version: int, payload: dict) -> None:
    p = _version_path(workflow_id, version)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(payload)
    payload["created_at"] = int(time.time())
    p.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _validate_id(workflow_id: str) -> Optional[JSONResponse]:
    if not _ID_RE.match(workflow_id):
        return JSONResponse(
            {"error": "invalid id"}, status_code=HTTP_400_BAD_REQUEST
        )
    if workflow_id in _RESERVED_WORKFLOW_IDS:
        return JSONResponse(
            {"error": f"'{workflow_id}' is reserved"},
            status_code=HTTP_400_BAD_REQUEST,
        )
    return None


# ---------------------------------------------------------------------------
# SPA routes
# ---------------------------------------------------------------------------


_SPA_NO_CACHE = {
    # The shell HTML references hashed assets (index-xxxxxx.js). If the
    # browser caches this file, a new build's assets are unreachable
    # until the user clears cache — we've seen users report "Lost
    # connection" errors that were actually just stale JS running old
    # error paths. Assets themselves stay `immutable` below; only the
    # index document needs to bypass cache.
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}


@router.get("", summary="FlytBase Flow Builder", description="SPA entrypoint")
@with_route_exceptions_async
async def flybuild_root():
    return HTMLResponse(_index_html(), headers=_SPA_NO_CACHE)


@router.get("/", include_in_schema=False)
async def flybuild_trailing_slash_redirect():
    return RedirectResponse(url="/flybuild", status_code=302)


@router.get(
    "/edit/{workflow_id}",
    summary="Edit a workflow in the FlytBase builder",
)
@with_route_exceptions_async
async def flybuild_edit(workflow_id: str):
    return HTMLResponse(_index_html(), headers=_SPA_NO_CACHE)


# ---------------------------------------------------------------------------
# Workflow CRUD
# ---------------------------------------------------------------------------


@router.get("/api", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def list_workflows():
    _migrate_all_flat()
    data: Dict[str, Any] = {}
    for sub in workflow_flyt_dir.iterdir():
        if not sub.is_dir():
            continue
        meta = sub / "meta.json"
        if not meta.exists():
            continue
        try:
            with meta.open("r", encoding="utf-8") as f:
                meta_d = json.load(f)
        except Exception:
            continue
        wid = meta_d.get("id")
        if not wid:
            continue
        current = int(meta_d.get("current_version", 1))
        vfile = sub / f"v{current}.json"
        if not vfile.exists():
            continue
        stat_info = vfile.stat()
        try:
            with vfile.open("r", encoding="utf-8") as f:
                config_contents = json.load(f)
        except json.JSONDecodeError:
            continue
        data[wid] = {
            "createTime": {"_seconds": int(stat_info.st_ctime)},
            "updateTime": {"_seconds": int(stat_info.st_mtime)},
            "config": config_contents,
            "version": current,
            "versions": list(meta_d.get("versions", [])),
        }
    return Response(
        content=json.dumps({"data": data}, indent=2),
        media_type="application/json",
        status_code=200,
    )


# NOTE: specific literal paths (/api/templates, /api/devices, /api/local_models)
# must be declared BEFORE the /api/{workflow_id} catch-all so FastAPI's
# router matches them as literals rather than treating "templates" etc.
# as a workflow_id. Keep that ordering when adding new routes.


@router.get("/api/templates", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def list_templates():
    out: List[dict] = []
    if not TEMPLATES_DIR.exists():
        return JSONResponse({"data": out}, status_code=200)
    for p in sorted(TEMPLATES_DIR.glob("*.json")):
        try:
            with p.open("r", encoding="utf-8") as f:
                body = json.load(f)
        except Exception as e:
            logger.warning(f"flyt template {p} unreadable: {e}")
            continue
        out.append(
            {
                "id": p.stem,
                "name": body.get("name") or p.stem.replace("_", " ").title(),
                "description": body.get("description", ""),
                "specification": body.get("specification", {}),
            }
        )
    return JSONResponse({"data": out}, status_code=200)


@router.get("/api/devices", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def list_devices():
    devices: List[dict] = []
    for path in sorted(glob.glob("/dev/video*")):
        try:
            idx = int(re.sub(r"\D", "", path))
        except ValueError:
            idx = None
        devices.append({"path": path, "index": idx, "label": path})
    return JSONResponse({"data": devices}, status_code=200)


@router.get("/api/local_models", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def list_local_models():
    """Lightweight scan: report top-level directories under MODEL_CACHE_DIR
    that look like model caches (skip our own workflow store and the
    cache DB). This is a friendly list for the Inspector's Model picker;
    it is NOT a source of truth for inference runtime.
    """
    out: List[dict] = []
    base = Path(MODEL_CACHE_DIR)
    if not base.exists():
        return JSONResponse({"data": out}, status_code=200)
    skip = {"workflow", "http_cache", "aws", "tmp"}
    for p in sorted(base.iterdir()):
        if not p.is_dir():
            continue
        if p.name in skip:
            continue
        has_children = any(c.is_dir() for c in p.iterdir() if not c.name.startswith("."))
        label = f"{p.name}/*" if has_children else p.name
        out.append({"id": p.name, "label": label})
    return JSONResponse({"data": out}, status_code=200)


# ---- Bundle import (.flyttmpl.tar.gz → new workflow) -------------------
#
# Reverse direction of the bundle endpoint. Accepts both flavours of
# bundle (builder slim AND Studio full); ignores the heavy parts of
# Studio bundles (model/, widget/, alerts/, card/, fixtures/expected_outputs/)
# since the builder doesn't author those — we only need the workflow
# spec + test fixtures.

IMPORT_MAX_BYTES = 200 * 1024 * 1024  # 200 MB — generous, covers Studio full bundles
IMPORT_SUPPORTED_SCHEMA_VERSIONS = {"0.1"}
# Per-fixture cap mirrors the upload-fixture endpoint so a hostile
# bundle can't smuggle a 5 GB image through the import path.
IMPORT_MAX_FIXTURES = 20  # higher than the upload cap so users can import a Studio bundle with several test inputs


def _disambiguate_id(desired: str) -> str:
    """Append `_imported_<N>` until a free workflow id is found.

    First call gets `<desired>` if free, else `<desired>_imported`,
    `<desired>_imported_2`, `<desired>_imported_3`, ... — capped at 50
    to bound the linear scan.
    """
    if not _dir_for(desired).exists() and not _legacy_flat_path(desired).exists():
        return desired
    base = f"{desired}_imported"
    for n in range(1, 51):
        candidate = base if n == 1 else f"{base}_{n}"
        if not _dir_for(candidate).exists() and not _legacy_flat_path(candidate).exists():
            return candidate
    raise HTTPException(
        status_code=409,
        detail="too many existing imports of this id; rename and retry",
    )


@router.post("/api/import_bundle", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def import_bundle(file: UploadFile = File(...)):
    """Import a `.flyttmpl.tar.gz` as a new workflow.

    The builder doesn't carry model weights or Studio-only sections —
    those are dropped during import. Only `manifest.yaml`,
    `postprocess/workflow.json`, and `fixtures/test_inputs/*` survive
    into builder storage.
    """
    payload = await file.read(IMPORT_MAX_BYTES + 1)
    if len(payload) > IMPORT_MAX_BYTES:
        return JSONResponse(
            {
                "error": (
                    f"bundle exceeds {IMPORT_MAX_BYTES // (1024 * 1024)} MB import cap"
                )
            },
            status_code=413,
        )
    if not payload:
        return JSONResponse(
            {"error": "empty upload"}, status_code=HTTP_400_BAD_REQUEST
        )

    try:
        tar = tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz")
    except (tarfile.ReadError, EOFError) as e:
        return JSONResponse(
            {"error": f"not a valid .flyttmpl.tar.gz: {e}"},
            status_code=HTTP_400_BAD_REQUEST,
        )

    try:
        # Find the bundle root — same logic as Studio's verifier:
        # the unique top-level directory member.
        members = tar.getmembers()
        roots = [m for m in members if "/" not in m.name.rstrip("/") and m.isdir()]
        if not roots:
            # Some tarballs lack explicit DIRTYPE entries; fall back
            # to inferring from the first path component.
            seen: set = set()
            for m in members:
                head = m.name.split("/", 1)[0]
                if head:
                    seen.add(head)
            if len(seen) != 1:
                return JSONResponse(
                    {"error": "tarball does not contain a single top-level dir"},
                    status_code=HTTP_400_BAD_REQUEST,
                )
            root_name = next(iter(seen))
        else:
            root_name = roots[0].name.rstrip("/")

        # Read manifest.yaml. Required.
        manifest_path = f"{root_name}/manifest.yaml"
        manifest_member = next(
            (m for m in members if m.name == manifest_path), None
        )
        if manifest_member is None:
            return JSONResponse(
                {"error": "missing manifest.yaml"},
                status_code=HTTP_400_BAD_REQUEST,
            )
        manifest_bytes = tar.extractfile(manifest_member).read()
        try:
            manifest = yaml.safe_load(manifest_bytes)
        except yaml.YAMLError as e:
            return JSONResponse(
                {"error": f"manifest.yaml not valid YAML: {e}"},
                status_code=HTTP_400_BAD_REQUEST,
            )
        if not isinstance(manifest, dict):
            return JSONResponse(
                {"error": "manifest.yaml is not a mapping"},
                status_code=HTTP_400_BAD_REQUEST,
            )

        sv = manifest.get("schema_version")
        if sv not in IMPORT_SUPPORTED_SCHEMA_VERSIONS:
            return JSONResponse(
                {
                    "error": (
                        f"unsupported schema_version '{sv}'; "
                        f"supported: {sorted(IMPORT_SUPPORTED_SCHEMA_VERSIONS)}"
                    )
                },
                status_code=HTTP_400_BAD_REQUEST,
            )

        # Read workflow.json. Required.
        workflow_path = f"{root_name}/postprocess/workflow.json"
        workflow_member = next(
            (m for m in members if m.name == workflow_path), None
        )
        if workflow_member is None:
            return JSONResponse(
                {"error": "missing postprocess/workflow.json"},
                status_code=HTTP_400_BAD_REQUEST,
            )
        try:
            workflow_spec = json.loads(
                tar.extractfile(workflow_member).read().decode("utf-8")
            )
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            return JSONResponse(
                {"error": f"workflow.json not valid JSON: {e}"},
                status_code=HTTP_400_BAD_REQUEST,
            )

        # Optional: collect fixtures from fixtures/test_inputs/. Sized
        # individually against the upload-fixture cap; total count
        # against IMPORT_MAX_FIXTURES.
        fixture_prefix = f"{root_name}/fixtures/test_inputs/"
        fixture_payloads: List[Tuple[str, bytes]] = []
        for m in members:
            if not m.isfile():
                continue
            if not m.name.startswith(fixture_prefix):
                continue
            rel = m.name[len(fixture_prefix):]
            if not rel or "/" in rel:
                # Subdirectories under test_inputs/ are unexpected; skip.
                continue
            safe = _sanitize_fixture_name(rel)
            if safe is None:
                logger.warning(f"flyt import: skipping unsafe fixture name {rel}")
                continue
            if m.size > FIXTURE_MAX_BYTES:
                logger.warning(
                    f"flyt import: skipping {rel} — exceeds {FIXTURE_MAX_BYTES} bytes"
                )
                continue
            if len(fixture_payloads) >= IMPORT_MAX_FIXTURES:
                break
            fx_bytes = tar.extractfile(m).read()
            fixture_payloads.append((safe, fx_bytes))
    finally:
        tar.close()

    # Pick a workflow id. Prefer the original; disambiguate if it
    # collides with an existing workflow on this builder.
    template = manifest.get("template") or {}
    desired_raw = (
        template.get("workflow_id") or template.get("name") or "imported"
    )
    desired = re.sub(r"[^A-Za-z0-9_-]", "-", str(desired_raw))[:64].strip("-_")
    if not desired:
        desired = "imported"
    new_id = _disambiguate_id(desired)

    # Persist as v1 of a brand-new workflow.
    payload_to_save = {
        "id": new_id,
        "name": template.get("name") or new_id,
        "description": (
            template.get("description")
            or f"Imported from {root_name}.flyttmpl"
        ),
        "specification": workflow_spec,
    }
    _write_version(new_id, 1, payload_to_save)
    _write_meta(
        new_id, {"id": new_id, "current_version": 1, "versions": [1]}
    )

    # Land fixtures in the new workflow's fixture dir.
    if fixture_payloads:
        fdir = _fixtures_dir(new_id)
        fdir.mkdir(parents=True, exist_ok=True)
        for safe_name, data in fixture_payloads:
            (fdir / safe_name).write_bytes(data)

    return JSONResponse(
        {
            "id": new_id,
            "name": payload_to_save["name"],
            "version": 1,
            "fixtures_count": len(fixture_payloads),
            "source": {
                "root": root_name,
                "schema_version": sv,
                "provenance": manifest.get("provenance") or {},
            },
        },
        status_code=HTTP_201_CREATED,
    )


@router.get("/api/{workflow_id}", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def get_workflow(workflow_id: str, version: Optional[int] = Query(None)):
    err = _validate_id(workflow_id)
    if err:
        return err
    _migrate_if_flat(workflow_id)
    meta = _read_meta(workflow_id)
    if not meta:
        return JSONResponse({"error": "not found"}, status_code=HTTP_404_NOT_FOUND)
    want = int(version) if version is not None else int(meta.get("current_version", 1))
    config = _read_version(workflow_id, want)
    if config is None:
        return JSONResponse(
            {"error": f"version {want} not found"}, status_code=HTTP_404_NOT_FOUND
        )
    vpath = _version_path(workflow_id, want)
    stat_info = vpath.stat()
    return Response(
        content=json.dumps(
            {
                "data": {
                    "createTime": int(stat_info.st_ctime),
                    "updateTime": int(stat_info.st_mtime),
                    "config": config,
                    "version": want,
                    "versions": list(meta.get("versions", [])),
                    "current_version": int(meta.get("current_version", 1)),
                }
            },
            indent=2,
        ),
        media_type="application/json",
        status_code=200,
    )


@router.post("/api/{workflow_id}", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def create_or_overwrite_workflow(
    workflow_id: str, request_body: dict = Body(...)
):
    """Overwrite the current version in place. Phase-A semantics — no
    version bump. Publish uses the /publish route to snapshot a new
    version.

    Rename: body.id different from path id → move dir + update meta.
    """
    err = _validate_id(workflow_id)
    if err:
        return err
    _migrate_if_flat(workflow_id)

    # Rename path: body.id was the previous id, path workflow_id is the
    # new id. Move the directory before writing.
    old_id = request_body.get("id")
    if old_id and old_id != workflow_id:
        if not _ID_RE.match(old_id):
            return JSONResponse(
                {"error": "invalid old id"}, status_code=HTTP_400_BAD_REQUEST
            )
        _migrate_if_flat(old_id)
        old_dir = _dir_for(old_id)
        new_dir = _dir_for(workflow_id)
        if old_dir.exists() and not new_dir.exists():
            try:
                shutil.move(str(old_dir), str(new_dir))
            except Exception as e:
                logger.error(f"flyt rename {old_id}→{workflow_id}: {e}")
                return JSONResponse(
                    {"error": f"rename failed: {e}"}, status_code=500
                )

    request_body["id"] = workflow_id
    meta = _read_meta(workflow_id) or {
        "id": workflow_id,
        "current_version": 1,
        "versions": [1],
    }
    current = int(meta.get("current_version", 1))
    if current not in meta.get("versions", []):
        meta.setdefault("versions", []).append(current)
    try:
        _write_version(workflow_id, current, request_body)
        _write_meta(workflow_id, meta)
    except Exception as e:
        logger.error(f"flyt save {workflow_id}: {e}")
        return JSONResponse({"error": "unable to write file"}, status_code=500)
    return JSONResponse(
        {"message": f"Workflow '{workflow_id}' saved.", "version": current},
        status_code=HTTP_201_CREATED,
    )


@router.delete("/api/{workflow_id}", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def delete_workflow(workflow_id: str):
    err = _validate_id(workflow_id)
    if err:
        return err
    _migrate_if_flat(workflow_id)
    vdir = _dir_for(workflow_id)
    if not vdir.exists():
        return JSONResponse({"error": "not found"}, status_code=HTTP_404_NOT_FOUND)
    try:
        shutil.rmtree(vdir)
    except Exception as e:
        return JSONResponse({"error": f"delete failed: {e}"}, status_code=500)
    return JSONResponse(
        {"message": f"Workflow '{workflow_id}' deleted."}, status_code=200
    )


# ---------------------------------------------------------------------------
# Versioning
# ---------------------------------------------------------------------------


@router.post("/api/{workflow_id}/publish", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def publish_workflow(workflow_id: str, request_body: Optional[dict] = Body(None)):
    """Bump version: snapshot the current content as a new version.

    Body is optional. If provided, it overwrites the *current* version
    first (so publish is a save+bump in one call, which is what the
    topbar Publish button will do).
    """
    err = _validate_id(workflow_id)
    if err:
        return err
    _migrate_if_flat(workflow_id)
    meta = _read_meta(workflow_id)
    if not meta:
        # Publishing a brand-new workflow: create v1 from the body.
        if not request_body:
            return JSONResponse(
                {"error": "not found and no body provided"},
                status_code=HTTP_404_NOT_FOUND,
            )
        request_body["id"] = workflow_id
        _write_version(workflow_id, 1, request_body)
        _write_meta(
            workflow_id,
            {"id": workflow_id, "current_version": 1, "versions": [1]},
        )
        return JSONResponse(
            {"message": "Published v1", "version": 1}, status_code=HTTP_201_CREATED
        )

    versions: List[int] = list(meta.get("versions", []))
    current = int(meta.get("current_version", max(versions or [1])))
    if request_body:
        request_body["id"] = workflow_id
        _write_version(workflow_id, current, request_body)

    current_content = _read_version(workflow_id, current) or {"id": workflow_id}
    next_version = (max(versions) if versions else 0) + 1
    _write_version(workflow_id, next_version, current_content)
    versions.append(next_version)
    meta["versions"] = versions
    meta["current_version"] = next_version
    _write_meta(workflow_id, meta)
    return JSONResponse(
        {"message": f"Published v{next_version}", "version": next_version},
        status_code=HTTP_201_CREATED,
    )


# ---- .flyttmpl bundle (schema_version "0.1", builder slim variant) -----
#
# Aligned with Studio Phase A's bundle shape (see
# `flytbase/docs/11_flyttmpl_alignment.md`). The builder produces the
# SAME manifest shape Studio does — just with fewer fields populated:
#
#   * `template`     — yes (name, version, kind=workflow, description, created_at)
#   * `model`        — OMITTED (builder ships no weights; Studio adds at enrichment)
#   * `hardware`     — OMITTED (workflows are device-agnostic until deployed)
#   * `license`      — OMITTED (Studio resolves per-model_id licenses at enrichment)
#   * `provenance`   — yes (source_path=flow_builder, workflow_fingerprint, model_ids)
#   * `signer`       — yes (scheme=unsigned-prototype — same field name Studio uses)
#   * `files`        — yes (per-file sha256 + size_bytes inventory)
#
# Bundle flavor is conveyed by `provenance.source_path: flow_builder`,
# distinguishing builder-emitted slim bundles from Studio-emitted full
# bundles (`train_new`, `byom`, `partner_full`). Studio's enricher reads
# the source_path, fills the omitted fields, and rewrites
# `model_id: "yolov8n-640"` → `bundle://model/weights.onnx`.


def _collect_model_ids(spec: Any) -> List[str]:
    """Walk a workflow spec and return all literal model_id references.

    Skips dynamic references like ``$inputs.foo`` so the bundle manifest
    only lists weights the runtime must actually have cached. Stable
    sort + dedupe so two builds of the same spec yield byte-identical
    manifests (important for fingerprinting).
    """
    found: set = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                if (
                    k == "model_id"
                    and isinstance(v, str)
                    and v
                    and not v.startswith("$")
                ):
                    found.add(v)
                else:
                    walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(spec)
    return sorted(found)


def _sha256_hex(data: bytes) -> str:
    return sha256(data).hexdigest()


def _collect_fixture_payloads(workflow_id: str) -> List[Tuple[str, bytes]]:
    """Read every fixture for a workflow into memory for bundling.

    Returns list of (zip_path, bytes) pairs. zip_path is the bundle-
    relative path (`fixtures/test_inputs/<name>`). Empty list if the
    workflow has no fixtures or the directory doesn't exist.
    """
    fdir = _fixtures_dir(workflow_id)
    out: List[Tuple[str, bytes]] = []
    if not fdir.exists():
        return out
    for p in sorted(fdir.iterdir()):
        if not p.is_file():
            continue
        try:
            out.append((f"fixtures/test_inputs/{p.name}", p.read_bytes()))
        except OSError as e:
            logger.warning(f"flyt bundle: skipping fixture {p}: {e}")
    return out


def _build_flyttmpl_bytes(
    workflow_id: str, version: int, payload: dict, meta: dict
) -> bytes:
    """Assemble a .flyttmpl zip in memory and return its bytes.

    Manifest shape mirrors AI-R Studio Phase A's `manifest.yaml` (see
    `flytbase/docs/11_flyttmpl_alignment.md`). The builder populates a
    subset; Studio's enricher fills the omitted sections later.
    """
    spec = payload.get("specification") or {}
    model_ids = _collect_model_ids(spec)
    name = payload.get("name") or workflow_id
    description = payload.get("description", "")

    # Stable hash of the workflow spec only. Re-publishing the same
    # spec produces the same fingerprint regardless of bundle_version,
    # so deployment caches can dedupe.
    spec_canonical = json.dumps(spec, sort_keys=True, separators=(",", ":"))
    workflow_fingerprint = sha256(spec_canonical.encode("utf-8")).hexdigest()

    # ---- Build the file payloads first so we can fill files[] before
    # we write the manifest. The manifest itself is NOT in files[] (no
    # circularity), matching Studio's convention.
    workflow_bytes = json.dumps(spec, indent=2, sort_keys=True).encode("utf-8")
    workflow_path = "postprocess/workflow.json"

    fixture_payloads = _collect_fixture_payloads(workflow_id)
    fixture_count = len(fixture_payloads)

    readme_bytes = _render_readme(
        name=name,
        description=description,
        bundle_version=version,
        workflow_fingerprint=workflow_fingerprint,
        model_ids=model_ids,
        fixture_count=fixture_count,
    ).encode("utf-8")
    readme_path = "README.md"

    file_payloads: List[Tuple[str, bytes]] = [
        (workflow_path, workflow_bytes),
        (readme_path, readme_bytes),
        *fixture_payloads,
    ]
    files_inventory = sorted(
        (
            {
                "path": zp,
                "sha256": _sha256_hex(b),
                "size_bytes": len(b),
            }
            for zp, b in file_payloads
        ),
        key=lambda x: x["path"],
    )

    # ---- Manifest ------------------------------------------------------
    # Field shape matches Studio Phase A's manifest.yaml — same keys
    # under template / provenance / signer / files. Sections Studio's
    # enricher fills (model, hardware, license) are simply omitted here
    # rather than emitted as `null` so a YAML reader doesn't have to
    # distinguish "Studio didn't write" from "field was empty".
    created_at_iso = (
        datetime.datetime.utcnow()
        .replace(microsecond=0, tzinfo=datetime.timezone.utc)
        .isoformat()
    )
    manifest: Dict[str, Any] = {
        "schema_version": "0.1",
        "template": {
            "name": name,
            # 0.<bundle_version>.0 anchors template version to the
            # builder's publish counter. Studio enricher may rewrite
            # this when it stamps a customer-facing semver.
            "version": f"0.{int(version)}.0",
            "kind": "workflow",
            "description": description
            or "Authored in the FlytBase flow builder.",
            "created_at": created_at_iso,
            "workflow_id": workflow_id,
        },
        "provenance": {
            "source_path": "flow_builder",
            "studio_phase": "builder-edge",
            "workflow_fingerprint": workflow_fingerprint,
            "bundle_version": int(version),
            "model_ids": model_ids,
            "fixtures_count": fixture_count,
        },
        "signer": {
            "scheme": "unsigned-prototype",
            "key_id": None,
            "signature": None,
            "note": (
                "Builder-edge bundle — re-signed by Studio enricher or "
                "Bundle Signing Service before deployment"
            ),
        },
        "files": files_inventory,
    }

    # ---- Tarball everything -------------------------------------------
    # Studio Phase A's `verify_bundle.py` reads `.flyttmpl.tar.gz` with
    # a top-level directory inside. We match that container exactly so
    # the same verifier works on both Studio-emitted and builder-emitted
    # bundles.
    template_name = (manifest["template"]["name"] or workflow_id).replace(" ", "_")
    template_version = manifest["template"]["version"]
    bundle_root = f"{template_name}_v{template_version}.flyttmpl"

    manifest_yaml = yaml.safe_dump(
        manifest, sort_keys=False, default_flow_style=False
    ).encode("utf-8")

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        # Top-level bundle dir as an explicit DIRTYPE entry — Studio's
        # `verify_bundle.py` finds the bundle root by looking for a
        # member with no `/` in its name. Without this, the verifier
        # can't locate the manifest.
        _add_tar_dir(tar, bundle_root)
        # Manifest first inside the root (streaming readers find it
        # without walking the whole tarball).
        _add_tar_file(tar, f"{bundle_root}/manifest.yaml", manifest_yaml)
        # Track subdirs we've added so we emit a DIRTYPE entry for
        # `fixtures/`, `postprocess/`, `fixtures/test_inputs/`, etc.
        # exactly once, in path order.
        seen_dirs: set = set()
        for zp, b in file_payloads:
            parent = "/".join(zp.split("/")[:-1])
            if parent and parent not in seen_dirs:
                # Walk parent prefixes so a deep path like
                # `fixtures/test_inputs/foo.jpg` emits both
                # `fixtures/` and `fixtures/test_inputs/`.
                segs = parent.split("/")
                for i in range(1, len(segs) + 1):
                    sub = "/".join(segs[:i])
                    if sub not in seen_dirs:
                        _add_tar_dir(tar, f"{bundle_root}/{sub}")
                        seen_dirs.add(sub)
            _add_tar_file(tar, f"{bundle_root}/{zp}", b)
    return buf.getvalue()


def _add_tar_file(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    info.mtime = int(time.time())
    info.mode = 0o644
    tar.addfile(info, io.BytesIO(data))


def _add_tar_dir(tar: tarfile.TarFile, name: str) -> None:
    info = tarfile.TarInfo(name=name)
    info.type = tarfile.DIRTYPE
    info.size = 0
    info.mtime = int(time.time())
    info.mode = 0o755
    tar.addfile(info)


def _render_readme(
    *,
    name: str,
    description: str,
    bundle_version: int,
    workflow_fingerprint: str,
    model_ids: List[str],
    fixture_count: int,
) -> str:
    lines = [
        f"# {name}",
        "",
        f"Bundle version: v{bundle_version}",
        "Schema: `0.1` (flow-builder slim variant)",
        f"Fingerprint: `{workflow_fingerprint[:16]}…`",
        f"Created: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}",
        "",
    ]
    if description:
        lines += [description, ""]
    lines += ["## Model IDs referenced", ""]
    if model_ids:
        lines += [f"- `{m}`" for m in model_ids]
    else:
        lines += ["_(none — workflow uses no model_id-keyed blocks)_"]
    lines += [
        "",
        "## Scope of this bundle",
        "",
        "Authored in the FlytBase flow builder. Contains the workflow",
        "specification, saved fixtures, and metadata. Model weights,",
        "dashboard widgets, alert rules, and performance cards are added",
        "by AI-R Studio / Model Hub during enrichment, not authored here.",
        "",
        "## Layout",
        "",
        "- `manifest.yaml` — bundle metadata (Studio Phase A shape)",
        "- `postprocess/workflow.json` — workflow specification (Roboflow Workflow JSON)",
        f"- `fixtures/test_inputs/` — {fixture_count} saved fixture(s)"
        if fixture_count
        else "- `fixtures/` — _(no fixtures saved for this workflow)_",
        "- `README.md` — this file",
        "",
        "## What runs this",
        "",
        "An AI-R Edge runtime with the listed model IDs already cached",
        "in `$MODEL_CACHE_DIR`, or a Model Hub registration that resolves",
        "them. Studio's `run_workflow.py` accepts these bundles once a",
        "model_id fall-through is wired (see",
        "`flytbase/docs/11_flyttmpl_alignment.md`).",
        "",
    ]
    return "\n".join(lines)


@router.get("/api/{workflow_id}/bundle", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def download_bundle(
    workflow_id: str, version: Optional[int] = Query(None)
):
    """Return a `.flyttmpl` zip for the requested (or current) version.

    The CSRF guard means browsers can only invoke this via fetch() with
    the x-csrf header — direct anchor downloads will 403. The frontend
    calls fetch then saves the Blob to a download anchor, which is the
    same pattern used everywhere else in the SPA.
    """
    err = _validate_id(workflow_id)
    if err:
        return err
    _migrate_if_flat(workflow_id)
    meta = _read_meta(workflow_id)
    if not meta:
        return JSONResponse(
            {"error": "not found"}, status_code=HTTP_404_NOT_FOUND
        )
    versions = list(meta.get("versions", []))
    v = int(version) if version is not None else int(meta.get("current_version", 1))
    if v not in versions:
        return JSONResponse(
            {"error": f"version {v} not found"},
            status_code=HTTP_404_NOT_FOUND,
        )
    payload = _read_version(workflow_id, v)
    if payload is None:
        return JSONResponse(
            {"error": "version data missing on disk"},
            status_code=HTTP_404_NOT_FOUND,
        )

    data = _build_flyttmpl_bytes(workflow_id, v, payload, meta)
    # Match Studio Phase A's filename pattern: <name>_v<semver>.flyttmpl.tar.gz.
    # template.version is set to "0.<bundle_version>.0" inside
    # _build_flyttmpl_bytes; reuse the same string here.
    safe_name = (payload.get("name") or workflow_id).replace(" ", "_")
    filename = f"{safe_name}_v0.{v}.0.flyttmpl.tar.gz"
    return Response(
        content=data,
        media_type="application/gzip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Bundle bytes are cheap to regenerate; never cache so a
            # fresh Publish always serves fresh content.
            "Cache-Control": "no-store",
        },
    )


# ---- Fixtures (per-workflow scene image library) -----------------------


@router.get("/api/{workflow_id}/fixtures", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def list_fixtures(workflow_id: str):
    err = _validate_id(workflow_id)
    if err:
        return err
    fdir = _fixtures_dir(workflow_id)
    out: List[dict] = []
    if fdir.exists():
        for p in sorted(fdir.iterdir()):
            if not p.is_file():
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            out.append(
                {
                    "name": p.name,
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                }
            )
    return JSONResponse(
        {
            "data": out,
            "limits": {
                "max_per_workflow": FIXTURES_MAX_PER_WORKFLOW,
                "max_bytes_per_file": FIXTURE_MAX_BYTES,
            },
        },
        status_code=200,
    )


@router.post(
    "/api/{workflow_id}/fixtures", dependencies=[Depends(verify_csrf_token)]
)
@with_route_exceptions_async
async def upload_fixture(
    workflow_id: str, file: UploadFile = File(...)
):
    """Save an uploaded image as a fixture for this workflow.

    Caps:
      - 10 MB per file (we read up to cap+1 and reject if larger).
      - 5 fixtures per workflow (re-uploading an existing name is OK
        — same name is treated as a replace, not a new fixture).

    Filename is sanitised; uploads with unsafe names are rejected
    rather than silently rewritten, so the operator notices.
    """
    err = _validate_id(workflow_id)
    if err:
        return err
    # Workflows are created lazily on first save, so the dir may not
    # exist yet for a brand-new workflow. Fixtures require an existing
    # workflow so we don't accumulate orphans.
    if not _dir_for(workflow_id).exists():
        return JSONResponse(
            {"error": "save the workflow first, then upload fixtures"},
            status_code=HTTP_400_BAD_REQUEST,
        )
    safe = _sanitize_fixture_name(file.filename or "")
    if safe is None:
        return JSONResponse(
            {
                "error": "invalid filename",
                "hint": "use letters/digits/_.-, plus a 1-5 char extension (e.g. drone_view_01.jpg)",
            },
            status_code=HTTP_400_BAD_REQUEST,
        )

    # Read with a hard cap. Reading cap+1 lets us distinguish
    # "exactly cap" (allowed) from "over cap" (rejected) without
    # buffering the whole oversize payload.
    payload = await file.read(FIXTURE_MAX_BYTES + 1)
    if len(payload) > FIXTURE_MAX_BYTES:
        return JSONResponse(
            {
                "error": (
                    f"file exceeds {FIXTURE_MAX_BYTES // (1024 * 1024)} MB cap; "
                    "use Frame Storage for larger images"
                )
            },
            status_code=413,
        )
    if not payload:
        return JSONResponse(
            {"error": "empty file"}, status_code=HTTP_400_BAD_REQUEST
        )

    fdir = _fixtures_dir(workflow_id)
    fdir.mkdir(parents=True, exist_ok=True)
    target = fdir / safe
    is_replace = target.exists()
    if not is_replace:
        # Count cap only for net-new uploads — replacing an existing
        # fixture by name shouldn't be blocked at the limit.
        existing = [p for p in fdir.iterdir() if p.is_file()]
        if len(existing) >= FIXTURES_MAX_PER_WORKFLOW:
            return JSONResponse(
                {
                    "error": (
                        f"workflow at fixture cap ({FIXTURES_MAX_PER_WORKFLOW}); "
                        "delete an existing fixture first"
                    )
                },
                status_code=409,
            )

    target.write_bytes(payload)
    return JSONResponse(
        {
            "name": safe,
            "size": len(payload),
            "replaced": is_replace,
        },
        status_code=HTTP_201_CREATED,
    )


@router.get(
    "/api/{workflow_id}/fixtures/{name}",
    dependencies=[Depends(verify_csrf_token)],
)
@with_route_exceptions_async
async def get_fixture(workflow_id: str, name: str):
    err = _validate_id(workflow_id)
    if err:
        return err
    safe = _sanitize_fixture_name(name)
    if safe is None or safe != name:
        # Reject any name that doesn't pass our regex AND any name we
        # had to rewrite — both indicate the caller is doing something
        # unexpected (path traversal, percent-encoded surprises).
        return JSONResponse(
            {"error": "invalid fixture name"},
            status_code=HTTP_400_BAD_REQUEST,
        )
    target = _fixtures_dir(workflow_id) / safe
    if not target.exists() or not target.is_file():
        return JSONResponse(
            {"error": "fixture not found"}, status_code=HTTP_404_NOT_FOUND
        )
    return FileResponse(
        target,
        # FileResponse infers media_type from the suffix; we rely on
        # that so .jpg → image/jpeg, .png → image/png, .mp4 → video/mp4.
    )


@router.delete(
    "/api/{workflow_id}/fixtures/{name}",
    dependencies=[Depends(verify_csrf_token)],
)
@with_route_exceptions_async
async def delete_fixture(workflow_id: str, name: str):
    err = _validate_id(workflow_id)
    if err:
        return err
    safe = _sanitize_fixture_name(name)
    if safe is None or safe != name:
        return JSONResponse(
            {"error": "invalid fixture name"},
            status_code=HTTP_400_BAD_REQUEST,
        )
    target = _fixtures_dir(workflow_id) / safe
    if not target.exists():
        return JSONResponse(
            {"error": "fixture not found"}, status_code=HTTP_404_NOT_FOUND
        )
    try:
        target.unlink()
    except OSError as e:
        return JSONResponse(
            {"error": f"could not delete: {e}"},
            status_code=500,
        )
    return JSONResponse({"deleted": safe}, status_code=200)


@router.get("/api/{workflow_id}/versions", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def list_versions(workflow_id: str):
    err = _validate_id(workflow_id)
    if err:
        return err
    _migrate_if_flat(workflow_id)
    meta = _read_meta(workflow_id)
    if not meta:
        return JSONResponse({"error": "not found"}, status_code=HTTP_404_NOT_FOUND)
    out = []
    for v in meta.get("versions", []):
        p = _version_path(workflow_id, v)
        if not p.exists():
            continue
        st = p.stat()
        out.append(
            {
                "version": v,
                "createTime": int(st.st_ctime),
                "updateTime": int(st.st_mtime),
                "is_current": int(v) == int(meta.get("current_version", 1)),
            }
        )
    out.sort(key=lambda x: x["version"], reverse=True)
    return JSONResponse(
        {
            "data": {
                "id": workflow_id,
                "current_version": int(meta.get("current_version", 1)),
                "versions": out,
            }
        },
        status_code=200,
    )


@router.post("/api/{workflow_id}/restore", dependencies=[Depends(verify_csrf_token)])
@with_route_exceptions_async
async def restore_version(workflow_id: str, version: int = Query(...)):
    """Copy a prior version forward as a new current_version."""
    err = _validate_id(workflow_id)
    if err:
        return err
    _migrate_if_flat(workflow_id)
    meta = _read_meta(workflow_id)
    if not meta:
        return JSONResponse({"error": "not found"}, status_code=HTTP_404_NOT_FOUND)
    src = _read_version(workflow_id, version)
    if src is None:
        return JSONResponse(
            {"error": f"version {version} not found"},
            status_code=HTTP_404_NOT_FOUND,
        )
    versions: List[int] = list(meta.get("versions", []))
    next_version = (max(versions) if versions else 0) + 1
    _write_version(workflow_id, next_version, src)
    versions.append(next_version)
    meta["versions"] = versions
    meta["current_version"] = next_version
    _write_meta(workflow_id, meta)
    return JSONResponse(
        {
            "message": f"Restored v{version} as v{next_version}",
            "version": next_version,
        },
        status_code=HTTP_201_CREATED,
    )


# ---------------------------------------------------------------------------
# Static SPA assets
# ---------------------------------------------------------------------------


@router.get("/assets/{filename:path}", include_in_schema=False)
async def flybuild_asset(filename: str):
    candidate = (FRONTEND_ASSETS_DIR / filename).resolve()
    try:
        candidate.relative_to(FRONTEND_ASSETS_DIR.resolve())
    except ValueError:
        return Response(status_code=404)
    if not candidate.is_file():
        return Response(status_code=404)
    return FileResponse(
        str(candidate),
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/favicon.ico", include_in_schema=False)
async def flybuild_favicon():
    path = FRONTEND_DIR / "favicon.ico"
    if path.exists():
        return FileResponse(str(path))
    return Response(status_code=404)


@router.get("/favicon.svg", include_in_schema=False)
async def flybuild_favicon_svg():
    path = FRONTEND_DIR / "favicon.svg"
    if path.exists():
        return FileResponse(str(path))
    return Response(status_code=404)
