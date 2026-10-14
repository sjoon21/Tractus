"""실시간 자막(live.py) 테스트. 모델 없이 가짜 VAD·ASR로 돈다. 실제 모델 테스트는 test_models_slow.py."""

import json
import struct
import threading
import time
from pathlib import Path

import numpy as np
import pytest
from types import SimpleNamespace
from typer.testing import CliRunner

from tractus import cli, live

REC = live.REC_SR
SR = live.SR
FRAME = live.FRAME


def wav_header(data_bytes: int, sr: int = REC, channels: int = 1, bits: int = 16) -> bytes:
    """recorder/Sources/RecorderKit/Wav.swift의 44바이트 헤더와 같다."""
    return (b"RIFF" + struct.pack("<I", 36 + data_bytes) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, sr, sr * channels * bits // 8, channels * bits // 8, bits)
            + b"data" + struct.pack("<I", data_bytes))


def write_wav(path: Path, samples: np.ndarray) -> None:
    pcm = np.asarray(samples, "<i2").tobytes()
    path.write_bytes(wav_header(len(pcm)) + pcm)


# ── WavTail ────────────────────────────────────────────────────────────────


def test_wav_tail_reads_growing_file_with_header_rewrites_and_partial_frames(tmp_path):
    path = tmp_path / "mic.wav"
    rng = np.random.default_rng(0)
    samples = rng.integers(-30000, 30000, REC, dtype=np.int16)  # 1초
    raw = samples.astype("<i2").tobytes()
    tail = live.WavTail(path)
    assert tail.frames() == 0  # 파일이 아직 없다

    def writer():
        with path.open("wb") as f:
            f.write(wav_header(0)[:20])  # 헤더 일부만 쓴 순간도 있다
            f.flush()
            time.sleep(0.01)
            f.write(wav_header(0)[20:])
            pos, since = 0, 0
            while pos < len(raw):
                n = int(rng.integers(1, 3001))  # 홀수 바이트: 표본이 반만 쓰인 순간이 생긴다
                f.write(raw[pos:pos + n])
                f.flush()
                pos += n
                since += n
                if since >= REC // 4 * 2 // 8:  # 헤더 크기 필드 갱신 (Wav.swift는 0.25초마다, 여기선 더 자주)
                    f.seek(4); f.write(struct.pack("<I", 36 + pos)); f.seek(40); f.write(struct.pack("<I", pos)); f.seek(0, 2)
                    since = 0
                time.sleep(0.0005)

    t = threading.Thread(target=writer)
    t.start()
    got, pos = [], 0
    while t.is_alive() or pos < len(samples):
        n = tail.frames()
        assert n >= pos
        if n > pos:
            x = tail.read(pos, n - pos)
            assert len(x) == n - pos
            got.append(x)
            pos = n
    t.join()
    tail.close()
    assert np.array_equal(np.concatenate(got), samples)


def test_wav_tail_rejects_wrong_format(tmp_path):
    path = tmp_path / "mic.wav"
    path.write_bytes(wav_header(0, sr=16000))
    with pytest.raises(ValueError, match="48"):
        live.WavTail(path).frames()


# ── Mixer ──────────────────────────────────────────────────────────────────


def test_mixer_sums_and_clips_tracks_by_sample_index(tmp_path):
    write_wav(tmp_path / "mic.wav", np.array([1000, 30000, -30000, 0], np.int16))
    write_wav(tmp_path / "system.wav", np.array([1000, 30000, -30000], np.int16))
    m = live.Mixer([live.WavTail(tmp_path / "mic.wav"), live.WavTail(tmp_path / "system.wav")])
    x = m.read()
    assert np.allclose(x, [2000 / 32768, 1.0, -1.0])  # 짧은 트랙을 기다린다 (4번째 표본은 아직)
    assert m.pending() == 1


def test_mixer_zero_fills_a_stalled_track(tmp_path):
    n = int(live.STALL_S * REC) + 10
    write_wav(tmp_path / "mic.wav", np.full(n, 1000, np.int16))
    m = live.Mixer([live.WavTail(tmp_path / "mic.wav"), live.WavTail(tmp_path / "system.wav")])  # system.wav는 끝내 안 생김
    x = m.read()
    assert len(x) == n and np.allclose(x, 1000 / 32768)


# ── Resampler ──────────────────────────────────────────────────────────────


def test_resampler_streaming_matches_one_shot_and_filters():
    t = np.arange(REC * 2) / REC
    x = (0.5 * np.sin(2 * np.pi * 1000 * t) + 0.5 * np.sin(2 * np.pi * 10000 * t)).astype(np.float32)
    whole = live.Resampler()(x)
    rs, parts, i = live.Resampler(), [], 0
    for n in np.random.default_rng(1).integers(1, 4000, 200):
        parts.append(rs(x[i:i + n]))
        i += n
    parts.append(rs(x[i:]))
    streamed = np.concatenate(parts)
    assert np.allclose(streamed, whole, atol=1e-6)
    assert abs(len(whole) - len(x) / 3) <= live.TAPS
    # 1 kHz는 남고 10 kHz(16k에서는 나이퀴스트 초과 → 접힘)는 지워진다
    y = whole[SR // 2:]
    spec = np.abs(np.fft.rfft(y)) / (len(y) / 2)
    freqs = np.fft.rfftfreq(len(y), 1 / SR)
    assert spec[np.argmin(abs(freqs - 1000))] == pytest.approx(0.5, abs=0.02)
    assert spec[np.argmin(abs(freqs - 6000))] < 0.005  # 10 kHz가 16 kHz로 접히는 자리


# ── Segmenter ──────────────────────────────────────────────────────────────


def energy_vad(frame) -> float:
    """가짜 VAD: 소리가 있으면 1, 없으면 0."""
    return 1.0 if np.abs(frame).mean() > 0.01 else 0.0


def speech(sec: float, amp: float = 0.3) -> np.ndarray:
    return np.random.default_rng(int(sec * 1000)).uniform(-amp, amp, int(sec * SR)).astype(np.float32)


def silence(sec: float) -> np.ndarray:
    return np.zeros(int(sec * SR), np.float32)


def push_all(seg, x, block=1000):
    out = []
    for i in range(0, len(x), block):
        out += seg.push(x[i:i + block])
    return out


def test_segmenter_finalises_after_half_second_of_silence():
    seg = live.Segmenter(energy_vad)
    early = push_all(seg, np.concatenate([silence(1), speech(2), silence(0.4)]))
    assert [(c.kind, c.uid) for c in early] == [("partial", 1)]  # 0.4초 무음으로는 확정 안 함. 0.19초 쉼에서 미리 전사할 몫만 나온다
    cuts = push_all(seg, silence(0.2))
    assert [(c.kind, c.uid) for c in cuts] == [("final", 1)]
    c = cuts[0]
    assert np.array_equal(early[0].audio, c.audio)  # 미리 전사한 오디오가 확정 오디오와 같다 → 확정 때 ASR을 다시 돌리지 않는다
    assert c.start / SR == pytest.approx(1 - live.PREROLL_FRAMES * FRAME / SR, abs=0.04)
    assert c.end / SR == pytest.approx(3 + live.TAIL_FRAMES * FRAME / SR, abs=0.04)  # 끝 무음은 0.2초만 남긴다
    assert len(c.audio) == c.end - c.start


def test_segmenter_drops_blips_shorter_than_min_speech():
    seg = live.Segmenter(energy_vad)
    assert push_all(seg, np.concatenate([speech(0.1), silence(1)])) == []
    cuts = push_all(seg, np.concatenate([speech(1), silence(1)]))
    assert [(c.kind, c.uid) for c in cuts] == [("partial", 1), ("final", 1)]  # 버린 발화는 id를 쓰지 않는다


def test_segmenter_emits_partials_every_three_seconds_then_final():
    seg = live.Segmenter(energy_vad)
    cuts = push_all(seg, np.concatenate([speech(7), silence(1)]))
    assert [(c.kind, c.uid) for c in cuts] == [("partial", 1), ("partial", 1), ("partial", 1), ("final", 1)]
    assert [round(len(c.audio) / SR) for c in cuts[:2]] == [3, 6]


def test_segmenter_does_not_preview_during_trailing_silence():
    # 3초 미리보기 시점이 발화 끝 무음에 걸리면 3초 미리보기는 미룬다. 쉼(0.19초)의 미리 전사 하나만 나온다
    seg = live.Segmenter(energy_vad)
    cuts = push_all(seg, np.concatenate([speech(2.95), silence(1)]))
    assert [c.kind for c in cuts] == ["partial", "final"]
    assert len(cuts[0].audio) == len(cuts[1].audio)


def test_segmenter_caps_at_eight_seconds_at_the_quietest_point():
    seg = live.Segmenter(energy_vad)
    x = speech(12)
    dip = int(7.5 * SR)
    x[dip:dip + FRAME * 2] *= 0.05  # 7.5초 부근의 조용한 지점 (VAD는 여전히 발화로 본다)
    cuts = [c for c in push_all(seg, x) if c.kind == "final"]
    assert len(cuts) == 1 and cuts[0].uid == 1
    assert cuts[0].end / SR == pytest.approx(7.5, abs=0.07)
    rest = seg.flush()
    assert rest.uid == 2 and rest.start == cuts[0].end  # 잘린 뒤는 다음 발화로 이어진다
    assert seg.flush() is None


def test_segmenter_cap_inside_trailing_pause_ends_like_silence():
    # 8초 상한이 끝 쉼 안에서 걸리면 쉼에서 끝난 것으로 본다: 미리 전사한 오디오와 같아 확정 때 ASR을 다시 돌리지 않는다
    seg = live.Segmenter(energy_vad)
    cuts = push_all(seg, np.concatenate([speech(7.55), silence(1)]))
    assert [(c.kind, c.uid) for c in cuts] == [("partial", 1), ("partial", 1), ("partial", 1), ("final", 1)]  # 3초, 6초, 쉼, 확정
    assert np.array_equal(cuts[-2].audio, cuts[-1].audio)


def test_segmenter_hard_caps_continuous_speech():
    seg = live.Segmenter(energy_vad)
    finals = [c for c in push_all(seg, speech(30)) if c.kind == "final"]
    assert len(finals) >= 3 and all(len(c.audio) <= live.MAX_FRAMES * FRAME for c in finals)
    assert all(a.end == b.start for a, b in zip(finals, finals[1:]))


# ── Live (루프) ────────────────────────────────────────────────────────────


class FakeMixer:
    """read()가 미리 정한 블록을 하나씩 내준다. pending은 '그 사이 디스크에 더 쌓인 양'을 흉내 낸다."""

    def __init__(self, blocks, pending=0):
        self.blocks, self.pos, self._pending = list(blocks), 0, pending

    def read(self):
        if not self.blocks:
            return np.zeros(0, np.float32)
        x = self.blocks.pop(0)
        self.pos += len(x)
        return x

    def pending(self):
        return self._pending

    def skip(self):
        self.pos += self._pending
        self.pos -= self.pos % 3
        self._pending = 0


def up(x):
    return np.repeat(x, 3)  # 테스트용 16k → 48k (FakeMixer는 48k를 내준다)


class FakeASR:
    def __init__(self, delay=0.0):
        self.calls, self.delay = [], delay

    def __call__(self, audio):
        self.calls.append(len(audio) / SR)
        time.sleep(self.delay)
        return f"말{len(self.calls)}"


def collect():
    events = []
    return events, lambda event, **data: events.append({"event": event, **data})


def run_live(blocks, asr=None, pending=0, block=REC // 10):
    """block: 녹음을 따라가는 상황처럼 0.1초씩 읽힌다. None이면 한 번에 (뒤처진 상황)."""
    if block:
        blocks = [b[i:i + block] for b in blocks for i in range(0, len(b), block)]
    events, emit = collect()
    lv = live.Live(FakeMixer(blocks, pending), energy_vad, asr or FakeASR(), emit, warn=lambda code, msg: emit("warning", code=code, message=msg))
    while lv.step():
        pass
    return lv, events


def test_live_events_partial_then_final_with_same_id():
    lv, events = run_live([up(np.concatenate([silence(0.5), speech(4), silence(1)]))])
    assert [(e["kind"], e["id"]) for e in events] == [("partial", "l0001"), ("partial", "l0001"), ("final", "l0001")]
    assert lv.stats()["asr_calls"] == 2  # 확정은 쉼에서 미리 전사한 문장을 다시 쓴다
    final = events[-1]
    assert set(final) == {"event", "kind", "id", "start", "end", "text", "speaker"}
    assert final["event"] == "live" and final["speaker"] is None and final["text"] == "말2"
    assert final["start"] < 0.5 and final["end"] == pytest.approx(4.7, abs=0.05)
    assert isinstance(final["start"], float) and round(final["start"], 2) == final["start"]


def test_live_skips_partials_when_behind_real_time():
    # 발화 두 개가 한 번에 읽혔다(뒤처짐): 첫 발화의 partial 둘(3초, 쉼)은 같은 블록에서 확정되므로 건너뛴다.
    # 두 번째 발화의 partial은 살아 있지만 라이브 끝에서 1초 넘게 뒤라 건너뛴다.
    x = np.concatenate([speech(4), silence(1), speech(4)])
    lv, events = run_live([up(x)], pending=2 * REC, block=None)
    assert [(e["kind"], e["id"]) for e in events] == [("final", "l0001")]
    assert lv.stats()["skipped_partials"] == 3


def test_live_bounds_latency_by_skipping_ahead_once_warned():
    x = np.concatenate([speech(4), silence(1)])
    events, emit = collect()
    mixer = FakeMixer([up(x), up(speech(1)), up(speech(1))], pending=int((live.MAX_LAG_S + 1) * REC))
    lv = live.Live(mixer, energy_vad, FakeASR(), emit, warn=lambda code, msg: emit("warning", code=code, message=msg))
    lv.step()
    mixer._pending = int((live.MAX_LAG_S + 1) * REC)
    lv.step()
    assert [e["code"] for e in events if e["event"] == "warning"] == ["live_lagging"]  # 한 번만
    assert mixer.pos % 3 == 0 and lv.seg.t == mixer.pos // 3  # 건너뛴 뒤에도 시각이 맞다


class Clock:
    """가짜 시계: 녹음은 실시간으로 쌓이고(pending), ASR은 시간을 쓴다(t가 늘어난다). 실제로 자지 않는다."""

    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t


class ClockMixer(FakeMixer):
    """디스크에 쌓인 양 = 시계가 가리키는 시각까지 녹음된 표본 수 - 읽은 위치."""

    def __init__(self, audio, clock):
        super().__init__([], 0)
        self.audio, self.clock = audio, clock

    def _end(self):
        return min(int(self.clock.t * REC), len(self.audio))

    def read(self):
        x, self.pos = self.audio[self.pos:self._end()], self._end()
        return x

    def pending(self):
        return self._end() - self.pos

    def skip(self):
        self.pos = self._end() - self._end() % 3


def test_live_does_not_transcribe_old_utterances_inside_a_single_step():
    # 40초 분량(말 3초 + 쉼 1초 열 번)이 한 번에 읽혔고 ASR이 한 번에 3초 걸린다. 앞의 발화는 라이브 끝에서 10초 넘게 뒤라
    # ASR을 돌리지 않고 넘어가야 한다. step이 끝난 뒤에야 검사하면 마지막 발화는 36초 뒤에 나온다.
    clock = Clock(40.0)
    x = np.tile(np.concatenate([speech(3), silence(1)]), 10)
    events = []
    asr_calls = []

    def asr(audio):
        clock.t += 3.0
        asr_calls.append(len(audio) / SR)
        return f"말{len(asr_calls)}"

    emit = lambda event, **d: events.append((clock.t, {"event": event, **d}))  # noqa: E731
    lv = live.Live(ClockMixer(up(x), clock), energy_vad, asr, emit, warn=lambda code, msg: emit("warning", code=code), clock=clock)
    assert lv.step()
    finals = [(t, e) for t, e in events if e["event"] == "live" and e["kind"] == "final"]
    assert finals and len(finals) < 10 and lv.dropped >= 5
    for t, e in finals:
        assert t - e["end"] <= live.MAX_LAG_S + 3.0 + 0.1  # 시작할 때 10초 이내 + ASR 한 번
    assert [e["code"] for _, e in events if e["event"] == "warning"] == ["live_lagging"]  # 한 번만
    assert lv.stats()["dropped_finals"] == lv.dropped


def test_live_dropped_utterance_closes_the_preview_that_was_shown():
    clock = Clock(0.0)
    events = []
    texts = iter(["미리보기", "다시 전사한 문장"])
    asr = lambda audio: next(texts)  # noqa: E731 — 두 번째 ASR이 불리면 다른 문장이 나온다
    emit = lambda event, **d: events.append({"event": event, **d})  # noqa: E731
    mixer = ClockMixer(up(np.concatenate([speech(4), silence(40)])), clock)
    lv = live.Live(mixer, energy_vad, asr, emit, warn=lambda code, msg: None, clock=clock)
    clock.t = 3.2
    lv.step()  # 3초 미리보기가 나간다
    assert [e["kind"] for e in events if e["event"] == "live"] == ["partial"]
    clock.t = 40.0  # 그 뒤 한참 뒤처졌다 (확정 시점의 발화가 10초 넘게 낡았다)
    lv.step()
    kinds = [e["kind"] for e in events if e["event"] == "live"]
    assert kinds == ["partial", "final"] and events[-1]["text"] == "미리보기"  # 화면에 partial이 남지 않는다
    assert lv.shown is None


def test_live_stop_finalises_short_utterance():
    lv, events = run_live([up(np.concatenate([silence(0.5), speech(2)]))])
    assert events == []
    lv.finish()
    assert [(e["kind"], e["id"]) for e in events] == [("final", "l0001")]


def test_live_stop_skips_long_work_and_keeps_partial_text():
    asr = FakeASR()
    lv, events = run_live([up(speech(4))], asr=asr)
    assert [(e["kind"], e["text"]) for e in events] == [("partial", "말1")]
    asr.delay = 0  # 측정된 RTF가 커서 4초 발화는 1초 예산을 넘는다고 본다
    lv.asr_sec, lv.asr_audio = 10.0, 3.0
    lv.finish()
    assert events[-1] == {**events[0], "kind": "final", "end": events[-1]["end"]}  # 마지막 partial 문장으로 확정
    assert len(asr.calls) == 1


def test_live_empty_final_only_when_a_partial_was_shown():
    _, events = run_live([up(np.concatenate([speech(1), silence(1)]))], asr=lambda a: "")
    assert events == []  # 아무것도 보여 주지 않았으면 빈 final은 내지 않는다


def test_live_speaker_labels_from_streaming_diarizer():
    class FakeSpeakers:
        def __init__(self):
            self.fed = 0

        def feed(self, y):
            self.fed += len(y)

        def label(self, start, end):
            return "S1"

    events, emit = collect()
    spk = FakeSpeakers()
    lv = live.Live(FakeMixer([up(np.concatenate([speech(1), silence(1)]))]), energy_vad, FakeASR(), emit, warn=None, speakers=spk)
    lv.step()
    assert spk.fed == 2 * SR and events[-1]["speaker"] == "S1"


def test_speaker_track_labels_by_majority_in_first_appearance_order():
    class Model:
        def __init__(self):
            self.calls = 0

        def feed(self, y, state):
            n = len(y) // 160
            p = np.zeros((n, 8), np.float32)
            p[:, 3] = 0.9  # 모델 채널 3이 처음 말한 사람
            p[n // 2:, 3], p[n // 2:, 5] = 0.0, 0.9
            return type("R", (), {"speaker_probs": p})(), state

    track = live.SpeakerTrack(Model(), state=None)
    track.feed(np.zeros(SR * 2, np.float32))
    assert track.label(0.0, 0.9) == "S1"
    assert track.label(1.1, 2.0) == "S2"
    assert track.label(0.0, 2.0) in {"S1", "S2"}
    assert track.label(5.0, 6.0) is None  # 아직 확률이 없는 구간


# ── 녹음 폴더와 CLI ────────────────────────────────────────────────────────


def test_find_tracks_uses_recording_json_and_waits(tmp_path):
    stop = threading.Event()
    threading.Timer(0.2, lambda: (tmp_path / "recording.json").write_text(json.dumps({"tracks": {"mic": "mic.wav", "system": "system.wav"}}))).start()
    assert live.find_tracks(tmp_path, stop, wait_s=3) == [tmp_path / "mic.wav", tmp_path / "system.wav"]
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(live.LiveError):
        live.find_tracks(empty, stop, wait_s=0.1)


@pytest.fixture
def rec(tmp_path, monkeypatch):
    home = tmp_path / "home"
    for repo in (cli.VAD_MODEL, cli.MODELS[cli.Track.lite]):
        d = home / "models" / repo.split("/")[1].lower()
        d.mkdir(parents=True)
        (d / "config.json").write_text("{}")
    (home / "glossary.md").write_text("- 쿠버네티스\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRACTUS_HOME", str(home))
    monkeypatch.delenv("TRACTUS_MODELS_DIR", raising=False)
    d = tmp_path / "recordings" / "01K"
    d.mkdir(parents=True)
    (d / "recording.json").write_text(json.dumps({"schema_version": 1, "started_at": "2026-10-07T10:00:00+09:00", "duration": None, "tracks": {"mic": "mic.wav"}, "marks": []}))
    x = np.concatenate([silence(0.5), speech(1.5), silence(1)])
    write_wav(d / "mic.wav", (np.repeat(x, 3) * 32767).astype(np.int16))
    seen = {}

    def fake_load(vad_dir, asr_dir, diar_dir, hotwords, warn, stop=None):
        seen.update(vad=vad_dir.name, asr=asr_dir.name, hotwords=hotwords, diar=diar_dir and diar_dir.name)
        return energy_vad, FakeASR(), None

    monkeypatch.setattr(live, "load_models", fake_load)
    return d, seen


def test_cli_live_runs_until_stop_and_emits_contract_events(rec, monkeypatch):
    d, seen = rec
    monkeypatch.setattr(live, "POLL_S", 0.01)
    # 'stop'이 바로 오면 디스크에 있는 것을 다 읽고 끝낸다
    res = CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json"], input="stop\n")
    assert res.exit_code == 0, res.output
    events = [json.loads(line) for line in res.stdout.splitlines()]
    assert [e.get("stage") for e in events[:2]] == ["live_load", "live"]
    assert events[-1]["event"] == "done" and set(events[-1]["stats"]) >= {"audio_sec", "asr_sec", "asr_rtf", "finals", "partials", "skipped_partials"}
    finals = [e for e in events if e["event"] == "live" and e["kind"] == "final"]
    assert [f["id"] for f in finals] == ["l0001"]
    assert seen == {"vad": "silero-vad-v6", "asr": "qwen3-asr-0.6b-8bit", "hotwords": ["쿠버네티스"], "diar": None}  # 1.7B·화자 분리는 올리지 않는다
    assert all(e["speaker"] is None for e in finals)
    res = CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json", "--speakers"], input="stop\n")
    assert res.exit_code == 0 and seen["diar"] == "nemotron-3-diarization"


def test_cli_live_engine_std_loads_the_1_7b_dir_and_lite_stays_default(rec):
    d, seen = rec
    std = cli.models_dir() / "qwen3-asr-1.7b-8bit"
    std.mkdir(parents=True)
    (std / "config.json").write_text("{}")
    assert CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json", "--engine", "std"], input="stop\n").exit_code == 0
    assert seen["asr"] == "qwen3-asr-1.7b-8bit"
    assert CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json", "--engine", "lite"], input="stop\n").exit_code == 0
    assert seen["asr"] == "qwen3-asr-0.6b-8bit"
    bad = CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json", "--engine", "x"], input="stop\n")
    assert bad.exit_code != 0


def test_cli_live_engine_std_without_the_1_7b_fails_instead_of_falling_back_to_lite(rec):
    d, seen = rec  # rec에는 0.6B와 VAD만 있다
    res = CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json", "--engine", "std"], input="stop\n")
    assert res.exit_code != 0
    assert json.loads(res.stdout.splitlines()[-1])["code"] == "model_missing"
    assert "asr" not in seen


def test_cli_live_restores_signal_handlers(rec):
    import signal

    d, _ = rec
    before = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    assert CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json"], input="stop\n").exit_code == 0
    assert {sig: signal.getsignal(sig) for sig in before} == before


def test_cli_live_without_progress_json_prints_finals_to_the_terminal(rec):
    d, _ = rec
    res = CliRunner().invoke(cli.app, ["live", "--recording", str(d)], input="stop\n")
    assert res.exit_code == 0, res.output
    lines = res.stdout.splitlines()
    assert len(lines) == 1 and lines[0].startswith("[00:00] 말")  # 확정된 자막 한 줄. 미리보기·이벤트는 찍지 않는다


def test_cli_live_refuses_low_memory_without_force(rec, monkeypatch):
    d, _ = rec
    monkeypatch.setattr(cli, "physical_memory", lambda: 8 * 1024**3)
    res = CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json"], input="stop\n")
    assert res.exit_code == 1
    err = json.loads(res.stdout.splitlines()[-1])
    assert err["event"] == "error" and "16GB" in err["message"] and "--force" in err["message"]
    res = CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json", "--force"], input="stop\n")
    assert res.exit_code == 0


def test_cli_live_stops_on_stdin_eof(rec):
    d, _ = rec
    res = CliRunner().invoke(cli.app, ["live", "--recording", str(d), "--progress-json"], input="")
    assert res.exit_code == 0
    assert json.loads(res.stdout.splitlines()[-1])["event"] == "done"


def test_live_sim_reports_gpu_as_delta_over_baseline():
    """ioreg 사용률은 시스템 전체라 기준값을 뺀 값을 따로 적는다 (원값만 보고 목표 달성으로 읽지 않게)."""
    import importlib.util
    from types import SimpleNamespace

    spec = importlib.util.spec_from_file_location("live_sim", Path(__file__).resolve().parent.parent / "bench" / "live_sim.py")
    sim_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sim_mod)
    writer = SimpleNamespace(log=[(0, 0.0)], written_at=lambda sec: 0.0)
    sim = {"events": [], "writer": writer, "peak": {}, "gpu": [30.0, 28.8], "gpu_base": [17.0, 18.0], "stop_exit_sec": 0.1, "exit_code": 0}
    out = sim_mod.summarize(sim, None, None, 1.0, 1.0, "synthetic")
    assert (out["gpu_util_mean"], out["gpu_util_baseline"], out["gpu_util_delta"]) == (29.4, 17.5, 11.9)
    assert sim_mod.summarize({**sim, "gpu_base": []}, None, None, 1.0, 1.0, "synthetic")["gpu_util_delta"] is None


# ── 모델을 올리는 동안 정지 ────────────────────────────────────────────────


@pytest.fixture
def slow_loads(monkeypatch):
    """mlx 모델 로드를 가짜로 바꾼다. loads에 올린 순서가 남고, on_vad가 있으면 VAD를 올리는 중에 불린다 (정지가 그때 왔다)."""
    import mlx_audio.vad.utils as vad_utils

    import tractus.asr as asr_mod

    loads = []
    hooks = {"on_vad": lambda: None}

    def load_vad(path):
        loads.append("vad")
        hooks["on_vad"]()
        return SimpleNamespace(feed=lambda frame, state: (SimpleNamespace(item=lambda: 0.0), state))

    monkeypatch.setattr(vad_utils, "load", load_vad)
    monkeypatch.setattr(asr_mod.Transcriber, "load", classmethod(lambda cls, path: loads.append("asr") or SimpleNamespace(transcribe=lambda *a, **k: SimpleNamespace(text=""))))
    return loads, hooks


def make_rec(tmp_path) -> Path:
    d = tmp_path / "rec"
    d.mkdir()
    write_wav(d / "mic.wav", np.zeros(REC, np.int16))
    (d / "recording.json").write_text(json.dumps({"tracks": {"mic": "mic.wav"}}))
    return d


def run_live_main(tmp_path, stop):
    events, emit = collect()
    t = time.perf_counter()
    live.run(make_rec(tmp_path), emit, lambda code, msg: emit("warning", code=code), stop, tmp_path, tmp_path, None, [])
    return events, time.perf_counter() - t


def test_stop_during_vad_load_skips_the_asr_load_and_ends_with_done(tmp_path, slow_loads):
    loads, hooks = slow_loads
    stop = threading.Event()
    hooks["on_vad"] = stop.set  # VAD를 올리는 중에 정지가 왔다
    events, took = run_live_main(tmp_path, stop)
    assert loads == ["vad"]  # ASR 로드(1–2초)를 시작하지 않는다
    assert [e["event"] for e in events] == ["stage", "done"] and events[-1]["stats"]["audio_sec"] == 0.0
    assert took < 1.0


def test_stop_before_any_load_loads_nothing(tmp_path, slow_loads):
    loads, _ = slow_loads
    stop = threading.Event()
    stop.set()
    events, took = run_live_main(tmp_path, stop)
    assert loads == [] and events[-1]["event"] == "done" and took < 1.0


def test_load_models_checks_stop_between_asr_and_speakers(tmp_path, slow_loads):
    loads, hooks = slow_loads
    stop = threading.Event()
    assert live.load_models(tmp_path, tmp_path, None, [], print, stop) is not None  # 정지 없음: 모두 올린다
    assert loads == ["vad", "asr"]
    loads.clear()
    hooks["on_vad"] = stop.set
    assert live.load_models(tmp_path, tmp_path, None, [], print, stop) is None and loads == ["vad"]
