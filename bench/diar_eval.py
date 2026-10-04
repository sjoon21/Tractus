"""화자 분리(v3.9) 영향 평가: AI Hub 4세션을 실제 `tractus transcribe`로 --no-diarize / 화자 분리 두 번 전사해
CER(철자 기준)·RTF·화자 분리 부담을 비교하고, 화자 분리 쪽 세그먼트 화자로 DER용 hyp RTTM을 만든다.

!!! AI Hub 데이터는 반출 금지다. 지표만 출력한다. OUT은 저장소 밖에 두고, 끝나면 지운다.

    cd bench && uv run python diar_eval.py OUT            # 전사(이미 있으면 건너뜀) + 채점
    # DER: OUT/hyp/*.rttm 을 score_der.py(pyannote 환경)로 채점

오디오는 Phase 0과 같게 data.aihub()가 '(())' 구간을 무음 처리한 16kHz wav를 OUT/wav/<세션>.wav로 써서 쓴다.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import soundfile as sf

import score
from data import SR, aihub

ROOT = Path(__file__).resolve().parent.parent
CONDS = {"nodiar": ["--no-diarize"], "diar": []}


def run_cli(wav: Path, home: Path, extra: list[str]) -> dict:
    """stage 이벤트 시각(초, 시작 기준)을 돌려준다."""
    env = {**os.environ, "TRACTUS_HOME": str(home), "TRACTUS_MODELS_DIR": str(ROOT / "models")}
    cmd = ["uv", "run", "--project", str(ROOT), "tractus", "transcribe", str(wav), "--track", "standard", "--progress-json", *extra]
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


def main():
    out = Path(sys.argv[1]).resolve()
    if ROOT in out.parents:
        sys.exit("AI Hub 산출물을 저장소 안에 두지 마세요")
    (out / "wav").mkdir(parents=True, exist_ok=True)
    (out / "hyp").mkdir(exist_ok=True)
    timing_path = out / "timings.json"
    timings = json.loads(timing_path.read_text()) if timing_path.exists() else {}
    refs, durs = {}, {}
    for s in aihub():
        refs[s.id], durs[s.id] = s.ref, len(s.audio) / SR
        wav = out / "wav" / f"{s.id}.wav"
        if not wav.exists():
            sf.write(wav, s.audio, SR, subtype="PCM_16")
    for cond, extra in CONDS.items():  # 순서대로 돌린다: 동시에 돌리면 RTF가 섞인다
        for sid in refs:
            key = f"{cond}/{sid}"
            if key not in timings:
                timings[key] = run_cli(out / "wav" / f"{sid}.wav", out / f"home-{cond}", extra)
                timing_path.write_text(json.dumps(timings, indent=1))

    rows, hyps = [], {c: [] for c in CONDS}
    for sid in refs:
        r = {"session": sid, "min": round(durs[sid] / 60, 1)}
        for cond in CONDS:
            t, st = transcript(out / f"home-{cond}", sid), timings[f"{cond}/{sid}"]
            hyp = " ".join(seg["text"] for seg in t["segments"] if seg["text"])
            hyps[cond].append(hyp)
            r[f"cer_{cond}"] = round(score.cer([refs[sid]], [hyp]), 2)
            r[f"rtf_asr_{cond}"] = round((st["index"] - st["transcribe"]) / durs[sid], 4)
            r[f"pre_asr_s_{cond}"] = round(st["encode"] - st["vad"], 1)  # VAD + (화자 분리 로드·실행·해제)
            r[f"segments_{cond}"] = len(t["segments"])
            r[f"short_lt2s_{cond}"] = sum(s["end"] - s["start"] < 2.0 for s in t["segments"])
            if cond == "diar":
                r["n_spk"] = len(t.get("speakers") or {})
                write_rttm(t, sid, out / "hyp" / f"{sid}.rttm")
        r["diar_overhead_s"] = round(r["pre_asr_s_diar"] - r["pre_asr_s_nodiar"], 1)
        rows.append(r)
    total = {f"cer_{c}": round(score.cer(list(refs.values()), hyps[c]), 2) for c in CONDS}
    total["rtf_asr"] = {c: round(sum(r[f"rtf_asr_{c}"] * r["min"] for r in rows) / sum(r["min"] for r in rows), 4) for c in CONDS}
    total["diar_overhead_s"] = round(sum(r["diar_overhead_s"] for r in rows), 1)
    total["delta_cer_pp"] = round(total["cer_diar"] - total["cer_nodiar"], 2)
    for r in rows:
        print(json.dumps(r))
    print(json.dumps(total))
    (out / "asr_metrics.json").write_text(json.dumps({"sessions": rows, "total": total}, indent=1))


if __name__ == "__main__":
    main()
