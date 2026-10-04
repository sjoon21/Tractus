import random

import numpy as np

from tractus.diarize import MAX_CHUNK_S, MIN_PIECE_S, SR, load_diarizer, smooth, split_chunks

STRIDE = 0.01  # Nemotron 3 Diarization 프레임 간격 (hop 160 / 16 kHz)


def probs(*runs, k=8):
    """runs: (프레임 수, 채널 또는 None=무음) → [T, k] 확률."""
    rows = []
    for n, ch in runs:
        r = np.full((n, k), 0.05, np.float32)
        if ch is not None:
            r[:, ch] = 0.9
        rows.append(r)
    return np.concatenate(rows)


def test_smooth_labels_by_first_appearance():
    assert smooth(probs((300, 3), (300, 0)), STRIDE) == [(0.0, 3.0, "S1"), (3.0, 6.0, "S2")]


def test_smooth_removes_flicker_and_short_turns():
    flicker = probs((300, 0), (4, 1), (300, 0))  # 40ms 깜빡임은 다수결 필터가 지운다
    assert smooth(flicker, STRIDE) == [(0.0, 6.04, "S1")]
    short = probs((300, 0), (50, 1), (300, 0))  # 0.5초 turn은 버리고 같은 화자 양쪽을 잇는다
    assert smooth(short, STRIDE) == [(0.0, 6.5, "S1")]


def test_smooth_fills_short_gaps_only():
    assert smooth(probs((300, 0), (50, None), (300, 0)), STRIDE) == [(0.0, 6.5, "S1")]
    assert smooth(probs((300, 0), (200, None), (300, 0)), STRIDE) == [(0.0, 3.0, "S1"), (5.0, 8.0, "S1")]


def test_smooth_below_threshold_or_empty_gives_no_turns():
    assert smooth(probs((500, None)), STRIDE) == []
    assert smooth(np.zeros((0, 8), np.float32), STRIDE) == []


def test_smooth_max_speakers_reassigns_least_talkative_to_nearest_kept():
    p = probs((400, 0), (200, 2), (400, 1))
    p[400:600, 1] = 0.3  # 버려지는 화자(2) 구간에서 남는 화자 중 1이 더 가깝다
    assert [t[2] for t in smooth(p, STRIDE)] == ["S1", "S2", "S3"]
    assert smooth(p, STRIDE, max_speakers=2) == [(0.0, 4.0, "S1"), (4.0, 10.0, "S2")]


def test_split_without_turns_keeps_chunks_with_null_speaker():
    chunks = [(0, 5 * SR), (6 * SR, 9 * SR)]
    assert split_chunks(chunks, []) == [(0, 5 * SR, None), (6 * SR, 9 * SR, None)]


def test_split_cuts_at_speaker_change_midpoint():
    chunks = [(0, 20 * SR)]
    turns = [(0.0, 8.0, "S1"), (9.0, 20.0, "S2")]
    assert split_chunks(chunks, turns) == [(0, int(8.5 * SR), "S1"), (int(8.5 * SR), 20 * SR, "S2")]


def test_split_merges_short_pieces_into_neighbor():
    chunks = [(0, 10 * SR)]
    assert split_chunks(chunks, [(0.0, 0.5, "S1"), (0.5, 10.0, "S2")]) == [(0, 10 * SR, "S2")]  # 앞 조각이 짧음
    assert split_chunks(chunks, [(0.0, 9.6, "S1"), (9.6, 12.0, "S2")]) == [(0, 10 * SR, "S1")]  # 뒤 조각이 짧음
    assert split_chunks([(0, SR // 2)], [(0.0, 3.0, "S1")]) == [(0, SR // 2, "S1")]  # 청크 자체가 짧으면 그대로


def test_split_chunk_outside_any_turn_is_unknown():
    assert split_chunks([(0, 2 * SR), (30 * SR, 32 * SR)], [(0.0, 3.0, "S1")]) == [(0, 2 * SR, "S1"), (30 * SR, 32 * SR, None)]


def test_split_properties_on_random_inputs():
    rng = random.Random(7)
    for _ in range(300):
        chunks, t = [], 0
        for _ in range(rng.randint(1, 8)):
            t += rng.randint(1, 3 * SR)  # 청크 사이에는 무음이 있다
            n = rng.randint(SR // 4, int(MAX_CHUNK_S * SR))
            chunks.append((t, t + n))
            t += n
        turns, x = [], 0.0
        while x < t / SR:
            d = rng.uniform(1.0, 15.0)
            turns.append((round(x, 2), round(x + d, 2), f"S{rng.randint(1, 3)}"))
            x += d + rng.choice([0.0, 0.0, rng.uniform(0, 2)])
        out = split_chunks(chunks, turns)
        # 길이·범위 보존: 원래 청크마다 조각들이 빈틈없이 이어진다
        i = 0
        for s, e in chunks:
            pos = s
            while i < len(out) and out[i][0] < e:
                assert out[i][0] == pos and out[i][1] > out[i][0]
                pos = out[i][1]
                i += 1
            assert pos == e
        assert i == len(out)
        assert all(e - s <= MAX_CHUNK_S * SR for s, e, _ in out)
        # 1초 미만 조각은 청크 자체가 1초 미만일 때만
        short_chunks = {(s, e) for s, e in chunks if e - s < MIN_PIECE_S * SR}
        assert all(e - s >= MIN_PIECE_S * SR or (s, e) in short_chunks for s, e, _ in out)
        # 조각마다 화자 하나, 같은 청크 안의 이웃 조각은 화자가 다르다
        assert all(isinstance(spk, str) or spk is None for _, _, spk in out)
        assert all(a[2] != b[2] for a, b in zip(out, out[1:]) if a[1] == b[0])


def test_load_diarizer_returns_none_without_model(tmp_path):
    assert load_diarizer(tmp_path) is None
