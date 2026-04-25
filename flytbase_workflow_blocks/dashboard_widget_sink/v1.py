"""FlytBase block: emit a dashboard-widget-shaped payload.

The flow builder's Dashboard pane renders a grid of widgets. This block
takes any workflow value (count, alert flag, label, raw number) and
formats it as the JSON payload the renderer expects:

    {
      "widget_id": "...",
      "widget_type": "counter | gauge | label | sparkline | alert",
      "label": "Human-readable label",
      "value": <coerced to a widget-friendly shape>,
      "severity": "info | warning | critical",  # only for `alert` type
      "timestamp": "ISO-8601 UTC"
    }

Studio's Phase A status report (Finding 17) named this block by exact
type tag — slim bundles authored on the flow builder side may
reference `flytbase/dashboard_widget_sink@v1` from their workflow.json,
and Studio's enricher round-trips it unchanged.

Pair this downstream of an analytics or detection block to surface the
result on the dashboard. For alarms, pair with
`flytbase/object_count_threshold_alert@v1` upstream.
"""

from datetime import datetime, timezone
from typing import Any, List, Optional, Type, Union

from pydantic import ConfigDict, Field
from typing_extensions import Literal

from inference.core.workflows.execution_engine.entities.base import (
    OutputDefinition,
)
from inference.core.workflows.execution_engine.entities.types import (
    DICTIONARY_KIND,
    STRING_KIND,
    Selector,
    WILDCARD_KIND,
)
from inference.core.workflows.prototypes.block import (
    BlockResult,
    WorkflowBlock,
    WorkflowBlockManifest,
)

OUTPUT_KEY_WIDGET: str = "widget"

WIDGET_TYPES = ("counter", "gauge", "label", "sparkline", "alert")
SEVERITIES = ("info", "warning", "critical")

SHORT_DESCRIPTION = (
    "Format a workflow value as a FlytBase dashboard-widget payload."
)
LONG_DESCRIPTION = """
Pack a workflow value into a structured payload for the FlytBase
dashboard widget renderer. Useful as a terminal block when you want a
specific output to surface on the operator dashboard rather than only
in the workflow result envelope.

Widget types:

- `counter`: integer / float displayed as a chip with a label.
- `gauge`: numeric value rendered against a min/max range (front-end
  reads the bounds from `widget_id` config).
- `label`: arbitrary text or category.
- `sparkline`: numeric value appended to a per-widget rolling buffer
  (front-end maintains the buffer keyed on `widget_id`).
- `alert`: boolean (or boolean-like) that drives an alert chip; pair
  with `severity` to color-code.

Outputs `widget` — a dict the front-end can render directly. The block
is side-effect-free; pushing the payload over a webhook or message bus
is a separate sink.
"""


def _coerce_value(value: Any, widget_type: str) -> Any:
    """Make sure the rendered value matches the widget's expectation
    without surprising the front-end. Counter/gauge/sparkline expect a
    number, alert expects a boolean, label takes anything stringifiable.
    """
    if widget_type in {"counter", "gauge", "sparkline"}:
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, (int, float)):
            return value
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0
    if widget_type == "alert":
        return bool(value)
    return value if value is None else str(value)


def _slug(text: str) -> str:
    cleaned = "".join(c if c.isalnum() else "_" for c in (text or "")).strip("_")
    return cleaned.lower() or "widget"


class DashboardWidgetSinkManifest(WorkflowBlockManifest):
    model_config = ConfigDict(
        json_schema_extra={
            "name": "Dashboard Widget Sink",
            "version": "v1",
            "short_description": SHORT_DESCRIPTION,
            "long_description": LONG_DESCRIPTION,
            "license": "Apache-2.0",
            "block_type": "sink",
        }
    )
    type: Literal["flytbase/dashboard_widget_sink@v1"]
    value: Selector(kind=[WILDCARD_KIND]) = Field(  # type: ignore
        description="The workflow value to surface on the dashboard.",
        examples=["$steps.alert.count", "$steps.alert.alert"],
    )
    widget_type: Union[
        Literal["counter", "gauge", "label", "sparkline", "alert"],
        Selector(kind=[STRING_KIND]),
    ] = Field(  # type: ignore
        default="counter",
        description=(
            "Widget rendering style. Counter/gauge/sparkline expect a "
            "number; alert expects a boolean; label takes any text."
        ),
        examples=["counter", "alert"],
    )
    widget_label: Union[str, Selector(kind=[STRING_KIND])] = Field(  # type: ignore
        description="Human-readable label rendered next to the widget.",
        examples=["People in dock zone", "Perimeter alert"],
    )
    widget_id: Optional[Union[str, Selector(kind=[STRING_KIND])]] = Field(  # type: ignore
        default=None,
        description=(
            "Stable id used by the front-end to bind state across frames "
            "(rolling buffer for sparkline, threshold config for gauge, "
            "etc.). Defaults to a slugified widget_label."
        ),
        examples=["dock_perimeter_count", "$inputs.widget_id"],
    )
    severity: Optional[
        Union[Literal["info", "warning", "critical"], Selector(kind=[STRING_KIND])]
    ] = Field(  # type: ignore
        default=None,
        description=(
            "Optional severity tag — only meaningful for `alert` widgets. "
            "Drives alert chip colouring on the dashboard."
        ),
        examples=["warning", "critical"],
    )

    @classmethod
    def describe_outputs(cls) -> List[OutputDefinition]:
        return [
            OutputDefinition(name=OUTPUT_KEY_WIDGET, kind=[DICTIONARY_KIND]),
        ]

    @classmethod
    def get_execution_engine_compatibility(cls) -> Optional[str]:
        return ">=1.3.0,<2.0.0"


class DashboardWidgetSinkBlockV1(WorkflowBlock):
    @classmethod
    def get_manifest(cls) -> Type[WorkflowBlockManifest]:
        return DashboardWidgetSinkManifest

    def run(
        self,
        value: Any,
        widget_type: str = "counter",
        widget_label: str = "",
        widget_id: Optional[str] = None,
        severity: Optional[str] = None,
    ) -> BlockResult:
        if widget_type not in WIDGET_TYPES:
            raise ValueError(
                f"widget_type must be one of {WIDGET_TYPES}; got {widget_type!r}"
            )
        if severity is not None and severity not in SEVERITIES:
            raise ValueError(
                f"severity must be one of {SEVERITIES}; got {severity!r}"
            )
        resolved_id = widget_id or _slug(widget_label)
        payload = {
            "widget_id": resolved_id,
            "widget_type": widget_type,
            "label": widget_label,
            "value": _coerce_value(value, widget_type),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        if severity is not None and widget_type == "alert":
            payload["severity"] = severity
        return {OUTPUT_KEY_WIDGET: payload}
