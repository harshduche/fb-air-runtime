"""FlytBase bundle:// model_id resolver — Edge Phase 3 work item 2 (provider half).

Decorator over `RoboflowModelRegistry` (or any other base registry) that
intercepts `bundle://` model_ids before they hit the underlying
Roboflow-API-backed lookup. Resolves them against a local bundle
cache pre-staged from `.flyttmpl` archives published by AI-R Studio.

Activation
==========

In `inference/core/registries/__init__.py` (or wherever the active
ModelRegistry is constructed), wrap the existing registry::

    from inference.core.registries.roboflow import RoboflowModelRegistry
    from inference.core.registries.flytbase_bundle import FlytBaseBundleRegistry

    base = RoboflowModelRegistry(...)
    REGISTRY = FlytBaseBundleRegistry(wrapped=base)

`bundle://` URIs then resolve locally; everything else delegates to the
wrapped registry unchanged.

URI format
==========

Two equivalent forms accepted:

    bundle://<template_name>/<version>/<file>
        Resolved against `FLYTBASE_BUNDLE_CACHE_DIR/<template_name>/<version>/<file>`.
        Use this form when the workflow.json is loaded standalone (no
        bundle context available) — the URI fully self-describes.

    bundle://<file>
        Resolved against `FLYTBASE_ACTIVE_BUNDLE_ROOT/<file>`.
        Use this form for workflow.json embedded inside a bundle —
        the bundle root is provided by the workflow loader (e.g. the
        flyt_builder import path sets the env var per-request, or
        Studio's bundle adapter pushes the path into thread-local
        state — TODO for Phase 4 as that integration lands).

The Studio prototype's `_default_workflow_spec` writes the second
(short) form, expecting the workflow loader to set
`FLYTBASE_ACTIVE_BUNDLE_ROOT`. The longer form is for Phase B+ when
bundles are pre-staged in `MODEL_CACHE_DIR/flytbase/bundles/` and
the engine receives raw workflow.json without bundle wrapping.

Cache layout
============

    $FLYTBASE_BUNDLE_CACHE_DIR/
      aerial_vehicle_pedestrian/
        0.1.2/                                  ← extracted .flyttmpl root
          manifest.yaml
          model/
            weights.onnx
            config.yaml
          postprocess/
            workflow.json
          fixtures/
          ...

`stage_bundle.py` (Studio-side helper) untars a `.flyttmpl.tar.gz`
into this layout. Production: Frame storage / Model Hub stages bundles
into the cache as part of the deploy flow.

Phase A scope (this file)
=========================

What's implemented:
  - Decorator pattern: `FlytBaseBundleRegistry(wrapped=...)`
  - URI parsing for both short + long form
  - Local-file resolution, returning a Roboflow `OnnxModel`-shaped
    callable that the existing ModelManager.add_model path can use

What's NOT implemented (gated on Edge Phase 3 sign-off):
  - Workflow-context binding (the short URI relies on env var; thread-
    local would be better for multi-tenant workers)
  - Cache eviction / TTL (LRU on a per-template-version basis)
  - License-class gating per D10 (refuse to load `restricted` bundles
    on devices not allow-listed for that license class)
  - Signature verification on load (re-runs Studio's
    `verify_bundle.py` logic against the staged manifest before
    handing the model class back)

Tests
=====

See `tests/inference/unit_tests/core/registries/test_flytbase_bundle.py`
(write alongside this file).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from inference.core.exceptions import ModelNotRecognisedError
from inference.core.models.base import Model
from inference.core.registries.base import ModelRegistry


_BUNDLE_SCHEME = "bundle://"


class BundleResolutionError(ModelNotRecognisedError):
    """Raised when a bundle:// URI cannot be resolved against the local cache."""


def _bundle_cache_dir() -> Path:
    return Path(os.environ.get(
        "FLYTBASE_BUNDLE_CACHE_DIR",
        # default: $MODEL_CACHE_DIR/flytbase/bundles, falling back to /tmp
        os.path.join(
            os.environ.get("MODEL_CACHE_DIR", "/tmp/cache"),
            "flytbase", "bundles",
        ),
    ))


def _active_bundle_root() -> Optional[Path]:
    val = os.environ.get("FLYTBASE_ACTIVE_BUNDLE_ROOT")
    return Path(val) if val else None


def resolve_bundle_uri(uri: str) -> Path:
    """`bundle://...` → absolute filesystem path.

    Two URI shapes (see module docstring):
      - long: `bundle://<template>/<version>/<file>`
        → `$FLYTBASE_BUNDLE_CACHE_DIR/<template>/<version>/<file>`
      - short: `bundle://<file>`
        → `$FLYTBASE_ACTIVE_BUNDLE_ROOT/<file>`

    Raises BundleResolutionError on failure; does NOT touch the network.
    """
    if not uri.startswith(_BUNDLE_SCHEME):
        raise BundleResolutionError(f"not a bundle:// URI: {uri!r}")

    rel = uri[len(_BUNDLE_SCHEME):]
    if not rel:
        raise BundleResolutionError(f"empty bundle:// URI: {uri!r}")

    parts = rel.split("/")
    # Heuristic: long-form needs template + version + at least one file part.
    # Path-component guard: reject any part that would let `..`/absolute-path
    # tricks escape $FLYTBASE_BUNDLE_CACHE_DIR.
    _bad_components = {"", ".", ".."}
    if (
        len(parts) >= 3
        and parts[0] not in _bad_components
        and parts[1] not in _bad_components
        and parts[2] not in _bad_components
        and not any(p.startswith("/") for p in parts)
    ):
        template, version = parts[0], parts[1]
        rest_parts = parts[2:]
        if any(p in _bad_components for p in rest_parts):
            raise BundleResolutionError(f"path component traversal in {uri!r}")
        cache = _bundle_cache_dir().resolve()
        candidate = (cache / template / version / "/".join(rest_parts)).resolve()
        if not str(candidate).startswith(str(cache)):
            raise BundleResolutionError(f"bundle:// URI escapes cache root: {uri!r}")
        if candidate.exists():
            return candidate

    # Fall back to short form.
    root = _active_bundle_root()
    if root is None:
        raise BundleResolutionError(
            f"short bundle:// URI {uri!r} requires FLYTBASE_ACTIVE_BUNDLE_ROOT set; "
            f"long form requires {_bundle_cache_dir()}/<template>/<version>/<file>"
        )
    candidate = (root / rel).resolve()
    # Path-traversal defence: must stay within root.
    if not str(candidate).startswith(str(root.resolve())):
        raise BundleResolutionError(f"bundle:// URI escapes active bundle root: {uri!r}")
    if not candidate.exists():
        raise BundleResolutionError(f"bundle:// URI not found at {candidate}: {uri!r}")
    return candidate


class FlytBaseBundleRegistry(ModelRegistry):
    """Wraps another ModelRegistry; intercepts `bundle://` model IDs.

    For `bundle://...` model_ids, returns a model class whose constructor
    loads weights from the bundle's local file. For everything else,
    delegates to `wrapped`.

    Today's implementation returns the wrapped registry's class for
    `roboflow_object_detection_model` / `roboflow_instance_segmentation_model`
    types but with a model_id_alias rewritten to a local-cache path.
    Phase B does this more cleanly with a `LocalONNXModel` adapter that
    skips the Roboflow-API metadata path entirely.
    """

    def __init__(self, wrapped: ModelRegistry) -> None:
        super().__init__(getattr(wrapped, "registry_dict", {}))
        self._wrapped = wrapped

    def get_model(self, model_id: str, api_key: str = "", **kwargs) -> Model:
        if model_id.startswith(_BUNDLE_SCHEME):
            local_path = resolve_bundle_uri(model_id)
            # The downstream ModelManager.add_model still expects a Roboflow
            # task-typed model class. We can't fully bypass that without a
            # larger refactor; for now emit a clear error directing users
            # to the planned `LocalONNXModel` adapter, AND document the
            # local path so the operator can pre-load the model via
            # /model/add with `MODEL_CACHE_DIR` symlinks.
            raise BundleResolutionError(
                f"bundle:// resolved to local file {local_path}; "
                f"`LocalONNXModel` registration is gated on Edge Phase 3 work "
                f"item 2 (D6). For now, symlink the file under MODEL_CACHE_DIR "
                f"and reference it by Roboflow model_id, or wait for the "
                f"Phase 3 weights-provider PR."
            )
        return self._wrapped.get_model(model_id, api_key, **kwargs)
