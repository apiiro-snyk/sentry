import uuid

import pytest

from sentry.sentry_metrics.extraction_rules import MetricsExtractionRule


def _new_id():
    return str(uuid.uuid4())


def test_generate_mri():
    rule = MetricsExtractionRule("count_clicks", "c", "none", {"tag_1", "tag_2"}, [])
    mri = rule.generate_mri()
    assert mri == "c:custom/count_clicks@none"


def test_type_validation():
    rules = [
        MetricsExtractionRule("count_clicks", "c", "none", {"tag_1", "tag_2"}, []),
        MetricsExtractionRule(
            "process_latency",
            "d",
            "none",
            {"tag_3"},
            ["first:value second:value", "foo:bar", "greetings:['hello', 'goodbye']"],
        ),
        MetricsExtractionRule("unique_ids", "s", "none", set(), ["foo:bar"]),
    ]

    mris = [rule.generate_mri() for rule in rules]
    assert mris == [
        "c:custom/count_clicks@none",
        "d:custom/process_latency@none",
        "s:custom/unique_ids@none",
    ]

    with pytest.raises(ValueError):
        MetricsExtractionRule("count_clicks", "f", "none", {"tag_1", "tag_2"}, [])
    with pytest.raises(ValueError):
        MetricsExtractionRule("count_clicks", "distribution", "none", {"tag_1", "tag_2"}, [])
