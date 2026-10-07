"""Phase 7.2 실시간 자막 시뮬레이션: tractus-rec와 같은 형식(48 kHz mono int16, 헤더 크기 필드 0.25초마다 갱신)으로
WAV를 실시간 속도로 쓰면서 `tractus live --progress-json`을 돌려 잰다.

    uv run python bench/live_sim.py                                   # 가상 음성(say) 기본, 실시간
    uv run python bench/live_sim.py --source a.wav --reference a.txt  # 로컬 전용(AI Hub 등). 전사 텍스트는 출력하지 않는다
    uv run python bench/live_sim.py --speed 4                         # 배속 (지연 지표는 실시간에서만 의미 있음)
    uv run python bench/live_sim.py --speakers --out /tmp/x.json      # 실시간 화자 라벨을 켜고

지표 (bench/results/live_summary.json, 지표만):
  processing_p50/p95   final마다 0.5초 무음이 다 쓰인 순간부터 이벤트까지 (설계상 대기를 뺀 처리 지연)
  latency_p50/p95/max  확정 지연 = final 이벤트를 받은 시각 − 그 발화의 끝 표본을 디스크에 쓴 시각 (가상 음성만: 발화 경계를 안다)
                       설계상 0.5초 무음 대기가 들어 있다
  asr_rtf              ASR에 쓴 시간 / 오디오 길이 (done.stats)
  peak_footprint_gb    live 프로세스의 물리 footprint 최댓값 (`footprint -p`, Metal 버퍼 포함). peak_rss_gb는 `ps` RSS
  peak_mlx_gb          MLX가 잡은 최대 메모리 (done.stats)
  gpu_util_mean        시스템 전체 GPU 사용률 평균 (ioreg "Device Utilization %", sudo 불필요). live 프로세스만의 몫이 아니다
  gpu_util_baseline    시작 전 1초 동안의 같은 값 (다른 작업)
  gpu_util_delta       mean − baseline. live 몫의 근사일 뿐이다 (실행 중 다른 작업이 바뀌면 틀린다). 프로세스별 몫은 powermetrics(sudo)가 필요해 재지 않는다
  cer                  final 문장을 이은 것과 참조의 CER (공백·문장부호 제외)
  stop_exit_sec        stdin `stop` → 프로세스 종료
"""

import argparse
import json
import os
import re
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
OUT = Path(__file__).resolve().parent / "results" / "live_summary.json"
REC = 48000
BLOCK = REC // 50  # 20ms마다 쓴다 (tractus-rec 버퍼 크기와 비슷)
HEADER_EVERY = REC // 4  # Wav.swift headerInterval

# macOS say 한국어 음성 중 엔진이 다른 둘 (CLAUDE.md)
VOICES = ("Yuna", "Grandpa (한국어(한국))")
LINES = (
    "안녕하세요. 오늘 회의는 다음 분기 예산 검토입니다. 먼저 인건비부터 보겠습니다.",
    "네, 인건비는 작년보다 오 퍼센트 늘었습니다. 신규 채용 두 명이 반영됐습니다.",
    "좋습니다. 그러면 장비 구매 비용은 어떻게 되나요? 서버 교체 일정도 알려 주세요.",
    "서버는 십일월에 교체합니다. 장비 비용은 지난 분기와 거의 같습니다.",
    "클라우드 사용료는 어떻습니까?",
    "쿠버네티스 클러스터를 줄여서 매달 삼백만 원 정도 아꼈습니다. 다만 다음 달부터 트래픽이 늘어날 것으로 보여서 노드를 두 대 더 늘리는 방안을 검토하고 있습니다.",
    "알겠습니다. 마지막으로 교육 예산은요?",
    "교육 예산은 그대로 유지하고, 상반기에 못 쓴 금액은 하반기 외부 교육으로 돌리겠습니다.",
    "좋습니다. 오늘 회의는 여기까지 하겠습니다. 수고하셨습니다.",
)
GAPS = (0.8, 1.2, 0.7, 1.5, 0.9, 1.0, 0.8, 1.3, 2.0)


def wav_header(data_bytes: int) -> bytes:
    return (b"RIFF" + struct.pack("<I", 36 + data_bytes) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, REC, REC * 2, 2, 16)
            + b"data" + struct.pack("<I", data_bytes))


def synth(lines=LINES, gaps=GAPS) -> tuple[np.ndarray, list[tuple[float, float, str]]]:
    """say로 만든 대화 (48k int16)와 발화 [(시작 초, 끝 초, 문장)]. 끝은 say 출력에서 마지막 소리 표본."""
    parts, utts, t = [np.zeros(REC, np.int16)], [], REC  # 앞 1초 무음
    with tempfile.TemporaryDirectory() as d:
        for i, line in enumerate(lines):
            p = Path(d) / f"{i}.wav"
            subprocess.run(["say", "-v", VOICES[i % 2], "-o", str(p), f"--data-format=LEI16@{REC}", line], check=True)
            x = np.frombuffer(_pcm(p), "<i2")
            loud = np.flatnonzero(np.abs(x) > 300)
            x = x[loud[0]:loud[-1] + 1] if len(loud) else x
            utts.append((t / REC, (t + len(x)) / REC, line))
            gap = np.zeros(int(gaps[i % len(gaps)] * REC), np.int16)
            parts += [x, gap]
            t += len(x) + len(gap)
    return np.concatenate(parts), utts


def _pcm(path: Path) -> bytes:
    """say가 쓴 WAV의 data 청크 (헤더 길이가 일정하지 않다)."""
    b = path.read_bytes()
    pos = 12
    while pos + 8 <= len(b):
        cid, size = b[pos:pos + 4], struct.unpack("<I", b[pos + 4:pos + 8])[0]
        if cid == b"data":
            return b[pos + 8:pos + 8 + size]
        pos += 8 + size + (size & 1)
    raise ValueError(f"data 청크 없음: {path}")


def load_source(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(REC), "-f", "s16le", "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, "<i2")


class Writer(threading.Thread):
    """tractus-rec처럼 mic.wav를 쓰고 recording.json을 남긴다. 쓴 표본 수와 벽시계를 기록한다."""

    def __init__(self, rec_dir: Path, pcm: np.ndarray, speed: float):
        super().__init__(daemon=True)
        self.rec_dir, self.pcm, self.speed = rec_dir, pcm, speed
        self.log: list[tuple[int, float]] = []  # (쓴 표본 수, monotonic)

    def run(self) -> None:
        wav = self.rec_dir / "mic.wav"
        with wav.open("wb") as f:
            f.write(wav_header(0))
            f.flush()
            (self.rec_dir / "recording.json").write_text(json.dumps({"schema_version": 1, "started_at": "2026-10-07T10:00:00+09:00", "duration": None,
                                                                    "tracks": {"mic": "mic.wav"}, "marks": []}))
            t0, n, since = time.monotonic(), 0, 0
            self.log.append((0, t0))
            while n < len(self.pcm):
                due = t0 + (n + BLOCK) / REC / self.speed
                time.sleep(max(0.0, due - time.monotonic()))
                block = self.pcm[n:n + BLOCK]
                f.write(block.astype("<i2").tobytes())
                f.flush()
                n += len(block)
                since += len(block)
                self.log.append((n, time.monotonic()))
                if since >= HEADER_EVERY:
                    f.seek(4); f.write(struct.pack("<I", 36 + 2 * n)); f.seek(40); f.write(struct.pack("<I", 2 * n)); f.seek(0, 2)
                    f.flush()
                    since = 0

    def written_at(self, sec: float) -> float:
        """sec초 위치의 표본을 디스크에 쓴 벽시계 시각."""
        target = int(sec * REC)
        for n, t in self.log:
            if n > target:
                return t
        return self.log[-1][1]


def _sample_memory(pid: int, peak: dict, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
            m = re.search(r"Footprint:\s*([\d.]+)\s*(KB|MB|GB)", out)
            if m:
                peak["footprint"] = max(peak.get("footprint", 0), float(m.group(1)) * {"KB": 1e3, "MB": 1e6, "GB": 1e9}[m.group(2)])
            rss = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout.strip()
            if rss:
                peak["rss"] = max(peak.get("rss", 0), int(rss) * 1024)
        except (subprocess.SubprocessError, ValueError):
            pass
        stop.wait(0.25)


def gpu_util() -> float | None:
    out = subprocess.run(["ioreg", "-r", "-d", "1", "-c", "IOAccelerator"], capture_output=True, text=True).stdout
    m = re.search(r'"Device Utilization %"=(\d+)', out)
    return float(m.group(1)) if m else None


def _sample_gpu(samples: list, stop: threading.Event) -> None:
    while not stop.is_set():
        if (u := gpu_util()) is not None:
            samples.append(u)
        stop.wait(0.5)


def simulate(pcm: np.ndarray, speed: float = 1.0, tail_s: float = 1.5, tractus: str | None = None, speakers: bool = False) -> dict:
    """pcm(48k int16)을 녹음처럼 쓰면서 tractus live를 돌린다 → {events:[(monotonic, event)], writer, stop_exit_sec, peak, gpu, gpu_base}."""
    exe = tractus or str(Path(sys.executable).parent / "tractus")
    gpu_base = [u for _ in range(4) if (u := gpu_util()) is not None and not time.sleep(0.25)]
    with tempfile.TemporaryDirectory() as d:
        rec_dir = Path(d) / "rec"
        rec_dir.mkdir()
        writer = Writer(rec_dir, pcm, speed)
        proc = subprocess.Popen([exe, "live", "--recording", str(rec_dir), "--progress-json", *(["--speakers"] if speakers else [])], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, env={**os.environ, "TYPER_USE_RICH": "0"})
        writer.start()  # 앱처럼 녹음 시작과 같이 띄운다: 모델을 올리는 동안 쌓인 오디오를 따라잡아야 한다
        events: list[tuple[float, dict]] = []

        def read() -> None:
            for line in proc.stdout:
                events.append((time.monotonic(), json.loads(line)))

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        stop, peak, gpu = threading.Event(), {}, []
        samplers = [threading.Thread(target=_sample_memory, args=(proc.pid, peak, stop), daemon=True),
                    threading.Thread(target=_sample_gpu, args=(gpu, stop), daemon=True)]
        for s in samplers:
            s.start()
        writer.join()
        time.sleep(tail_s / speed)
        t_stop = time.monotonic()
        proc.stdin.write("stop\n")
        proc.stdin.flush()
        proc.wait(timeout=30)
        stop_exit = time.monotonic() - t_stop
        reader.join(timeout=5)
        stop.set()
    return {"events": events, "writer": writer, "stop_exit_sec": stop_exit, "exit_code": proc.returncode, "peak": peak, "gpu": gpu, "gpu_base": gpu_base}


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", "", text.lower())


def cer(ref: str, hyp: str) -> float:
    r, h = _norm(ref), _norm(hyp)
    prev = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        cur = [i]
        for j, hc in enumerate(h, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1] / max(1, len(r))


def finals(events: list[tuple[float, dict]]) -> list[tuple[float, dict]]:
    return [(t, e) for t, e in events if e.get("event") == "live" and e.get("kind") == "final"]


def latencies(sim: dict, utts: list[tuple[float, float, str]]) -> list[float]:
    """발화마다 끝을 덮는 첫 final(끝 ≥ 발화 끝 − 0.15초)이 오기까지 걸린 시간."""
    out = []
    fs = finals(sim["events"])
    for s, e, _ in utts:
        hit = next((t for t, f in fs if f["start"] < e and f["end"] >= e - 0.15), None)
        if hit is not None:
            out.append(hit - sim["writer"].written_at(e))
    return out


def processing(sim: dict) -> list[float]:
    """final마다 '확정 시점(0.5초 무음이 다 쓰인 순간)'부터 이벤트까지. 설계상 대기를 뺀 처리 지연 (ASR·폴링·VAD 밀림)."""
    from tractus.live import FRAME, SILENCE_FRAMES, SR, TAIL_FRAMES

    wait = (SILENCE_FRAMES - TAIL_FRAMES) * FRAME / SR
    return [t - sim["writer"].written_at(f["end"] + wait) for t, f in finals(sim["events"])]


def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, round(q * (len(xs) - 1)))], 3)


def summarize(sim: dict, utts: list | None, reference: str | None, duration: float, speed: float, source: str, speakers: bool = False) -> dict:
    events = [e for _, e in sim["events"]]
    done = next((e for e in events if e.get("event") == "done"), {})
    stats = done.get("stats", {})
    lat = latencies(sim, utts) if utts else []
    proc = processing(sim)
    hyp = " ".join(e["text"] for _, e in finals(sim["events"]))
    t_live = next((t for t, e in sim["events"] if e.get("stage") == "live"), None)
    t0 = sim["writer"].log[0][1]
    return {
        "date": date.today().isoformat(), "source": source, "speed": speed, "duration_sec": round(duration, 1),
        "model": "mlx-community/Qwen3-ASR-0.6B-8bit", "vad": "silero-vad-v6 feed()", "speakers": "Nemotron-3-Diarization streaming low" if speakers else None,
        "utterances": len(utts) if utts else None, "finals": stats.get("finals"), "partials": stats.get("partials"), "skipped_partials": stats.get("skipped_partials"),
        "latency_n": len(lat), "latency_p50": pct(lat, 0.5), "latency_p95": pct(lat, 0.95), "latency_max": pct(lat, 1.0),
        "processing_p50": pct(proc, 0.5), "processing_p95": pct(proc, 0.95),
        "load_sec": round(t_live - t0, 2) if t_live else None,
        "asr_rtf": stats.get("asr_rtf"), "peak_mlx_gb": stats.get("peak_memory_gb"),
        "peak_footprint_gb": round(sim["peak"]["footprint"] / 1e9, 2) if "footprint" in sim["peak"] else None,
        "peak_rss_gb": round(sim["peak"]["rss"] / 1e9, 2) if "rss" in sim["peak"] else None,
        "gpu_util_mean": round(statistics.mean(sim["gpu"]), 1) if sim["gpu"] else None,
        "gpu_util_baseline": round(statistics.mean(sim["gpu_base"]), 1) if sim["gpu_base"] else None,
        "gpu_util_delta": round(statistics.mean(sim["gpu"]) - statistics.mean(sim["gpu_base"]), 1) if sim["gpu"] and sim["gpu_base"] else None,
        "cer": round(cer(reference, hyp), 4) if reference else None,
        "speakers_seen": sorted({e["speaker"] for e in events if e.get("event") == "live" and e.get("speaker")}),
        "warnings": sorted({e["code"] for e in events if e.get("event") == "warning"}),
        "stop_exit_sec": round(sim["stop_exit_sec"], 2), "exit_code": sim["exit_code"],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, help="로컬 오디오 (기본: say 가상 대화)")
    ap.add_argument("--reference", type=Path, help="--source의 참조 전사 (CER용, 출력하지 않음)")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--speakers", action="store_true", help="tractus live --speakers (실시간 화자 라벨)")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    if args.source:
        pcm, utts, source = load_source(args.source), None, "local"
        reference = args.reference.read_text(encoding="utf-8") if args.reference else None
    else:
        pcm, utts = synth()
        reference, source = " ".join(u[2] for u in utts), "synthetic"
    duration = len(pcm) / REC
    print(f"{source}: {duration:.1f}초, 속도 {args.speed}x", file=sys.stderr)
    summary = summarize(simulate(pcm, args.speed, speakers=args.speakers), utts, reference, duration, args.speed, source, args.speakers)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
