"""실시간 자막(live.py) 테스트. 모델 없이 가짜 VAD·ASR로 돈다. 실제 모델 테스트는 test_models_slow.py."""

import json
import struct
import threading
import time
from pathlib import Path

import numpy as np
import pytest
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

    def fake_load(vad_dir, asr_dir, diar_dir, hotwords, warn):
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
