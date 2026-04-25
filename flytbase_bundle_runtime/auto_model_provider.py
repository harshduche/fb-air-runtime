"""FlytBase bundle weights provider — Edge Phase 3 work item 2 (D6 / runtime half).

Returns `ModelMetadata` for an AI-R Studio `.flyttmpl` bundle that
has been pre-staged into `$FLYTBASE_BUNDLE_CACHE_DIR/<template>/<version>/`
(staging is done by `air_studio/prototype/stage_bundle.py` or by Frame
Storage on bundle publish — Phase B).

Companion to `inference/core/registries/flytbase_bundle.py` (the
LEGACY-side registry decorator). This file is the NEW-side provider —
plugs into `inference_models.AutoModel.from_pretrained(model_id,
weights_provider="flytbase_bundle")`. The two routes coexist; production
consolidates onto the new one as upstream migrates more workflow steps
off the legacy `inference.core.managers.ModelManager` path.

Activation
==========

At engine startup (e.g. in `inference/core/__init__.py` or a custom
init hook), register the provider once::

    from inference_models import register_model_provider
    from inference_models.weights_providers.flytbase_bundle_provider import (
        get_flytbase_bundle_model,
    )

    register_model_provider("flytbase_bundle", get_flytbase_bundle_model)

Then `AutoModel.from_pretrained(...)` accepts:

    AutoModel.from_pretrained(
        model_id="aerial_vehicle_pedestrian/0.1.2",
        weights_provider="flytbase_bundle",
        # The provider reads model_type + task_type out of the bundle's
        # manifest; no need to pass them. (Optional override hooks below.)
    )

Model ID format
===============

The provider expects `model_id = "<template>/<version>"` — the same
chunks that the bundle staged at
`$FLYTBASE_BUNDLE_CACHE_DIR/<template>/<version>/`.

Returns
=======

A `ModelMetadata` describing the staged ONNX:

- `model_id`: the input
- `model_architecture`: read from the bundle's
  `manifest.provenance.distillation_target`, normalised to one of the
  engine's known model architectures (`rfdetr` / `rfdetr-seg`)
- `task_type`: `object-detection` or `instance-segmentation` from
  `manifest.template.kind`
- `model_packages[0]`: a single `ModelPackageMetadata` with backend=ONNX,
  pointing at `model/weights.onnx` via `file://` URL

Phase A scope (this file)
=========================

What's implemented:
- Manifest parsing → `ModelMetadata` shape
- `file://` URL for the local weights (consumer downloader must accept
  the `file://` scheme; if it doesn't, the operator can use the legacy
  registry route via `flytbase_bundle.py`)
- Model architecture mapping for {RF-DETR det, RF-DETR seg}
- license.runtime_compatibility surfaced as `model_features` so D10
  enforcement at the next layer can refuse to load `restricted` bundles

What's NOT implemented (gated on Phase 3 sign-off):
- License-class enforcement here (provider just surfaces it; refusal
  belongs at the AutoModel boundary)
- Signature verification at load time
- Multi-package bundles (TRT engines per target — D20)
- BYOM bundles where `provenance.distillation_target` is `(none)`
  (today defaults to `rfdetr`; should fall through to a customer-
  supplied `model_type` per `from_pretrained`'s `model_type=` kwarg)
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Optional

from inference_models.weights_providers.entities import (
    BackendType,
    FileDownloadSpecs,
    ModelMetadata,
    ModelPackageMetadata,
    ONNXPackageDetails,
    Quantization,
)


def _bundle_cache_dir() -> Path:
    return Path(os.environ.get(
        "FLYTBASE_BUNDLE_CACHE_DIR",
        os.path.join(
            os.environ.get("MODEL_CACHE_DIR", "/tmp/cache"),
            "flytbase", "bundles",
        ),
    ))


# Maps provenance.distillation_target → (model_architecture, task_type).
# The keys are what AI-R Studio writes; the values are what the
# inference_models registry (`models/auto_loaders/models_registry.py`)
# expects as the lookup tuple's first two elements.
_ARCH_MAP = {
    "rf-detr-base":          ("rfdetr", "object-detection"),
    "rf-detr-seg-preview":   ("rfdetr", "instance-segmentation"),
    "rf-detr-nano":          ("rfdetr", "object-detection"),
    "rf-detr-small":         ("rfdetr", "object-detection"),
    "rf-detr-medium":        ("rfdetr", "object-detection"),
    "rf-detr-large":         ("rfdetr", "object-detection"),
}


def get_flytbase_bundle_model(
    model_id: str,
    api_key: Optional[str] = None,  # ignored — bundles are device-locally staged
    **kwargs,
) -> ModelMetadata:
    """Resolve a Studio `.flyttmpl` to ModelMetadata for AutoModel loading.

    `model_id` format: ``"<template>/<version>"`` — the same chunks
    used in the long-form `bundle://template/version/file` URI that
    the legacy registry decorator handles.

    Optional `**kwargs`:
      ``model_type``  — override the architecture (BYOM bundles where
                        provenance doesn't pin one)
      ``task_type``   — override the task type
    """
    import yaml

    chunks = model_id.strip("/").split("/")
    if len(chunks) != 2 or not all(chunks):
        raise ValueError(
            f"flytbase_bundle: model_id must be 'template/version'; got {model_id!r}"
        )
    template, version = chunks
    bundle_root = _bundle_cache_dir() / template / version
    if not bundle_root.exists():
        raise FileNotFoundError(
            f"flytbase_bundle: not staged at {bundle_root} — run "
            f"`stage_bundle.py` (Studio side) or wait for Frame Storage "
            f"to auto-stage on publish."
        )

    manifest_path = bundle_root / "manifest.yaml"
    weights_path = bundle_root / "model" / "weights.onnx"
    if not manifest_path.exists():
        raise FileNotFoundError(f"flytbase_bundle: missing {manifest_path}")
    if not weights_path.exists():
        raise FileNotFoundError(f"flytbase_bundle: missing {weights_path}")

    manifest = yaml.safe_load(manifest_path.read_text())

    # ---- model_architecture + task_type --------------------------------
    template_kind = (manifest.get("template") or {}).get("kind", "detection")
    distill = (manifest.get("provenance") or {}).get("distillation_target") or ""
    if "model_type" in kwargs and "task_type" in kwargs:
        model_arch = kwargs["model_type"]
        task_type = kwargs["task_type"]
    elif distill in _ARCH_MAP:
        model_arch, task_type = _ARCH_MAP[distill]
    else:
        # Fall through: BYOM bundles. Caller must supply model_type +
        # task_type via from_pretrained kwargs.
        if "model_type" not in kwargs or "task_type" not in kwargs:
            raise ValueError(
                f"flytbase_bundle: bundle's distillation_target {distill!r} "
                f"not in {sorted(_ARCH_MAP)}; pass `model_type=` and "
                f"`task_type=` to AutoModel.from_pretrained() to override "
                f"(BYOM-style)."
            )
        model_arch = kwargs["model_type"]
        task_type = kwargs["task_type"]

    # ---- file metadata --------------------------------------------------
    weights_md5 = _md5(weights_path)
    weights_url = weights_path.resolve().as_uri()  # file:// URL
    onnx_opset = int((manifest.get("model") or {}).get("opset", 17))

    # Surface license + provenance via `model_features` so the next layer
    # (AutoModel) can do D10 enforcement.
    runtime_compat = (manifest.get("license") or {}).get("runtime_compatibility")
    auto_labeler_license = (manifest.get("license") or {}).get("auto_labeler")
    model_features = {
        "flytbase.license.runtime_compatibility": runtime_compat,
        "flytbase.license.auto_labeler": auto_labeler_license,
        "flytbase.bundle.template": template,
        "flytbase.bundle.version": version,
        "flytbase.bundle.weights_sha256":
            (manifest.get("model") or {}).get("sha256"),
        "flytbase.bundle.classes":
            (manifest.get("template") or {}).get("classes"),
        "flytbase.bundle.input_resolution":
            (manifest.get("model") or {}).get("input_resolution"),
        "flytbase.bundle.signer":
            (manifest.get("signer") or {}).get("scheme"),
    }

    package = ModelPackageMetadata(
        package_id=f"{template}-{version}-onnx",
        backend=BackendType.ONNX,
        package_artefacts=[
            FileDownloadSpecs(
                download_url=weights_url,
                file_handle="weights.onnx",
                md5_hash=weights_md5,
            ),
        ],
        quantization=Quantization.FP32,
        onnx_package_details=ONNXPackageDetails(opset=onnx_opset),
        # `trusted_source` reflects whether the bundle is signed.
        # Phase A: any ed25519-prototype-signed bundle counts as trusted
        # for the local registration path; production tightens this with
        # Bundle signing service #3 verification.
        trusted_source=(
            (manifest.get("signer") or {}).get("scheme") == "ed25519-prototype"
        ),
        model_features=model_features,
    )

    return ModelMetadata(
        model_id=model_id,
        model_architecture=model_arch,
        task_type=task_type,
        model_packages=[package],
        # `model_variant` could carry the bundle's template_version,
        # but that's already in model_id; leave None.
    )


def _md5(p: Path) -> str:
    h = hashlib.md5()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
