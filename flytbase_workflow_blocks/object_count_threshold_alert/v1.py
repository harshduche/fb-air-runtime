"""FlytBase block: alert when detection count crosses a threshold.

Drone-fleet operations care about counts (people in zone, vehicles at
perimeter, packages on a dock pad). This block consumes any
detection or segmentation prediction stream, optionally filters to a
class subset, and emits a boolean alert + the count + a human-readable
message. Pair it with a downstream sink (email, webhook, dashboard
widget) to drive operator alerts.
"""

from typing import List, Optional, Type, Union

import supervision as sv
from pydantic import ConfigDict, Field
from typing_extensions import Literal

from inference.core.workflows.execution_engine.entities.base import OutputDefinition
from inference.core.workflows.execution_engine.entities.types import (
    BOOLEAN_KIND,
    INSTANCE_SEGMENTATION_PREDICTION_KIND,
    INTEGER_KIND,
    LIST_OF_VALUES_KIND,
    OBJECT_DETECTION_PREDICTION_KIND,
    STRING_KIND,
    Selector,
)
from inference.core.workflows.prototypes.block import (
    BlockResult,
    WorkflowBlock,
    WorkflowBlockManifest,
)

OUTPUT_KEY_ALERT: str = "alert"
OUTPUT_KEY_COUNT: str = "count"
OUTPUT_KEY_MESSAGE: str = "message"

SHORT_DESCRIPTION = (
    "Emit an alert when the count of detections crosses a threshold."
)
LONG_DESCRIPTION = """
Counts detections on a frame and emits a boolean `alert` plus a
human-readable `message` whenever the count meets or exceeds a configurable
threshold. Optionally filters to a subset of class names before counting.

Typical drone-fleet use cases:

- "Alert when ≥3 people are inside the dock perimeter."
- "Alert when ≥1 unauthorised vehicle appears in the access road."
- "Alert when ≥5 packages are queued on the landing pad."

Outputs:

- `alert` (boolean): `True` when `count >= min_count`.
- `count` (int): number of detections after class filtering.
- `message` (string): operator-facing description of the alert state.

Pair the `alert` output with a downstream sink (email, webhook, dashboard
widget) to drive notifications. For dwell-based alerts (sustained
presence over time), feed the `alert` through the `delta_filter` block
or pair with `time_in_zone` upstream.
"""


class ObjectCountThresholdAlertManifest(WorkflowBlockManifest):
    model_config = ConfigDict(
        json_schema_extra={
            "name": "Object Count Threshold Alert",
            "version": "v1",
            "short_description": SHORT_DESCRIPTION,
            "long_description": LONG_DESCRIPTION,
            "license": "Apache-2.0",
            "block_type": "analytics",
        }
    )
    type: Literal["flytbase/object_count_threshold_alert@v1"]
    detections: Selector(
        kind=[
            OBJECT_DETECTION_PREDICTION_KIND,
            INSTANCE_SEGMENTATION_PREDICTION_KIND,
        ]
    ) = Field(  # type: ignore
        description="Object detection or instance segmentation predictions to count.",
        examples=["$steps.model.predictions"],
    )
    min_count: Union[int, Selector(kind=[INTEGER_KIND])] = Field(  # type: ignore
        default=1,
        description=(
            "Inclusive threshold. Alert fires when the number of detections "
            "(after class filtering) is ≥ this value."
        ),
        examples=[3, "$inputs.alert_threshold"],
    )
    class_filter: Optional[
        Union[List[str], Selector(kind=[LIST_OF_VALUES_KIND])]
    ] = Field(  # type: ignore
        default=None,
        description=(
            "Optional list of class names to keep before counting. If None, "
            "counts every detection regardless of class."
        ),
        examples=[["person"], ["person", "vehicle"]],
    )
    alert_label: Optional[Union[str, Selector(kind=[STRING_KIND])]] = Field(  # type: ignore
        default=None,
        description=(
            "Optional label used in the message string. Defaults to a generic "
            "'object' / 'objects' wording."
        ),
        examples=["person", "$inputs.label"],
    )

    @classmethod
    def describe_outputs(cls) -> List[OutputDefinition]:
        return [
            OutputDefinition(name=OUTPUT_KEY_ALERT, kind=[BOOLEAN_KIND]),
            OutputDefinition(name=OUTPUT_KEY_COUNT, kind=[INTEGER_KIND]),
            OutputDefinition(name=OUTPUT_KEY_MESSAGE, kind=[STRING_KIND]),
        ]

    @classmethod
    def get_execution_engine_compatibility(cls) -> Optional[str]:
        return ">=1.3.0,<2.0.0"


class ObjectCountThresholdAlertBlockV1(WorkflowBlock):
    @classmethod
    def get_manifest(cls) -> Type[WorkflowBlockManifest]:
        return ObjectCountThresholdAlertManifest

    def run(
        self,
        detections: sv.Detections,
        min_count: int = 1,
        class_filter: Optional[List[str]] = None,
        alert_label: Optional[str] = None,
    ) -> BlockResult:
        if class_filter:
            allowed = set(class_filter)
            class_names = detections.data.get("class_name")
            if class_names is None:
                count = 0
            else:
                count = sum(1 for name in class_names if name in allowed)
        else:
            count = len(detections)

        threshold = max(0, int(min_count))
        alert = count >= threshold

        label = alert_label or "object"
        plural = "s" if count != 1 else ""
        message = (
            f"{count} {label}{plural} detected — threshold {threshold} "
            + ("met" if alert else "not met")
        )

        return {
            OUTPUT_KEY_ALERT: alert,
            OUTPUT_KEY_COUNT: count,
            OUTPUT_KEY_MESSAGE: message,
        }
