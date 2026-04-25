"""FlytBase bundle:// runtime — registry decorator + cache-staging
adapter + load-time license/signature gates + AutoModel weights
provider.

Wired into the engine at startup via `docker/config/gpu_http.py`,
gated on `FLYTBASE_BUNDLE_REGISTRY_ENABLED=1`. See
`flytbase/pr_drafts/flytbase_bundle_registry.md` and
`flytbase/pr_drafts/flytbase_bundle_load_gates.md` for the design
trail.

Packaged at the repo root (sibling to `flytbase_workflow_blocks/`)
so the FlytBase additions live outside Roboflow's `inference/`
namespace and can lift cleanly into a separate pip-installable when
the repo splits.
"""

from flytbase_bundle_runtime.adapter import (
    get_legacy_class_for_bundle,
    make_redirect_class,
    stage_bundle_for_engine,
)
from flytbase_bundle_runtime.auto_model_provider import (
    get_flytbase_bundle_model,
)
from flytbase_bundle_runtime.gates import (
    BundleLicenseRefusedError,
    BundleSignatureRefusedError,
    check_license,
    verify_signature,
)
from flytbase_bundle_runtime.registry import (
    BundleResolutionError,
    FlytBaseBundleRegistry,
    resolve_bundle_uri,
)

__all__ = [
    "BundleLicenseRefusedError",
    "BundleResolutionError",
    "BundleSignatureRefusedError",
    "FlytBaseBundleRegistry",
    "check_license",
    "get_flytbase_bundle_model",
    "get_legacy_class_for_bundle",
    "make_redirect_class",
    "resolve_bundle_uri",
    "stage_bundle_for_engine",
    "verify_signature",
]
