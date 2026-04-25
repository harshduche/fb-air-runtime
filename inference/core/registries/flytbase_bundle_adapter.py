"""LocalONNX adapter — stages a Studio `.flyttmpl` bundle into the
existing Roboflow model cache layout so the standard model classes
(RFDETRObjectDetection, RFDETRInstanceSegmentation, etc.) load it
without any Roboflow API call.

The trick: Roboflow's loader is already cache-first. It hits the API
only when files are missing from `MODEL_CACHE_DIR/<endpoint>/`. If the
files are pre-staged (weights.onnx, environment.json, class_names.txt)
and the metadata cache (`model_type.json`) is populated, the loader
short-circuits and reads from disk.

This adapter bridges Studio's manifest.yaml format into the
environment.json + class_names.txt + model_type.json shape the loader
expects. The bundle's `weights.onnx` is symlinked rather than copied.

Companion to `flytbase_bundle.py` (the registry decorator). The
decorator catches `bundle://` URIs; this module produces the staged
cache for the wrapped registry to find.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import yaml

from inference.core.env import MODEL_CACHE_DIR
from inference.core.exceptions import ModelNotRecognisedError
from inference.core.registries.flytbase_bundle import (
    BundleResolutionError,
    resolve_bundle_uri,
)


# Studio's `(template.kind, provenance.distillation_target)` →
# Roboflow registry's `(task_type, model_type)`. Extend as more
# distillation targets land in Studio.
_STUDIO_TO_ROBOFLOW: Dict[Tuple[str, str], Tuple[str, str]] = {
    ("object-detection", "rf-detr-base"): ("object-detection", "rfdetr-base"),
    ("object-detection", "rf-detr-nano"): ("object-detection", "rfdetr-nano"),
    ("object-detection", "rf-detr-small"): ("object-detection", "rfdetr-small"),
    ("object-detection", "rf-detr-medium"): ("object-detection", "rfdetr-medium"),
    ("object-detection", "rf-detr-large"): ("object-detection", "rfdetr-large"),
    ("instance-segmentation", "rf-detr-seg-preview"): (
        "instance-segmentation",
        "rfdetr",
    ),
}


def _sanitize(name: str) -> str:
    """Strip characters that would break Roboflow's two-segment model_id
    parser (only `/` is fatal — keep `.` so semver versions stay readable).
    """
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in str(name))


def _read_manifest(bundle_root: Path) -> Dict[str, Any]:
    manifest_path = bundle_root / "manifest.yaml"
    if not manifest_path.exists():
        raise BundleResolutionError(
            f"bundle root {bundle_root} has no manifest.yaml — not a Studio "
            f"`.flyttmpl` layout"
        )
    with manifest_path.open() as fh:
        return yaml.safe_load(fh) or {}


def _resolve_task_and_model_type(manifest: Dict[str, Any]) -> Tuple[str, str]:
    template = manifest.get("template") or {}
    provenance = manifest.get("provenance") or {}
    kind = template.get("kind") or "object-detection"
    distillation = provenance.get("distillation_target") or ""
    pair = _STUDIO_TO_ROBOFLOW.get((kind, distillation))
    if pair is not None:
        return pair
    raise ModelNotRecognisedError(
        f"Studio bundle has unrecognised "
        f"(template.kind={kind!r}, "
        f"provenance.distillation_target={distillation!r}); "
        f"register a mapping in flytbase_bundle_adapter._STUDIO_TO_ROBOFLOW"
    )


def _extract_classes(manifest: Dict[str, Any]) -> list[str]:
    template = manifest.get("template") or {}
    classes = template.get("classes")
    if classes:
        return list(classes)
    model = manifest.get("model") or {}
    classes = model.get("classes")
    if classes:
        return list(classes)
    raise BundleResolutionError(
        "Studio bundle manifest carries no class list — checked "
        "template.classes and model.classes"
    )


def _build_environment_json(classes: list[str]) -> Dict[str, Any]:
    """Synthesise the minimum environment.json the Roboflow loader needs.

    The loader reads `PREPROCESSING.resize.format` and (optionally)
    `CLASS_MAP` / `COLORS`; class_names.txt overrides any embedded class list.
    Stretch-resize is the right default for RFDETR's letterbox-free path.
    """
    return {
        "PREPROCESSING": {
            "resize": {"format": "Stretch to"},
        },
        "CLASS_MAP": {str(i): name for i, name in enumerate(classes)},
        "COLORS": {name: "#FF0000" for name in classes},
        "MULTICLASS": False,
    }


def stage_bundle_for_engine(
    bundle_uri: str,
    cache_root: Optional[str] = None,
) -> Tuple[str, Tuple[str, str]]:
    """Resolve `bundle://...` to the bundle root, then stage the files
    the Roboflow loader expects under `<cache_root>/<endpoint>/`.

    Returns `(synthetic_endpoint, (task_type, model_type))`. The caller
    can hand `synthetic_endpoint` to the wrapped Roboflow registry's
    `get_model` and the regular cache-first loader path will pick it up.
    """
    weights_path = resolve_bundle_uri(bundle_uri)
    if weights_path.name != "weights.onnx":
        raise BundleResolutionError(
            f"bundle:// URI must point at weights.onnx; got {weights_path}"
        )
    bundle_root = weights_path.parent.parent

    manifest = _read_manifest(bundle_root)
    task_type, model_type = _resolve_task_and_model_type(manifest)
    classes = _extract_classes(manifest)

    template = manifest.get("template") or {}
    template_name = _sanitize(template.get("name") or "unknown")
    template_version = _sanitize(template.get("version") or "0.0.0")
    endpoint = f"flytbase-{template_name}/{template_version}"

    cache_dir = Path(cache_root or MODEL_CACHE_DIR) / endpoint
    cache_dir.mkdir(parents=True, exist_ok=True)

    cached_weights = cache_dir / "weights.onnx"
    if cached_weights.is_symlink() or cached_weights.exists():
        cached_weights.unlink()
    cached_weights.symlink_to(weights_path)

    (cache_dir / "environment.json").write_text(
        json.dumps(_build_environment_json(classes), indent=2)
    )
    (cache_dir / "class_names.txt").write_text("\n".join(classes) + "\n")
    (cache_dir / "model_type.json").write_text(
        json.dumps(
            {
                "project_task_type": task_type,
                "model_type": model_type,
            },
            indent=2,
        )
    )
    return endpoint, (task_type, model_type)


def make_redirect_class(parent_cls: type, synthetic_endpoint: str) -> type:
    """Wrap `parent_cls` so its `__init__` ignores the caller's `model_id`
    and uses `synthetic_endpoint` instead.

    Roboflow's `ModelManager.add_model` instantiates the registry's
    returned class with the *original* `model_id` (the `bundle://` URI),
    which would fail `get_model_id_chunks` (multiple slashes / scheme).
    This redirect lets the caller stay oblivious — the real load happens
    against the staged cache directory.
    """

    class _FlytBaseBundleRedirect(parent_cls):  # type: ignore[misc, valid-type]
        _flytbase_endpoint = synthetic_endpoint

        def __init__(self, model_id: str = "", *args: Any, **kwargs: Any) -> None:
            super().__init__(model_id=self._flytbase_endpoint, *args, **kwargs)

    _FlytBaseBundleRedirect.__name__ = f"FlytBaseBundle_{parent_cls.__name__}"
    _FlytBaseBundleRedirect.__qualname__ = _FlytBaseBundleRedirect.__name__
    return _FlytBaseBundleRedirect
