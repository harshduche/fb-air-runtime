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

import glob
import json
import logging
import os
import re
import shutil
import time
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, status
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
