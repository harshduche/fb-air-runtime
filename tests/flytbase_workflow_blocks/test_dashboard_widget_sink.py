import datetime as dt

import pytest

from flytbase_workflow_blocks.dashboard_widget_sink.v1 import (
    OUTPUT_KEY_WIDGET,
    DashboardWidgetSinkBlockV1,
    DashboardWidgetSinkManifest,
    _coerce_value,
    _slug,
)


# -------------------------------------------------------------- helpers


def _run(block, **kwargs):
    return block.run(**kwargs)[OUTPUT_KEY_WIDGET]


# ------------------------------------------------------- value coercion


def test_counter_coerces_int_through_unchanged():
    assert _coerce_value(7, "counter") == 7


def test_counter_coerces_bool_to_int():
    assert _coerce_value(True, "counter") == 1
    assert _coerce_value(False, "counter") == 0


def test_counter_coerces_numeric_string():
    assert _coerce_value("42", "counter") == 42.0


def test_counter_coerces_unparseable_to_zero():
    assert _coerce_value("not a number", "counter") == 0
    assert _coerce_value(None, "counter") == 0


def test_alert_coerces_truthy_to_bool():
    assert _coerce_value(1, "alert") is True
    assert _coerce_value(0, "alert") is False
    assert _coerce_value("anything", "alert") is True
    assert _coerce_value("", "alert") is False


def test_label_stringifies_non_none():
    assert _coerce_value(42, "label") == "42"
    assert _coerce_value(None, "label") is None


def test_gauge_and_sparkline_act_like_counter():
    assert _coerce_value(3.14, "gauge") == 3.14
    assert _coerce_value(True, "sparkline") == 1


# ----------------------------------------------------------- slugifier


def test_slug_normalises_label_for_id():
    assert _slug("People in Dock Zone") == "people_in_dock_zone"


def test_slug_falls_back_when_empty():
    assert _slug("") == "widget"
    assert _slug("!!!") == "widget"


# ---------------------------------------------------------- block.run


def test_counter_payload_shape():
    payload = _run(
        DashboardWidgetSinkBlockV1(),
        value=5,
        widget_type="counter",
        widget_label="People in zone",
    )
    assert payload["widget_type"] == "counter"
    assert payload["label"] == "People in zone"
    assert payload["value"] == 5
    assert payload["widget_id"] == "people_in_zone"
    # ISO-8601 with timezone
    parsed = dt.datetime.fromisoformat(payload["timestamp"])
    assert parsed.tzinfo is not None
    assert "severity" not in payload


def test_widget_id_override():
    payload = _run(
        DashboardWidgetSinkBlockV1(),
        value=3,
        widget_type="counter",
        widget_label="Anything",
        widget_id="custom_id_42",
    )
    assert payload["widget_id"] == "custom_id_42"


def test_alert_with_severity_includes_severity():
    payload = _run(
        DashboardWidgetSinkBlockV1(),
        value=True,
        widget_type="alert",
        widget_label="Perimeter breach",
        severity="critical",
    )
    assert payload["value"] is True
    assert payload["severity"] == "critical"


def test_severity_ignored_for_non_alert_widgets():
    """Severity only meaningful on `alert`; quietly dropped elsewhere."""
    payload = _run(
        DashboardWidgetSinkBlockV1(),
        value=5,
        widget_type="counter",
        widget_label="x",
        severity="warning",
    )
    assert "severity" not in payload


def test_invalid_widget_type_raises():
    with pytest.raises(ValueError):
        _run(
            DashboardWidgetSinkBlockV1(),
            value=1,
            widget_type="bogus",
            widget_label="x",
        )


def test_invalid_severity_raises():
    with pytest.raises(ValueError):
        _run(
            DashboardWidgetSinkBlockV1(),
            value=True,
            widget_type="alert",
            widget_label="x",
            severity="catastrophic",
        )


def test_manifest_type_tag():
    schema = DashboardWidgetSinkManifest.model_json_schema()
    assert (
        schema["properties"]["type"].get("const")
        == "flytbase/dashboard_widget_sink@v1"
    )
