from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, cast

import pytest

from sentry.testutils.pytest.sentry import _get_keep_and_discard_items


@dataclass(frozen=True)
class MockItem:
    nodeid: str


def _assert_shuffled(
    keep: list[pytest.Item], discard: list[pytest.Item], items: list[pytest.Item]
) -> None:
    assert len(keep) == len(items)
    assert set(keep) == set(items)
    out_of_order = False
    for i in range(len(items)):
        if keep[i] != items[i]:
            out_of_order = True
    assert out_of_order


@pytest.mark.parametrize(
    "num_items,total_groups,current_group,grouping_strategy,shuffle_tests,shuffler_seed,sample_rate,num_expected_keep_items,check_function",
    [
        pytest.param(100, 1, 0, "scope", False, 0, 1.0, 100, None, id="no deselection"),
        pytest.param(12, 3, 0, "scope", False, 0, 1.0, 5, None, id="basic sharding"),
        pytest.param(12, 3, 0, "scope", False, 0, 0.25, 2, None, id="sampling and sharding"),
        pytest.param(100, 1, 0, "scope", True, 0, 1.0, 100, _assert_shuffled, id="basic shuffle"),
    ],
)
def test_keep_discard(
    num_items: int,
    total_groups: int,
    current_group: int,
    grouping_strategy: str,
    shuffle_tests: bool,
    shuffler_seed: int,
    sample_rate: float,
    num_expected_keep_items: int,
    check_function: Callable[[list[pytest.Item], list[pytest.Item], list[pytest.Item]], None]
    | None,
) -> None:
    items = cast(
        "list[pytest.Item]", [MockItem(f"TestClass{i}::function_name{i}") for i in range(num_items)]
    )
    keep, discard = _get_keep_and_discard_items(
        items,
        total_groups,
        current_group,
        grouping_strategy,
        shuffle_tests,
        shuffler_seed,
        sample_rate,
    )
    assert len(keep) == num_expected_keep_items
    assert len(keep) + len(discard) == len(items)
    if check_function is not None:
        check_function(keep, discard, items)


def test_deterministic_sample():
    # make sure that the same parameters (with sampling and shuffling) product the same test set
    num_items = 100
    items = cast(
        "list[pytest.Item]", [MockItem(f"TestClass{i}::function_name{i}") for i in range(num_items)]
    )
    items_copy = items[:]
    keep_1, discard_1 = _get_keep_and_discard_items(
        items=items,
        total_groups=4,
        current_group=1,
        grouping_strategy="scope",
        shuffle_tests=True,
        shuffler_seed=420,
        sample_rate=0.1,
    )

    keep_2, discard_2 = _get_keep_and_discard_items(
        items=items_copy,
        total_groups=4,
        current_group=1,
        grouping_strategy="scope",
        shuffle_tests=True,
        shuffler_seed=420,
        sample_rate=0.1,
    )

    assert keep_1 == keep_2
    assert discard_1 == discard_2


def test_sample_change_seed():
    # make sure that the same parameters (with sampling and shuffling) produce a different test
    # set given a different seed
    num_items = 100
    items = cast(
        "list[pytest.Item]", [MockItem(f"TestClass{i}::function_name{i}") for i in range(num_items)]
    )
    items_copy = items[:]
    keep_1, discard_1 = _get_keep_and_discard_items(
        items=items,
        total_groups=4,
        current_group=1,
        grouping_strategy="scope",
        shuffle_tests=True,
        shuffler_seed=420,
        sample_rate=0.1,
    )

    keep_2, discard_2 = _get_keep_and_discard_items(
        items=items_copy,
        total_groups=4,
        current_group=1,
        grouping_strategy="scope",
        shuffle_tests=True,
        shuffler_seed=69,
        sample_rate=0.1,
    )

    assert len(keep_1) == len(keep_2)
    assert len(discard_1) == len(discard_2)
    assert keep_1 != keep_2
    assert discard_1 != discard_2
