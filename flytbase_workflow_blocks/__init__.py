"""FlytBase workflow blocks — registered with the engine via the
`WORKFLOWS_PLUGINS` env var (Roboflow's external-block plugin
contract; see
`inference/core/workflows/execution_engine/introspection/blocks_loader.py`).

Activate by setting `WORKFLOWS_PLUGINS=flytbase_workflow_blocks` in
the container env. `gpu_http.py` does this via `os.environ.setdefault`
when the FlytBase image boots, so the blocks are auto-loaded for any
deployment running this image.

Append new FlytBase blocks here as they ship — Phase 4 work items
(geofence_filter, dashboard_widget_sink, drone_telemetry_join, ...)
slot into the same list.
"""

from typing import List, Type

from inference.core.workflows.prototypes.block import WorkflowBlock

from flytbase_workflow_blocks.dashboard_widget_sink.v1 import (
    DashboardWidgetSinkBlockV1,
)
from flytbase_workflow_blocks.object_count_threshold_alert.v1 import (
    ObjectCountThresholdAlertBlockV1,
)


def load_blocks() -> List[Type[WorkflowBlock]]:
    """Plugin entry point — returns FlytBase blocks for the engine to register."""
    return [
        ObjectCountThresholdAlertBlockV1,
        DashboardWidgetSinkBlockV1,
    ]
