import json
from pathlib import Path

import pytest
import yaml

from inference.core.exceptions import ModelNotRecognisedError
from flytbase_bundle_runtime.adapter import (
    _build_environment_json,
    _extract_classes,
    _resolve_task_and_model_type,
    make_redirect_class,
    stage_bundle_for_engine,
)
from flytbase_bundle_runtime.registry import BundleResolutionError


def _write_bundle(
    root: Path,
    *,
    template_name: str = "demo",
    template_version: str = "0.1.0",
    template_kind: str = "object-detection",
    classes: list[str] | None = None,
    distillation_target: str = "rf-detr-base",
) -> Path:
    """Write a minimal Studio-shaped .flyttmpl bundle on disk."""
    classes = classes if classes is not None else ["car", "person"]
    bundle_root = root / template_name / template_version
    (bundle_root / "model").mkdir(parents=True)
    (bundle_root / "model" / "weights.onnx").write_bytes(b"\x00")
    (bundle_root / "manifest.yaml").write_text(
        yaml.safe_dump(
            {
                "template": {
                    "name": template_name,
                    "version": template_version,
                    "kind": template_kind,
                    "classes": classes,
                },
                "provenance": {"distillation_target": distillation_target},
            }
        )
    )
    return bundle_root


@pytest.fixture
def staged_paths(tmp_path, monkeypatch):
    cache = tmp_path / "bundle_cache"
    cache.mkdir()
    bundle_root = _write_bundle(cache)
    model_cache = tmp_path / "model_cache"
    monkeypatch.setenv("FLYTBASE_BUNDLE_CACHE_DIR", str(cache))
    monkeypatch.delenv("FLYTBASE_ACTIVE_BUNDLE_ROOT", raising=False)
    monkeypatch.setattr(
        "flytbase_bundle_runtime.adapter.MODEL_CACHE_DIR",
        str(model_cache),
    )
    return {
        "bundle_cache": cache,
        "bundle_root": bundle_root,
        "model_cache": model_cache,
    }


def test_resolve_task_and_model_type_known_pair():
    manifest = {
        "template": {"kind": "object-detection"},
        "provenance": {"distillation_target": "rf-detr-base"},
    }
    assert _resolve_task_and_model_type(manifest) == (
        "object-detection",
        "rfdetr-base",
    )


def test_resolve_task_and_model_type_short_kind_form():
    """Studio writes template.kind='detection' (short form) in some paths."""
    manifest = {
        "template": {"kind": "detection"},
        "provenance": {"distillation_target": "rf-detr-base"},
    }
    assert _resolve_task_and_model_type(manifest) == (
        "object-detection",
        "rfdetr-base",
    )


def test_resolve_task_and_model_type_unknown_pair_raises():
    manifest = {
        "template": {"kind": "object-detection"},
        "provenance": {"distillation_target": "ultralytics-yolov8n"},
    }
    with pytest.raises(ModelNotRecognisedError):
        _resolve_task_and_model_type(manifest)


def test_extract_classes_from_template():
    assert _extract_classes(
        {"template": {"classes": ["a", "b"]}}
    ) == ["a", "b"]


def test_extract_classes_from_model_block():
    assert _extract_classes(
        {"template": {}, "model": {"classes": ["only"]}}
    ) == ["only"]


def test_extract_classes_missing_raises():
    with pytest.raises(BundleResolutionError):
        _extract_classes({"template": {}, "model": {}})


def test_build_environment_has_resize_and_class_map():
    env = _build_environment_json(["car", "person"])
    assert env["PREPROCESSING"]["resize"]["format"] == "Stretch to"
    assert env["CLASS_MAP"] == {"0": "car", "1": "person"}
    assert env["MULTICLASS"] is False


def test_stage_writes_all_artifacts_and_returns_synthetic_endpoint(staged_paths):
    endpoint, (task, model) = stage_bundle_for_engine(
        "bundle://demo/0.1.0/model/weights.onnx"
    )
    assert endpoint == "flytbase-demo/0.1.0"
    assert task == "object-detection"
    assert model == "rfdetr-base"

    staged = staged_paths["model_cache"] / endpoint
    assert (staged / "weights.onnx").is_symlink()
    assert (staged / "weights.onnx").resolve() == (
        staged_paths["bundle_root"] / "model" / "weights.onnx"
    )
    env = json.loads((staged / "environment.json").read_text())
    assert env["PREPROCESSING"]["resize"]["format"] == "Stretch to"
    classes = (staged / "class_names.txt").read_text().strip().split("\n")
    assert classes == ["car", "person"]
    meta = json.loads((staged / "model_type.json").read_text())
    assert meta == {
        "project_task_type": "object-detection",
        "model_type": "rfdetr-base",
    }


def test_stage_segmentation_bundle_picks_segmentation_model_type(
    tmp_path, monkeypatch
):
    cache = tmp_path / "bundle_cache"
    cache.mkdir()
    _write_bundle(
        cache,
        template_name="aerial_seg",
        template_kind="instance-segmentation",
        distillation_target="rf-detr-seg-preview",
    )
    model_cache = tmp_path / "model_cache"
    monkeypatch.setenv("FLYTBASE_BUNDLE_CACHE_DIR", str(cache))
    monkeypatch.delenv("FLYTBASE_ACTIVE_BUNDLE_ROOT", raising=False)
    monkeypatch.setattr(
        "flytbase_bundle_runtime.adapter.MODEL_CACHE_DIR",
        str(model_cache),
    )

    endpoint, (task, model) = stage_bundle_for_engine(
        "bundle://aerial_seg/0.1.0/model/weights.onnx"
    )
    assert endpoint == "flytbase-aerial_seg/0.1.0"
    assert task == "instance-segmentation"
    assert model == "rfdetr"


def test_stage_rejects_uri_not_pointing_at_weights(staged_paths):
    # Drop a sibling file alongside weights.onnx to make a valid URI target
    other = staged_paths["bundle_root"] / "model" / "config.yaml"
    other.write_text("")
    with pytest.raises(BundleResolutionError):
        stage_bundle_for_engine("bundle://demo/0.1.0/model/config.yaml")


def test_stage_rejects_bundle_without_manifest(tmp_path, monkeypatch):
    cache = tmp_path / "bundle_cache"
    bundle_root = cache / "broken" / "0.1.0"
    (bundle_root / "model").mkdir(parents=True)
    (bundle_root / "model" / "weights.onnx").write_bytes(b"\x00")
    monkeypatch.setenv("FLYTBASE_BUNDLE_CACHE_DIR", str(cache))
    monkeypatch.delenv("FLYTBASE_ACTIVE_BUNDLE_ROOT", raising=False)
    with pytest.raises(BundleResolutionError):
        stage_bundle_for_engine("bundle://broken/0.1.0/model/weights.onnx")


def test_stage_is_idempotent(staged_paths):
    e1, _ = stage_bundle_for_engine("bundle://demo/0.1.0/model/weights.onnx")
    e2, _ = stage_bundle_for_engine("bundle://demo/0.1.0/model/weights.onnx")
    assert e1 == e2
    weights = staged_paths["model_cache"] / e1 / "weights.onnx"
    assert weights.is_symlink()


def test_make_redirect_class_overrides_model_id():
    captured = {}

    class Base:
        def __init__(self, model_id, **kwargs):
            captured["model_id"] = model_id
            captured["kwargs"] = kwargs

    Redirect = make_redirect_class(Base, "synthetic/v1")
    Redirect(model_id="bundle://anything", api_key="k")
    assert captured["model_id"] == "synthetic/v1"
    assert captured["kwargs"] == {"api_key": "k"}
    assert Redirect.__name__ == "FlytBaseBundle_Base"
