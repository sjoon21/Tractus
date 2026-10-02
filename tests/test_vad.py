from tractus.vad import SR, merge


def test_merge_joins_regions_up_to_max_length():
    speech = [(0, SR), (2 * SR, 3 * SR), (10 * SR, 40 * SR)]
    assert merge(speech, 30) == [(0, 3 * SR), (10 * SR, 40 * SR)]


def test_merge_splits_single_long_region():
    assert merge([(0, 70 * SR)], 30) == [(0, 30 * SR), (30 * SR, 60 * SR), (60 * SR, 70 * SR)]


def test_merge_empty():
    assert merge([], 30) == []
