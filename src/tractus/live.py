"""실시간 자막(미리보기, Phase 7.2): 녹음 중인 트랙 WAV를 꼬리부터 읽어 Silero VAD로 발화를 자르고 Qwen3-ASR 0.6B로 전사한다.

미리보기 전용이다. 아무것도 저장하지 않는다. 녹음을 멈추면 이 워커가 먼저 끝나고, 배치 전사(1.7B + 화자 분리 + 정렬)가
정식 전사를 만든다 (ARCHITECTURE.md §2.6, docs/desktop.md §2.8).

흐름: WavTail(트랙마다) → Mixer(표본 위치로 합산·클립, amix normalize=0과 같음) → Resampler(48k → 16k)
→ Segmenter(Silero feed, 0.5초 무음 또는 8초 상한에서 확정, 3초마다 미리보기) → Live(ASR, 뒤처지면 partial부터 건너뜀).
"""

import gc
import json
import os
import struct
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from tractus.i18n import t

REC_SR = 48000  # tractus-rec 트랙 (recorder/Sources/RecorderKit/Wav.swift)
SR = 16000  # VAD·ASR
FACTOR = REC_SR // SR
FRAME = 512  # Silero 16 kHz 창 (32ms)

THRESHOLD = 0.5  # Silero 기본값과 같다. 이 이상이면 발화
NEG_THRESHOLD = 0.35  # 무음을 세기 시작하는 값 (Silero: threshold - 0.15)
SILENCE_FRAMES = 16  # 0.512초 무음이면 확정
MAX_FRAMES = 250  # 8.0초 상한
CUT_SEARCH_FRAMES = 31  # 상한에서 자를 때 마지막 약 1초 안의 가장 조용한 창에서 자른다
PARTIAL_FRAMES = 94  # 약 3초마다 미리보기
PREROLL_FRAMES = 6  # 발화 앞 0.19초를 붙인다 (첫 음절이 잘리지 않게)
TAIL_FRAMES = 6  # 끝 무음은 0.19초만 남긴다
MIN_SPEECH_FRAMES = 8  # 0.26초보다 짧은 발화(기침, 클릭)는 버린다 (Silero min_speech_duration_ms 250)

STALL_S = 1.0  # 트랙 하나가 이만큼 뒤처지면(장치 재연결 등) 그 구간을 0으로 채우고 진행한다
PARTIAL_LAG_S = 1.0  # 라이브 끝에서 이보다 뒤처진 미리보기는 건너뛴다
MAX_LAG_S = 10.0  # 이보다 뒤처지면 밀린 오디오를 건너뛰고 라이브 끝으로 간다 (live_lagging 경고 한 번)
STOP_BUDGET_S = 1.0  # 정지 후 마무리 전사에 쓰는 시간
EMPTY_STATS = {"audio_sec": 0.0, "asr_sec": 0.0, "asr_rtf": None, "asr_calls": 0, "finals": 0, "partials": 0, "skipped_partials": 0, "dropped_finals": 0}
WAIT_S = 5.0  # 녹음 파일이 생기기를 기다리는 시간
POLL_S = 0.05

# 48k → 16k 데시메이션 저역 필터: 97탭 Hamming windowed-sinc, 차단 7 kHz.
# resample_poly는 호출마다 경계를 0으로 채워 블록마다 잡음이 생기므로, 이전 블록 꼬리를 이어 붙이는 상태 있는 FIR로 한다.
# 통과 대역 ~6.2 kHz(음성 대역 충분), 저지 대역 ~7.8 kHz부터 -50 dB 이상(접힘 방지), 지연 48표본(1ms, 무시).
TAPS = 97
_n = np.arange(TAPS) - (TAPS - 1) / 2
_FIR = (np.sinc(2 * 7000 / REC_SR * _n) * np.hamming(TAPS)).astype(np.float32)
_FIR /= _FIR.sum()


class LiveError(RuntimeError):
    pass


# ── 입력 ───────────────────────────────────────────────────────────────────


def _data_offset(head: bytes) -> int | None:
    """WAV 헤더에서 data 청크 시작 위치. 헤더가 아직 덜 쓰였으면 None, 형식이 다르면 ValueError."""
    if len(head) < 12:
        return None
    if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        raise ValueError(t("WAV 파일이 아닙니다"))
    pos, fmt_ok = 12, False
    while pos + 8 <= len(head):
        cid, size = head[pos:pos + 4], struct.unpack("<I", head[pos + 4:pos + 8])[0]
        if cid == b"data":
            if not fmt_ok:
                raise ValueError(t("WAV fmt 청크가 data보다 뒤에 있습니다"))
            return pos + 8
        if cid == b"fmt ":
            if pos + 24 > len(head):
                return None
            fmt, ch, sr = struct.unpack("<HHI", head[pos + 8:pos + 16])
            bits = struct.unpack("<H", head[pos + 22:pos + 24])[0]
            if (fmt, ch, sr, bits) != (1, 1, REC_SR, 16):
                raise ValueError(t("48 kHz mono 16-bit PCM WAV가 아닙니다 (형식 {fmt}, {ch}채널, {sr} Hz, {bits}비트)", fmt=fmt, ch=ch, sr=sr, bits=bits))
            fmt_ok = True
        pos += 8 + size + (size & 1)
    return None


class WavTail:
    """녹음 중에 커지는 WAV를 꼬리부터 읽는다. 헤더의 크기 필드는 0.25초마다만 갱신되므로 읽지 않고 파일 크기로 센다.
    파일이 아직 없거나 헤더가 덜 쓰였으면 0, 표본이 반만 쓰였으면 그 표본은 다음에 읽는다."""

    def __init__(self, path: Path):
        self.path = path
        self._f = None
        self._data: int | None = None

    def _ready(self) -> bool:
        if self._f is None:
            try:
                self._f = self.path.open("rb")
            except FileNotFoundError:
                return False
        if self._data is None:
            self._f.seek(0)
            self._data = _data_offset(self._f.read(4096))
        return self._data is not None

    def frames(self) -> int:
        if not self._ready():
            return 0
        return max(0, (os.fstat(self._f.fileno()).st_size - self._data) // 2)

    def read(self, start: int, n: int) -> np.ndarray:
        if n <= 0 or not self._ready():
            return np.zeros(0, np.int16)
        self._f.seek(self._data + 2 * start)
        b = self._f.read(2 * n)
        return np.frombuffer(b[: len(b) // 2 * 2], "<i2")

    def close(self) -> None:
        if self._f is not None:
            self._f.close()
            self._f = None


class Mixer:
    """트랙들을 같은 표본 위치끼리 더하고 [-1, 1]로 자른다 (배치 전사의 ffmpeg amix normalize=0과 같다).
    tractus-rec가 늦게 시작한 트랙과 끊긴 구간을 0으로 채워 두므로 표본 위치가 곧 시각이다."""

    def __init__(self, tails: list[WavTail]):
        self.tails = tails
        self.pos = 0  # 48k 표본 위치

    def pending(self) -> int:
        """디스크에 있지만 아직 읽지 않은 표본 수 (가장 앞선 트랙 기준)."""
        return max(t.frames() for t in self.tails) - self.pos

    def read(self) -> np.ndarray:
        avail = [t.frames() - self.pos for t in self.tails]
        n = min(avail)
        if max(avail) - n > STALL_S * REC_SR:
            # ponytail: 멈춘 트랙은 0으로 채우고 넘어간다. 그 트랙이 나중에 같은 구간을 써도 다시 읽지 않는다 (미리보기라 충분)
            n = max(avail)
        if n <= 0:
            return np.zeros(0, np.float32)
        acc = np.zeros(n, np.float32)
        for t in self.tails:
            x = t.read(self.pos, n)
            acc[: len(x)] += x / 32768.0
        self.pos += n
        return np.clip(acc, -1.0, 1.0)

    def skip(self) -> None:
        """밀린 오디오를 버리고 라이브 끝으로 간다. 48k → 16k 위치가 맞도록 3의 배수로 맞춘다."""
        self.pos += self.pending()
        self.pos -= self.pos % FACTOR

    def close(self) -> None:
        for t in self.tails:
            t.close()


class Resampler:
    """48k → 16k 스트리밍 데시메이터. 블록을 어떻게 나눠 넣어도 한 번에 넣은 결과와 같다. 출력 k = 입력 3k 위치."""

    def __init__(self):
        self.buf = np.zeros(TAPS - 1, np.float32)

    def __call__(self, x: np.ndarray) -> np.ndarray:
        buf = np.concatenate([self.buf, np.asarray(x, np.float32)])
        if len(buf) < TAPS:
            self.buf = buf
            return np.zeros(0, np.float32)
        y = np.convolve(buf, _FIR, "valid")[::FACTOR]
        self.buf = buf[len(y) * FACTOR:]
        return y.astype(np.float32)


# ── 발화 나누기 ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Cut:
    kind: str  # "partial" | "final"
    uid: int  # 발화 번호 (1부터). 이벤트 id = l0001
    start: int  # 16k 표본 위치
    audio: np.ndarray

    @property
    def end(self) -> int:
        return self.start + len(self.audio)


class Segmenter:
    """16k 오디오를 512표본 창마다 VAD에 넣어 발화를 자른다. VAD는 창 → 발화 확률 함수 (Silero `feed()`).

    - 발화 중 0.5초 무음 → final (끝 무음은 0.19초만 남김)
    - 8초 상한 → 마지막 약 1초 중 가장 조용한 창에서 잘라 final, 나머지는 다음 발화로 이어짐
    - 발화가 이어지는 동안 약 3초마다 partial (지금까지의 발화 전체). 무음을 세는 중이면 말이 다시 나올 때까지 미룬다
    - 쉼이 0.19초 이어지면 partial 하나 (확정될 오디오와 같아서 Live가 그 문장을 확정에 다시 쓴다)
    """

    def __init__(self, prob: Callable[[np.ndarray], float]):
        self.prob = prob
        self.t = 0  # 지금까지 VAD에 넣은 16k 표본 수
        self.n = 0  # 내보낸 발화 수
        self.rest = np.zeros(0, np.float32)
        self._idle()

    def _idle(self) -> None:
        self.active = False
        self.buf: list[np.ndarray] = []
        self.pre: deque = deque(maxlen=PREROLL_FRAMES)
        self.uid: int | None = None
        self.start = self.speech = self.silence = self.since = 0

    def push(self, x: np.ndarray) -> list[Cut]:
        x = np.concatenate([self.rest, x])
        n = len(x) // FRAME * FRAME
        self.rest = x[n:]
        out: list[Cut] = []
        for i in range(0, n, FRAME):
            out += self._frame(x[i:i + FRAME])
        return out

    def _frame(self, f: np.ndarray) -> list[Cut]:
        p = self.prob(f)
        at = self.t
        self.t += FRAME
        if not self.active:
            if p < THRESHOLD:
                self.pre.append(f)
                return []
            self.active, self.buf, self.start = True, [*self.pre, f], at - len(self.pre) * FRAME
            self.speech, self.silence, self.since = 1, 0, len(self.buf)
            return []
        self.buf.append(f)
        self.since += 1
        if p >= THRESHOLD:
            self.speech += 1
            self.silence = 0
        elif self.silence or p < NEG_THRESHOLD:  # Silero처럼 한 번 무음이 시작되면 threshold를 넘을 때까지 센다
            self.silence += 1
        if self.silence >= SILENCE_FRAMES:
            return self._end()
        if self.silence == TAIL_FRAMES and self.speech >= MIN_SPEECH_FRAMES:
            # 쉼이 0.19초 이어지면 지금 버퍼 = 확정될 오디오(끝 무음 0.19초까지)다. 미리 전사해 두면 0.5초에서 확정할 때
            # ASR을 다시 돌리지 않아 확정 지연에서 ASR 시간(0.2–0.4초)이 빠진다. 말이 이어지면 미리보기로만 쓰인다.
            self.since = 0
            return [self._cut("partial", self.buf)]
        if len(self.buf) >= MAX_FRAMES:
            return self._end() if self.silence >= TAIL_FRAMES else self._cap()  # 쉼 안에서 상한에 닿으면 쉼에서 끝난 것으로 본다
        if self.since >= PARTIAL_FRAMES and not self.silence:  # 끝 무음 중에는 미리보기를 미룬다: 곧 확정되면 ASR을 아껴 확정이 빨라진다
            self.since = 0
            return [self._cut("partial", self.buf)]
        return []

    def _cut(self, kind: str, frames: list[np.ndarray]) -> Cut:
        if self.uid is None:
            self.n += 1
            self.uid = self.n
        return Cut(kind, self.uid, self.start, np.concatenate(frames))

    def _trimmed(self) -> list[np.ndarray]:
        return self.buf[: len(self.buf) - self.silence + min(self.silence, TAIL_FRAMES)]

    def _end(self) -> list[Cut]:
        out = [self._cut("final", self._trimmed())] if self.speech >= MIN_SPEECH_FRAMES or self.uid is not None else []
        tail = self.buf[-PREROLL_FRAMES:]
        self._idle()
        self.pre.extend(tail)
        return out

    def _cap(self) -> list[Cut]:
        w = self.buf[-CUT_SEARCH_FRAMES:]
        k = len(self.buf) - len(w) + int(np.argmin([float(np.mean(f * f)) for f in w]))
        head, rest = self.buf[:k], self.buf[k:]
        out = [self._cut("final", head)]
        self.start += k * FRAME
        # 자른 뒤 남은 창은 발화로 센다. 끝의 짧은 무음(TAIL_FRAMES 미만)은 그대로 이어서 센다
        self.buf, self.uid, self.since, self.speech = rest, None, len(rest), max(0, len(rest) - self.silence)
        return out

    def flush(self) -> Cut | None:
        """정지: 진행 중인 발화를 final로. 발화가 없거나 너무 짧으면 None."""
        if not self.active or (self.speech < MIN_SPEECH_FRAMES and self.uid is None):
            self._idle()
            return None
        cut = self._cut("final", self._trimmed())
        self._idle()
        return cut

    def reset(self, t: int) -> None:
        """진행 중인 발화를 버리고 t(16k 표본 위치)부터 다시 시작한다."""
        self._idle()
        self.t, self.rest = t, np.zeros(0, np.float32)


# ── 화자 (선택) ────────────────────────────────────────────────────────────


class SpeakerTrack:
    """Nemotron 3 Diarization 스트리밍('low' 프리셋, 입력 지연 1.04초)의 프레임별 화자 확률을 모아 구간에 라벨을 붙인다.
    라벨은 이 미리보기 안에서 처음 나온 순서대로 S1, S2, …이고 최종 전사의 라벨과 다를 수 있다."""

    STRIDE = 0.01  # 10ms 프레임
    KEEP = 12000  # 최근 120초만 들고 있는다

    def __init__(self, model, state):
        self.model, self.state = model, state
        self.p = np.zeros((0, 8), np.float32)
        self.base = 0  # self.p[0]의 프레임 번호
        self.names: dict[int, str] = {}

    def feed(self, y: np.ndarray) -> None:
        res, self.state = self.model.feed(y, self.state)
        probs = np.asarray(res.speaker_probs, np.float32)
        if probs.size:
            self.p = np.concatenate([self.p, probs.reshape(len(probs), -1)])
            if len(self.p) > self.KEEP:
                drop = len(self.p) - self.KEEP
                self.p, self.base = self.p[drop:], self.base + drop

    def label(self, start: float, end: float) -> str | None:
        """구간 안에서 확률이 THRESHOLD를 넘는 프레임의 다수결 화자. 아직 확률이 없는 구간이면 None."""
        i0 = max(0, int(start / self.STRIDE) - self.base)
        i1 = max(0, int(end / self.STRIDE) - self.base)
        p = self.p[i0:i1]
        on = p[p.max(1) > THRESHOLD] if len(p) else p
        if not len(on):
            return None
        k = int(np.bincount(on.argmax(1)).argmax())
        return self.names.setdefault(k, f"S{len(self.names) + 1}")

    def reset(self, t: float) -> None:
        """밀린 오디오를 건너뛴 뒤: 시각이 끊겼으므로 스트림을 새로 시작한다 (라벨이 바뀔 수 있다)."""
        self.state = self.model.init_streaming_state()
        self.p, self.base = np.zeros((0, 8), np.float32), round(t / self.STRIDE)


# ── 루프 ───────────────────────────────────────────────────────────────────


class Live:
    """한 번의 step()이 디스크에 쌓인 오디오를 모두 읽어 발화를 자르고 전사해 이벤트를 낸다."""

    def __init__(self, mixer, vad_prob, asr: Callable[[np.ndarray], str], emit, warn=None, speakers=None, clock=time.monotonic):
        self.mixer, self.asr, self.emit, self.speakers, self.clock = mixer, asr, emit, speakers, clock
        self.warn = warn or (lambda code, message: emit("warning", code=code, message=message))
        self.resample = Resampler()
        self.seg = Segmenter(vad_prob)
        self.audio = 0  # 읽은 48k 표본 수
        self.asr_sec = self.asr_audio = 0.0
        self.finals = self.partials = self.skipped = self.calls = self.dropped = 0
        self.cache: tuple[int, int, str] | None = None  # 마지막으로 전사한 (uid, 표본 수, 문장)
        self.lagging = False
        self.shown: tuple[int, str, float] | None = None  # 지금 화면에 있는 partial (uid, text, start)
        self.deadline: float | None = None  # 정지 중이면 마무리 시한

    def stats(self) -> dict:
        audio_sec = self.audio / REC_SR
        return {"audio_sec": round(audio_sec, 2), "asr_sec": round(self.asr_sec, 2), "asr_rtf": round(self.asr_sec / audio_sec, 3) if audio_sec else None,
                "asr_calls": self.calls,
                "finals": self.finals, "partials": self.partials, "skipped_partials": self.skipped, "dropped_finals": self.dropped}

    def _rtf(self) -> float:
        """전사한 오디오 1초당 걸린 시간. 아직 모르면 0.1 (0.6B 실측 약 0.06)."""
        return self.asr_sec / self.asr_audio if self.asr_audio else 0.1

    def _lag(self, cut: Cut) -> float:
        return (self.mixer.pos + self.mixer.pending()) / REC_SR - cut.end / SR

    def _cached(self, cut: Cut) -> bool:
        return self.cache is not None and self.cache[:2] == (cut.uid, len(cut.audio))

    def _too_old(self, cut: Cut) -> bool:
        """한 step 안에서도 밀림을 본다: ASR을 돌리기 전에 라이브 끝에서 MAX_LAG_S 넘게 뒤처진 발화면 전사하지 않는다.
        (미리 전사해 둔 문장이 있으면 ASR이 들지 않으므로 그대로 확정한다. 정지 중에는 STOP_BUDGET_S가 시간을 막는다)"""
        return self.deadline is None and not self._cached(cut) and self._lag(cut) > MAX_LAG_S

    def _drop(self, cut: Cut) -> None:
        """너무 오래된 발화를 전사하지 않고 넘어간다. 보이던 미리보기가 있으면 그 문장으로 확정해 화면에 남지 않게 한다."""
        self._warn_lagging()
        self.dropped += 1
        if self.shown and self.shown[0] == cut.uid:
            text, self.shown = self.shown[1], None
            self.finals += 1
            self._send("final", cut.uid, cut.start / SR, cut.end / SR, text, self._speaker(cut))

    def step(self) -> bool:
        x = self.mixer.read()
        if not len(x):
            return False
        self.audio += len(x)
        y = self.resample(x)
        self._feed_speakers(y)
        cuts = self.seg.push(y)
        final_uids = {c.uid for c in cuts if c.kind == "final"}
        last_partial = max((i for i, c in enumerate(cuts) if c.kind == "partial"), default=None)
        for i, c in enumerate(cuts):
            if c.kind == "final":
                if self._too_old(c):
                    self._drop(c)
                else:
                    self._final(c)
            elif self.deadline is None and i == last_partial and c.uid not in final_uids and self._lag(c) < PARTIAL_LAG_S:
                self._partial(c)
            else:
                self.skipped += 1
        if self.deadline is None and self.mixer.pending() > MAX_LAG_S * REC_SR:
            self._skip_ahead()
        return True

    def finish(self) -> None:
        """정지: 디스크에 남은 오디오를 읽고 진행 중인 발화를 마무리한다. 전사는 STOP_BUDGET_S 안에 끝날 것만 한다."""
        self.deadline = self.clock() + STOP_BUDGET_S
        while self.clock() < self.deadline and self.step():
            pass
        cut = self.seg.flush()
        if cut is not None:
            self._final(cut)

    def _feed_speakers(self, y: np.ndarray) -> None:
        if self.speakers is None or not len(y):
            return
        try:
            self.speakers.feed(y)
        except Exception as e:  # noqa: BLE001 — 화자 라벨은 선택 기능이다. 실패하면 화자 없이 계속
            self.speakers = None
            self.warn("diarizer_failed", t("실시간 화자 구분에 실패해 화자 없이 계속합니다: {error}", error=e))

    def _speaker(self, cut: Cut) -> str | None:
        return self.speakers.label(cut.start / SR, cut.end / SR) if self.speakers is not None else None

    def _transcribe(self, cut: Cut) -> str:
        if self.cache and self.cache[:2] == (cut.uid, len(cut.audio)):
            return self.cache[2]  # 쉼에서 미리 전사한 그 오디오
        t = time.perf_counter()
        text = self.asr(cut.audio)
        self.asr_sec += time.perf_counter() - t
        self.asr_audio += len(cut.audio) / SR
        self.calls += 1
        self.cache = (cut.uid, len(cut.audio), text)
        return text

    def _send(self, kind: str, uid: int, start: float, end: float, text: str, speaker: str | None) -> None:
        self.emit("live", kind=kind, id=f"l{uid:04d}", start=round(start, 2), end=round(end, 2), text=text, speaker=speaker)

    def _partial(self, cut: Cut) -> None:
        text = self._transcribe(cut)
        if not text:
            return
        self.partials += 1
        self.shown = (cut.uid, text, cut.start / SR)
        self._send("partial", cut.uid, cut.start / SR, cut.end / SR, text, self._speaker(cut))

    def _final(self, cut: Cut) -> None:
        shown = self.shown if self.shown and self.shown[0] == cut.uid else None
        if not self._cached(cut) and self.deadline is not None and self.clock() + len(cut.audio) / SR * self._rtf() > self.deadline:
            text = shown[1] if shown else ""  # 시간이 모자라면 보이던 미리보기 문장으로 확정한다
        else:
            text = self._transcribe(cut)
        if shown:
            self.shown = None
        elif not text:
            return  # 보여 준 적 없는 빈 발화는 알리지 않는다. 빈 final은 '보이던 partial을 지워라'라는 뜻이다
        self.finals += 1
        self._send("final", cut.uid, cut.start / SR, cut.end / SR, text, self._speaker(cut))

    def _warn_lagging(self) -> None:
        if not self.lagging:
            self.lagging = True
            self.warn("live_lagging", t("실시간 텍스트 변환이 녹음을 따라가지 못해 일부 구간을 건너뜁니다. 녹음과 녹음 종료 후 변환에는 영향이 없습니다"))

    def _skip_ahead(self) -> None:
        self._warn_lagging()
        uid = self.seg.uid
        if self.shown and self.shown[0] == uid:  # 건너뛴 발화의 미리보기는 그 문장으로 확정해 둔다
            _, text, start = self.shown
            self.shown = None
            self.finals += 1
            self._send("final", uid, start, self.mixer.pos / REC_SR, text, None)
        self.mixer.skip()
        self.resample = Resampler()
        self.seg.reset(self.mixer.pos // FACTOR)
        if self.speakers is not None:
            self.speakers.reset(self.mixer.pos / REC_SR)


# ── 실행 ───────────────────────────────────────────────────────────────────


def find_tracks(rec_dir: Path, stop: threading.Event, wait_s: float = WAIT_S) -> list[Path]:
    """recording.json의 트랙 목록. tractus-rec는 WAV를 만든 직후 recording.json을 쓰므로 잠깐 기다린다.
    끝내 없으면 있는 mic.wav·system.wav를 쓴다."""
    deadline = time.monotonic() + wait_s
    while True:
        try:
            rec = json.loads((rec_dir / "recording.json").read_text(encoding="utf-8"))
            return [rec_dir / name for name in rec["tracks"].values()]
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass  # 원자적으로 쓰지만, 혹시 덜 쓰인 파일을 읽었으면 다시 본다
        if time.monotonic() >= deadline or stop.is_set():
            break
        stop.wait(0.05)
    found = [p for p in (rec_dir / "mic.wav", rec_dir / "system.wav") if p.exists()]
    if not found:
        raise LiveError(t("녹음 파일을 찾지 못했습니다 (recording.json, mic.wav): {path}", path=rec_dir))
    return found


def load_models(vad_dir: Path, asr_dir: Path, diar_dir: Path | None, hotwords: list[str], warn, stop: threading.Event | None = None):
    """→ (VAD 창 → 확률, 오디오 → 문장, SpeakerTrack | None). 앱은 0.6B(lite)만 올린다 (메모리). 1.7B(std)는 `--engine std`로 재는 개발·벤치 전용.
    stop이 설정되면 모델 사이에서 멈추고 None을 돌려준다 (이미 올리는 중인 모델 하나는 끝까지 기다린다: VAD 약 0.3초, ASR 0.6B 약 1–2초).
    diar_dir가 None이면 화자를 붙이지 않는다 (기본). 실측(M3, 68초 가상 대화, ARCHITECTURE §2.6): 화자 스트리밍을 켜면
    GPU 사용률 증가분(시스템 전체 − 시작 전 기준값) 약 12–17%p → 42%p, footprint 1.8 → 3.0–3.2GB. 인코더가 0.72초마다 화자 캐시(최대 528프레임) 전체를 다시 돌리기 때문이다."""
    stopped = stop.is_set if stop is not None else (lambda: False)
    if stopped():
        return None  # import도 아낀다 (mlx 불러오기만 약 0.5초)
    from mlx_audio.vad.utils import load as load_vad

    vad = load_vad(str(vad_dir))
    if stopped():
        return None
    state = None

    def prob(frame: np.ndarray) -> float:
        nonlocal state
        p, state = vad.feed(frame, state)
        return float(p.item())

    from tractus.asr import Transcriber

    transcriber = Transcriber.load(asr_dir)
    if stopped():
        return None

    def asr(audio: np.ndarray) -> str:
        return transcriber.transcribe(audio, language=None, hotwords=hotwords).text

    return prob, asr, _load_speakers(diar_dir, warn) if diar_dir is not None else None


def _load_speakers(diar_dir: Path, warn) -> SpeakerTrack | None:
    if not (diar_dir / "model.safetensors").exists() or not (diar_dir / "config.json").exists():
        warn("diarizer_missing", t("화자 분리 모델이 없어 실시간 자막에 화자를 표시하지 않습니다: {path}", path=diar_dir))
        return None
    try:
        from mlx_audio.vad import load

        model = load(str(diar_dir), strict=True)
        model.set_streaming_config("low")
        return SpeakerTrack(model, model.init_streaming_state())
    except Exception as e:  # noqa: BLE001 — 화자 라벨은 선택 기능이다
        warn("diarizer_failed", t("실시간 화자 구분 모델을 올리지 못해 화자 없이 자막을 냅니다: {error}", error=e))
        return None


def _peak_memory_gb() -> float | None:
    try:
        import mlx.core as mx

        return round(mx.get_peak_memory() / 1e9, 2)
    except Exception:  # noqa: BLE001 — 통계용
        return None


def _unload() -> None:
    try:
        import mlx.core as mx

        gc.collect()
        mx.clear_cache()
    except Exception:  # noqa: BLE001
        pass


def run(rec_dir: Path, emit, warn, stop: threading.Event, vad_dir: Path, asr_dir: Path, diar_dir: Path | None, hotwords: list[str]) -> None:
    """stop이 설정될 때까지 자막을 낸다. 이벤트: stage(live_load) → stage(live) → live* → done{stats}."""
    emit("stage", stage="live_load")
    tracks = find_tracks(rec_dir, stop)
    loaded = load_models(vad_dir, asr_dir, diar_dir, hotwords, warn, stop)
    if loaded is None:  # 모델을 올리는 동안 정지가 왔다: 자막 없이 끝낸다 (정식 변환은 녹음 파일에서 따로 만든다)
        _unload()
        emit("done", stats={**EMPTY_STATS, "peak_memory_gb": _peak_memory_gb()})
        return
    prob, asr, speakers = loaded
    mixer = Mixer([WavTail(p) for p in tracks])
    lv = Live(mixer, prob, asr, emit, warn=warn, speakers=speakers)
    emit("stage", stage="live")
    try:
        while not stop.is_set():
            if not lv.step():
                stop.wait(POLL_S)
        lv.finish()
    finally:
        mixer.close()
    stats = {**lv.stats(), "peak_memory_gb": _peak_memory_gb()}
    del lv, prob, asr, speakers, loaded
    _unload()
    emit("done", stats=stats)
