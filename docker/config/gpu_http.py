import multiprocessing
import os
from functools import partial

from inference.core.cache import cache
from inference.core.env import (
    ACTIVE_LEARNING_ENABLED,
    ENABLE_STREAM_API,
    LAMBDA,
    MAX_ACTIVE_MODELS,
    STREAM_API_PRELOADED_PROCESSES,
)
from inference.core.interfaces.http.http_api import HttpInterface
from inference.core.interfaces.stream_manager.manager_app.app import start
from inference.core.logger import logger
from inference.core.managers.active_learning import (
    ActiveLearningManager,
    BackgroundTaskActiveLearningManager,
)
from inference.core.managers.base import ModelManager
from inference.core.managers.decorators.fixed_size_cache import WithFixedSizeCache
from inference.core.registries.flytbase_bundle import FlytBaseBundleRegistry
from inference.core.registries.roboflow import (
    RoboflowModelRegistry,
)
from inference.models.utils import ROBOFLOW_MODEL_TYPES

if ENABLE_STREAM_API:
    multiprocessing_context = multiprocessing.get_context(method="spawn")
    stream_manager_process = multiprocessing_context.Process(
        target=partial(start, expected_warmed_up_pipelines=STREAM_API_PRELOADED_PROCESSES),
    )
    stream_manager_process.start()

model_registry = RoboflowModelRegistry(ROBOFLOW_MODEL_TYPES)
if os.environ.get("FLYTBASE_BUNDLE_REGISTRY_ENABLED", "0") == "1":
    model_registry = FlytBaseBundleRegistry(wrapped=model_registry)
    logger.info("FlytBaseBundleRegistry wired around RoboflowModelRegistry")

    # Mirror wiring on the AutoModel weights-provider path.
    # The workflow engine here uses `inference_models.AutoModel.from_pretrained`
    # for detector blocks rather than the legacy ModelManager registry,
    # so the registry wrap above is necessary but not sufficient.
    from inference_models.weights_providers.core import WEIGHTS_PROVIDERS
    from inference_models.weights_providers.flytbase_bundle_provider import (
        get_flytbase_bundle_model,
    )

    _orig_roboflow_provider = WEIGHTS_PROVIDERS["roboflow"]

    def _flytbase_bundle_aware_roboflow_provider(model_id, api_key=None, **kwargs):
        # Direct bundle:// URI in a workflow.json.
        if isinstance(model_id, str) and model_id.startswith("bundle://"):
            parts = model_id[len("bundle://") :].split("/")
            if len(parts) >= 2 and all(parts[:2]):
                template, version = parts[0], parts[1]
                return get_flytbase_bundle_model(
                    f"{template}/{version}", api_key=api_key, **kwargs
                )
        # Synthetic Roboflow-shaped endpoint produced by FlytBaseBundleRegistry
        # for the AutoModel path (e.g. "flytbase-aerial/0.1.2").
        if isinstance(model_id, str) and model_id.startswith("flytbase-"):
            chunks = model_id.split("/")
            if len(chunks) == 2 and all(chunks):
                template = chunks[0][len("flytbase-") :]
                version = chunks[1]
                return get_flytbase_bundle_model(
                    f"{template}/{version}", api_key=api_key, **kwargs
                )
        return _orig_roboflow_provider(model_id, api_key=api_key, **kwargs)

    WEIGHTS_PROVIDERS["roboflow"] = _flytbase_bundle_aware_roboflow_provider
    WEIGHTS_PROVIDERS["flytbase_bundle"] = get_flytbase_bundle_model
    logger.info(
        "AutoModel `roboflow` provider wrapped + `flytbase_bundle` provider registered"
    )

if ACTIVE_LEARNING_ENABLED:
    if LAMBDA:
        model_manager = ActiveLearningManager(
            model_registry=model_registry, cache=cache
        )
    else:
        model_manager = BackgroundTaskActiveLearningManager(
            model_registry=model_registry, cache=cache
        )
else:
    model_manager = ModelManager(model_registry=model_registry)

model_manager = WithFixedSizeCache(model_manager, max_size=MAX_ACTIVE_MODELS)
model_manager.init_pingback()
interface = HttpInterface(
    model_manager,
)
app = interface.app
