import numpy as np
import supervision as sv

from flytbase_workflow_blocks.object_count_threshold_alert.v1 import (
    OUTPUT_KEY_ALERT,
    OUTPUT_KEY_COUNT,
    OUTPUT_KEY_MESSAGE,
    ObjectCountThresholdAlertBlockV1,
    ObjectCountThresholdAlertManifest,
)


def _detections(class_names: list[str]) -> sv.Detections:
    n = len(class_names)
    boxes = np.zeros((n, 4), dtype=np.float32)
    confidence = np.full(n, 0.9, dtype=np.float32)
    return sv.Detections(
        xyxy=boxes,
        confidence=confidence,
        class_id=np.arange(n),
        data={"class_name": np.array(class_names)},
    )


def test_alert_fires_when_count_meets_threshold():
    block = ObjectCountThresholdAlertBlockV1()
    out = block.run(_detections(["person", "person", "person"]), min_count=3)
    assert out[OUTPUT_KEY_ALERT] is True
    assert out[OUTPUT_KEY_COUNT] == 3
    assert "3 object" in out[OUTPUT_KEY_MESSAGE]
    assert "met" in out[OUTPUT_KEY_MESSAGE]


def test_alert_does_not_fire_below_threshold():
    block = ObjectCountThresholdAlertBlockV1()
    out = block.run(_detections(["person"]), min_count=3)
    assert out[OUTPUT_KEY_ALERT] is False
    assert out[OUTPUT_KEY_COUNT] == 1
    assert "not met" in out[OUTPUT_KEY_MESSAGE]


def test_class_filter_excludes_other_classes():
    block = ObjectCountThresholdAlertBlockV1()
    out = block.run(
        _detections(["person", "vehicle", "vehicle", "person"]),
        min_count=2,
        class_filter=["person"],
    )
    assert out[OUTPUT_KEY_COUNT] == 2
    assert out[OUTPUT_KEY_ALERT] is True


def test_class_filter_yielding_zero_count_does_not_alert():
    block = ObjectCountThresholdAlertBlockV1()
    out = block.run(
        _detections(["vehicle", "vehicle"]),
        min_count=1,
        class_filter=["person"],
    )
    assert out[OUTPUT_KEY_COUNT] == 0
    assert out[OUTPUT_KEY_ALERT] is False


def test_alert_label_is_used_in_message():
    block = ObjectCountThresholdAlertBlockV1()
    out = block.run(
        _detections(["person", "person"]), min_count=1, alert_label="person"
    )
    assert "2 persons detected" in out[OUTPUT_KEY_MESSAGE]


def test_singular_message_when_count_is_one():
    block = ObjectCountThresholdAlertBlockV1()
    out = block.run(
        _detections(["vehicle"]), min_count=1, alert_label="vehicle"
    )
    assert "1 vehicle detected" in out[OUTPUT_KEY_MESSAGE]
    assert "1 vehicles" not in out[OUTPUT_KEY_MESSAGE]


def test_threshold_zero_always_alerts():
    block = ObjectCountThresholdAlertBlockV1()
    out = block.run(_detections([]), min_count=0)
    assert out[OUTPUT_KEY_ALERT] is True
    assert out[OUTPUT_KEY_COUNT] == 0


def test_negative_threshold_treated_as_zero():
    block = ObjectCountThresholdAlertBlockV1()
    out = block.run(_detections([]), min_count=-5)
    assert out[OUTPUT_KEY_ALERT] is True


def test_manifest_type_tag_is_namespaced():
    """Smoke: manifest's type Literal is the FlytBase namespace tag we'll
    reference from workflow.json."""
    schema = ObjectCountThresholdAlertManifest.model_json_schema()
    type_field = schema["properties"]["type"]
    assert type_field.get("const") == "flytbase/object_count_threshold_alert@v1"
