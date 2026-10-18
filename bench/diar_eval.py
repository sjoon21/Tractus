"""화자 분리 평가. 두 가지를 잰다.

der — 화자 분리만 (v3.15): 회의 전체를 제품의 화자 분리기(diarize.load_diarizer / load_fluid)로 돌려 DER·놓침·오경보·혼동·
      화자 수 오차·RTF를 잰다. 저장소 루트에서 제품 환경으로 돌린다. 지표만 bench/results/diar_summary.json에 합쳐 쓴다.

    uv run python bench/diar_eval.py der --engine nemotron fluid                      # AI Hub 4세션 (로컬 전용)
    uv run python bench/diar_eval.py der --engine fluid --sessions DGBAH21000190 DGBAH21000195
    uv run python bench/diar_eval.py der --engine nemotron fluid --set DIR            # 가상 음성 (diar_synth.py DIR로 만듦): DIR/<id>.wav + DIR/ref/<id>.rttm(.uem)
    # --rttm OUT: 가설 RTTM을 저장소 밖 OUT/<set>-<engine>/에 쓴다 (pyannote score_der.py로 교차 확인용)

asr — 화자 분리가 ASR에 주는 영향 (v3.9): AI Hub 4세션을 실제 `tractus transcribe`로 --no-diarize / 화자 분리 두 번 전사해
      CER(철자 기준)·RTF·화자 분리 부담을 비교하고, 화자 분리 쪽 세그먼트 화자로 DER용 hyp RTTM을 만든다.

    cd bench && uv run python diar_eval.py asr OUT [--engine fluid]   # 전사(이미 있으면 건너뜀) + 채점

!!! AI Hub 데이터는 반출 금지다. 지표만 출력한다. OUT은 저장소 밖에 두고, 끝나면 지운다.

DER 채점 (score_der.py와 같은 정의): 10ms 프레임, 참조 turn 경계 ±0.25초(collar)는 빼고, 겹침도 센다(skip_overlap=False).
참조 화자 ↔ 가설 화자는 헝가리안으로 1:1 대응. AI Hub 참조는 '(())' 발화와 화자 '?' 발화를 RTTM·UEM에서 뺀다
(가설이 그 구간에서 득도 실도 보지 않는다). AI Hub 라벨은 회의 전체를 빈틈없이 덮어 놓침·오경보는 의미가 약하다. 혼동을 본다.
"""

import argparse
import glob
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
DATA = ROOT / "data/aihub-meeting"
SUMMARY = Path(__file__).resolve().parent / "results/diar_summary.json"
CONDS = {"nodiar": ["--no-diarize"], "diar": []}
SR = 16000
FRAME = 0.01
COLLAR = 0.25  # ± 초 (NIST md-eval식. pyannote.metrics의 collar=0.5와 같다)
EXCLUDE_FORM, UNKNOWN_SPK = "(())", "?"


# ── der: 채점 ──────────────────────────────────────────────────────────


def _grid(turns: list, n: int, labels: list[str]) -> np.ndarray:
    m = np.zeros((n, max(len(labels), 1)), bool)
    for s, e, k in turns:
        m[round(s / FRAME):round(e / FRAME), labels.index(k)] = True
    return m[:, :len(labels)]


def score(ref: list, hyp: list, uem: list, duration: float) -> dict:
    """ref/hyp: [(시작, 끝, 화자)], uem: 채점 구간 [(시작, 끝)] → 프레임 수 {total, miss, fa, conf} + 화자 수."""
    n = int(np.ceil(duration / FRAME)) + 1
    rl, hl = sorted({k for *_, k in ref}), sorted({k for *_, k in hyp})
    scored = np.zeros(n, bool)
    for a, b in uem:
        scored[round(a / FRAME):round(b / FRAME)] = True
    c = round(COLLAR / FRAME)
    for s, e, _ in ref:
        for t in (s, e):
            i = round(t / FRAME)
            scored[max(0, i - c):i + c] = False
    r, h = _grid(ref, n, rl)[scored], _grid(hyp, n, hl)[scored]
    nr, nh = r.sum(1), h.sum(1)
    co = r.T.astype(np.int64) @ h.astype(np.int64)  # [참조 화자, 가설 화자] 함께 말한 프레임
    rows, cols = linear_sum_assignment(-co) if co.size else ([], [])
    correct = int(co[rows, cols].sum()) if co.size else 0
    return {"total": int(nr.sum()), "miss": int(np.maximum(nr - nh, 0).sum()), "fa": int(np.maximum(nh - nr, 0).sum()),
            "conf": int(np.minimum(nr, nh).sum()) - correct, "n_ref": len(rl), "n_hyp": len(hl)}


def rates(f: dict) -> dict:
    t = f["total"] or 1
    pct = lambda x: round(100 * x / t, 2)  # noqa: E731
    return {"der": pct(f["miss"] + f["fa"] + f["conf"]), "miss": pct(f["miss"]), "fa": pct(f["fa"]), "conf": pct(f["conf"])}


# ── der: 데이터 ────────────────────────────────────────────────────────


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (SR, 1, 2), path.name
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768


def _subtract(span: tuple[float, float], holes: list) -> list:
    out, cur = [], span[0]
    for a, b in sorted(holes):
        if a > cur:
            out.append((cur, min(a, span[1])))
        cur = max(cur, b)
    if cur < span[1]:
        out.append((cur, span[1]))
    return [(a, b) for a, b in out if b > a]


def aihub_sessions(only: list[str] | None):
    """(세션 ID, wav 경로, 참조 turn, UEM). 발화 텍스트는 '(())'인지만 본다."""
    for jf in sorted(glob.glob(str(DATA / "라벨링데이터/*/*/*/*.json"))):
        d = json.loads(Path(jf).read_text(encoding="utf-8"))
        sid = d["metadata"]["title"]
        if only and sid not in only:
            continue
        wav = next((DATA / "원천데이터").rglob(f"{sid}.wav"))
        with wave.open(str(wav)) as w:
            dur = w.getnframes() / w.getframerate()
        ref, holes = [], []
        for u in d["utterance"]:
            s, e = float(u["start"]), float(u["end"])
            if not e > s:
                continue
            if u["form"].strip() == EXCLUDE_FORM or u["speaker_id"] == UNKNOWN_SPK:
                holes.append((s, e))
            else:
                ref.append((s, e, u["speaker_id"]))
        yield sid, wav, ref, _subtract((0.0, dur), holes)


def _rttm(path: Path) -> list:
    return [(float(f[3]), float(f[3]) + float(f[4]), f[7]) for f in (line.split() for line in path.read_text().splitlines())
            if f and f[0] == "SPEAKER" and float(f[4]) > 0]


def dir_sessions(d: Path, only: list[str] | None):
    """가상 음성 등: d/<id>.wav, d/ref/<id>.rttm, (있으면) d/ref/<id>.uem."""
    for wav in sorted(d.glob("*.wav")):
        sid = wav.stem
        if (only and sid not in only) or not (d / "ref" / f"{sid}.rttm").exists():
            continue
        uem_path = d / "ref" / f"{sid}.uem"
        with wave.open(str(wav)) as w:
            dur = w.getnframes() / w.getframerate()
        uem = [(float(f[2]), float(f[3])) for f in (line.split() for line in uem_path.read_text().splitlines()) if f] if uem_path.exists() else [(0.0, dur)]
        yield sid, wav, _rttm(d / "ref" / f"{sid}.rttm"), uem


# ── der: 실행 ──────────────────────────────────────────────────────────


def load_engine(engine: str):
    from tractus.diarize import fluid_hint, load_diarizer, load_fluid

    d = (load_diarizer if engine == "nemotron" else load_fluid)(ROOT / "models")
    if d is None:
        sys.exit(f"{engine} 화자 분리기가 없습니다" + (f":\n{fluid_hint(ROOT / 'models')}" if engine == "fluid" else ""))
    return d


def run_der(args) -> None:
    import mlx.core as mx

    if args.rttm and ROOT in args.rttm.resolve().parents:
        sys.exit("가설 RTTM을 저장소 안에 두지 마세요 (AI Hub 산출물)")
    set_name = args.set.name if args.set else "aihub"
    sessions = list(dir_sessions(args.set, args.sessions) if args.set else aihub_sessions(args.sessions))
    if not sessions:
        sys.exit("채점할 세션이 없습니다")
    summary = json.loads(SUMMARY.read_text()) if SUMMARY.exists() else {}
    for engine in args.engine:  # 차례로 돌린다: 동시에 돌리면 RTF가 섞인다
        rows, acc, info = [], {"total": 0, "miss": 0, "fa": 0, "conf": 0}, None
        for sid, wav, ref, uem in sessions:
            pcm = read_wav(wav)
            t0 = time.perf_counter()
            diarizer = load_engine(engine)  # 불러오기도 RTF에 넣는다 (fluid는 헬퍼가 매번 모델을 연다)
            hyp = diarizer.diarize(pcm, args.max_speakers)
            sec = time.perf_counter() - t0
            info = diarizer.info
            del diarizer
            mx.clear_cache()
            dur = len(pcm) / SR
            f = score(ref, hyp, uem, dur)
            acc = {k: acc[k] + f[k] for k in acc}
            row = {"session": sid, "min": round(dur / 60, 1), "n_ref": f["n_ref"], "n_hyp": f["n_hyp"], "spk_err": f["n_hyp"] - f["n_ref"],
                   **rates(f), "sec": round(sec, 1), "rtf": round(sec / dur, 4)}
            rows.append(row)
            print(json.dumps({"engine": engine, **row}), flush=True)
            if args.rttm:
                out = args.rttm / f"{set_name}-{engine}"
                out.mkdir(parents=True, exist_ok=True)
                (out / f"{sid}.rttm").write_text("".join(f"SPEAKER {sid} 1 {s:.3f} {e - s:.3f} <NA> <NA> {k} <NA> <NA>\n" for s, e, k in hyp))
        mins = sum(r["min"] for r in rows)
        total = {**rates(acc), "spk_count_mae": round(sum(abs(r["spk_err"]) for r in rows) / len(rows), 2),
                 "rtf": round(sum(r["sec"] for r in rows) / (mins * 60), 4), "audio_min": round(mins, 1)}
        print(json.dumps({"engine": engine, "total": total}), flush=True)
        key = f"{set_name}/{engine}" + (f"/max{args.max_speakers}" if args.max_speakers else "")
        prev = {r["session"]: r for r in summary.get(key, {}).get("sessions", [])}  # 일부 세션만 다시 돌려도 나머지는 남긴다
        merged = sorted({**prev, **{r["session"]: r for r in rows}}.values(), key=lambda r: r["session"])
        summary = {**summary, key: {"model": info["model"], "revision": info["revision"], "params": info["params"],
                                    "collar_s": COLLAR, "frame_s": FRAME, "sessions": merged, "total_last_run": total}}
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=1) + "\n")
    print(f"→ {SUMMARY.relative_to(ROOT)}")


# ── asr: 화자 분리가 ASR에 주는 영향 (bench 환경) ──────────────────────────


def run_cli(wav: Path, home: Path, extra: list[str]) -> dict:
    """stage 이벤트 시각(초, 시작 기준)을 돌려준다."""
    env = {**os.environ, "TRACTUS_HOME": str(home), "TRACTUS_MODELS_DIR": str(ROOT / "models")}
    # 단어 싱크는 CER과 무관하고 시간만 든다
    cmd = ["uv", "run", "--project", str(ROOT), "tractus", "transcribe", str(wav), "--track", "standard", "--no-align", "--progress-json", *extra]
    t0, stages = time.perf_counter(), {}
    with subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) as p:
        for line in p.stdout:
            ev = json.loads(line)
            if ev["event"] in ("stage", "done", "warning", "error"):
                stages.setdefault(ev.get("stage", ev["event"]), time.perf_counter() - t0)
    if p.returncode or "done" not in stages:
        sys.exit(f"transcribe 실패: {wav.name} ({p.returncode})")
    return stages


def transcript(home: Path, sid: str) -> dict:
    return next(t for p in (home / "meetings").glob("*/transcript.json")
                if Path((t := json.loads(p.read_text(encoding="utf-8")))["audio"]["source"]).stem == sid)


def write_rttm(t: dict, sid: str, path: Path) -> None:
    lines = [f"SPEAKER {sid} 1 {s['start']:.3f} {s['end'] - s['start']:.3f} <NA> <NA> {s['speaker']} <NA> <NA>"
             for s in t["segments"] if s.get("speaker")]
    path.write_text("\n".join(lines) + "\n")


def run_asr(args) -> None:
    import soundfile as sf

    import score as asr_score
    from data import aihub

    out = args.out.resolve()
    if ROOT in out.parents:
        sys.exit("AI Hub 산출물을 저장소 안에 두지 마세요")
    conds = {**CONDS, "diar": ["--diarizer", args.engine]}
    home = {"nodiar": "home-nodiar", "diar": "home-diar" if args.engine == "nemotron" else f"home-diar-{args.engine}"}
    hyp_dir = out / ("hyp" if args.engine == "nemotron" else f"hyp-{args.engine}")
    (out / "wav").mkdir(parents=True, exist_ok=True)
    hyp_dir.mkdir(exist_ok=True)
    timing_path = out / "timings.json"
    timings = json.loads(timing_path.read_text()) if timing_path.exists() else {}
    refs, durs = {}, {}
    for s in aihub():
        refs[s.id], durs[s.id] = s.ref, len(s.audio) / SR
        wav = out / "wav" / f"{s.id}.wav"
        if not wav.exists():
            sf.write(wav, s.audio, SR, subtype="PCM_16")
    for cond, extra in conds.items():  # 순서대로 돌린다: 동시에 돌리면 RTF가 섞인다
        for sid in refs:
            key = f"{home[cond]}/{sid}"
            if key not in timings:
                timings[key] = run_cli(out / "wav" / f"{sid}.wav", out / home[cond], extra)
                timing_path.write_text(json.dumps(timings, indent=1))

    rows, hyps = [], {c: [] for c in conds}
    for sid in refs:
        r = {"session": sid, "min": round(durs[sid] / 60, 1)}
        for cond in conds:
            t, st = transcript(out / home[cond], sid), timings[f"{home[cond]}/{sid}"]
            hyp = " ".join(seg["text"] for seg in t["segments"] if seg["text"])
            hyps[cond].append(hyp)
            r[f"cer_{cond}"] = round(asr_score.cer([refs[sid]], [hyp]), 2)
            r[f"wer_{cond}"] = round(asr_score.wer_ko([refs[sid]], [hyp]), 2)
            r[f"cer_nofill_{cond}"] = round(asr_score.cer_nofill([refs[sid]], [hyp]), 2)
            r[f"rtf_asr_{cond}"] = round((st["index"] - st["transcribe"]) / durs[sid], 4)
            r[f"pre_asr_s_{cond}"] = round(st["encode"] - st["vad"], 1)  # VAD + (화자 분리 로드·실행·해제)
            r[f"segments_{cond}"] = len(t["segments"])
            r[f"short_lt2s_{cond}"] = sum(s["end"] - s["start"] < 2.0 for s in t["segments"])
            if cond == "diar":
                r["n_spk"] = len(t.get("speakers") or {})
                r["engine"] = (t.get("diarization") or {}).get("engine")
                write_rttm(t, sid, hyp_dir / f"{sid}.rttm")
        r["diar_overhead_s"] = round(r["pre_asr_s_diar"] - r["pre_asr_s_nodiar"], 1)
        rows.append(r)
    total = {f"{m}_{c}": round(fn(list(refs.values()), hyps[c]), 2) for c in conds for m, fn in (("cer", asr_score.cer), ("wer", asr_score.wer_ko), ("cer_nofill", asr_score.cer_nofill))}
    total["rtf_asr"] = {c: round(sum(r[f"rtf_asr_{c}"] * r["min"] for r in rows) / sum(r["min"] for r in rows), 4) for c in conds}
    total["diar_overhead_s"] = round(sum(r["diar_overhead_s"] for r in rows), 1)
    total["delta_cer_pp"] = round(total["cer_diar"] - total["cer_nodiar"], 2)
    for r in rows:
        print(json.dumps(r))
    print(json.dumps(total))
    (out / f"asr_metrics-{args.engine}.json").write_text(json.dumps({"sessions": rows, "total": total}, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="mode", required=True)
    d = sub.add_parser("der", help="화자 분리만: DER·혼동·화자 수·RTF")
    d.add_argument("--engine", nargs="+", choices=["nemotron", "fluid"], default=["nemotron", "fluid"])
    d.add_argument("--set", type=Path, help="가상 음성 폴더 (DIR/<id>.wav + DIR/ref/<id>.rttm). 생략하면 AI Hub")
    d.add_argument("--sessions", nargs="+", help="이 세션만 (예: DGBAH21000190)")
    d.add_argument("--max-speakers", type=int)
    d.add_argument("--rttm", type=Path, help="가설 RTTM을 쓸 폴더 (저장소 밖)")
    a = sub.add_parser("asr", help="화자 분리가 ASR CER·RTF에 주는 영향 (cd bench에서)")
    a.add_argument("out", type=Path)
    a.add_argument("--engine", choices=["nemotron", "fluid"], default="nemotron")
    args = ap.parse_args()
    run_der(args) if args.mode == "der" else run_asr(args)


if __name__ == "__main__":
    main()
