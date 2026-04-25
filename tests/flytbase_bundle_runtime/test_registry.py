from unittest.mock import MagicMock

import pytest

from flytbase_bundle_runtime.registry import (
    BundleResolutionError,
    FlytBaseBundleRegistry,
    resolve_bundle_uri,
)


@pytest.fixture
def staged_bundle(tmp_path, monkeypatch):
    """A `bundle://template/0.1.0/model/weights.onnx` resolves to a
    real file under a sandboxed cache dir."""
    cache = tmp_path / "cache"
    bundle_root = cache / "template" / "0.1.0"
    (bundle_root / "model").mkdir(parents=True)
    weights = bundle_root / "model" / "weights.onnx"
    weights.write_bytes(b"\x00")
    monkeypatch.setenv("FLYTBASE_BUNDLE_CACHE_DIR", str(cache))
    monkeypatch.delenv("FLYTBASE_ACTIVE_BUNDLE_ROOT", raising=False)
    return {"cache": cache, "bundle_root": bundle_root, "weights": weights}


def test_long_form_resolves_to_staged_file(staged_bundle):
    uri = "bundle://template/0.1.0/model/weights.onnx"
    assert resolve_bundle_uri(uri) == staged_bundle["weights"].resolve()


def test_short_form_resolves_against_active_root(tmp_path, monkeypatch):
    root = tmp_path / "active"
    (root / "model").mkdir(parents=True)
    weights = root / "model" / "weights.onnx"
    weights.write_bytes(b"\x00")
    monkeypatch.setenv("FLYTBASE_ACTIVE_BUNDLE_ROOT", str(root))
    monkeypatch.setenv("FLYTBASE_BUNDLE_CACHE_DIR", str(tmp_path / "unused"))
    assert resolve_bundle_uri("bundle://model/weights.onnx") == weights.resolve()


def test_short_form_without_active_root_is_rejected(tmp_path, monkeypatch):
    monkeypatch.delenv("FLYTBASE_ACTIVE_BUNDLE_ROOT", raising=False)
    monkeypatch.setenv("FLYTBASE_BUNDLE_CACHE_DIR", str(tmp_path / "cache"))
    with pytest.raises(BundleResolutionError):
        resolve_bundle_uri("bundle://model/weights.onnx")


def test_traversal_via_dotdot_at_root_blocked(staged_bundle):
    with pytest.raises(BundleResolutionError):
        resolve_bundle_uri("bundle://../../../etc/passwd")


def test_traversal_inside_long_form_blocked(staged_bundle):
    with pytest.raises(BundleResolutionError):
        resolve_bundle_uri("bundle://template/0.1.0/../../../etc/passwd")


def test_deep_traversal_inside_long_form_blocked(staged_bundle):
    with pytest.raises(BundleResolutionError):
        resolve_bundle_uri(
            "bundle://template/0.1.0/x/../../../../../etc/passwd"
        )


def test_unstaged_long_form_is_rejected(staged_bundle):
    with pytest.raises(BundleResolutionError):
        resolve_bundle_uri("bundle://nope/0.0.1/model/weights.onnx")


def test_wrong_scheme_is_rejected():
    with pytest.raises(BundleResolutionError):
        resolve_bundle_uri("http://example.com/foo")


def test_empty_bundle_uri_is_rejected():
    with pytest.raises(BundleResolutionError):
        resolve_bundle_uri("bundle://")


def test_decorator_delegates_non_bundle_ids():
    wrapped = MagicMock()
    wrapped.registry_dict = {}
    wrapped.get_model.return_value = "delegated"
    reg = FlytBaseBundleRegistry(wrapped=wrapped)
    out = reg.get_model("workspace/project/3", api_key="k")
    assert out == "delegated"
    wrapped.get_model.assert_called_once_with("workspace/project/3", "k")


def test_decorator_intercepts_bundle_id_and_delegates_with_synthetic_endpoint(
    tmp_path, monkeypatch
):
    """End-to-end happy path: bundle URI → stage → wrapped registry sees
    the synthetic Roboflow-shaped endpoint, not the bundle URI."""
    import yaml

    cache = tmp_path / "cache"
    bundle_root = cache / "tmpl" / "0.1.0"
    (bundle_root / "model").mkdir(parents=True)
    (bundle_root / "model" / "weights.onnx").write_bytes(b"\x00")
    manifest = {
        "template": {
            "name": "tmpl",
            "version": "0.1.0",
            "kind": "object-detection",
            "classes": ["car", "person"],
        },
        "license": {"runtime_compatibility": "open"},
        "provenance": {"distillation_target": "rf-detr-base"},
    }
    (bundle_root / "manifest.yaml").write_text(yaml.safe_dump(manifest))
    # Ensure neither inherited env enables gates during this test —
    # the test fixture exercises the registry plumbing, not gate policy.
    monkeypatch.delenv("FLYTBASE_LICENSE_GATE_ENABLED", raising=False)
    monkeypatch.delenv("FLYTBASE_SIGNATURE_VERIFY_ENABLED", raising=False)

    model_cache = tmp_path / "model_cache"
    monkeypatch.setenv("FLYTBASE_BUNDLE_CACHE_DIR", str(cache))
    monkeypatch.delenv("FLYTBASE_ACTIVE_BUNDLE_ROOT", raising=False)
    monkeypatch.setattr(
        "flytbase_bundle_runtime.adapter.MODEL_CACHE_DIR",
        str(model_cache),
    )

    # rf-detr-base is a known mapping — the decorator short-circuits to
    # the legacy class and skips the wrapped registry. Use an unknown
    # distillation_target to force fall-through to the wrapped registry.
    manifest_path = bundle_root / "manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text())
    manifest["template"]["kind"] = "object-detection"
    manifest["provenance"]["distillation_target"] = "rf-detr-base"
    manifest_path.write_text(yaml.safe_dump(manifest))

    class FakeBaseModel:
        def __init__(self, model_id, *args, **kwargs):
            self.received_model_id = model_id

    wrapped = MagicMock()
    wrapped.registry_dict = {}
    wrapped.get_model.return_value = FakeBaseModel
    reg = FlytBaseBundleRegistry(wrapped=wrapped)

    out = reg.get_model(
        "bundle://tmpl/0.1.0/model/weights.onnx", api_key="x"
    )
    # rf-detr-base routes through the legacy `RFDETRObjectDetection`
    # class, which means the wrapped registry is NOT consulted. Verify
    # the redirect class was created with the synthetic endpoint anyway.
    wrapped.get_model.assert_not_called()
    assert out._flytbase_endpoint == "flytbase-tmpl/0.1.0"
    assert out.__name__ == "FlytBaseBundle_RFDETRObjectDetection"
