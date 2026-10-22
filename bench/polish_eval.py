"""대화 내용 다듬기(tractus.polish) 측정.

    uv run python polish_eval.py synth --out <폴더> [--provider P --model M]
        가상 회의(tests/fixtures/eval/meetings)의 대본을 macOS `say`로 읽혀 제품과 같은 `tractus transcribe`로 변환하고,
        다듬기 제안 전·후를 대본과 비교한다: CER, 제안마다 나아짐·나빠짐·같음. 가상 회의만 원격 AI에 보낸다.
    uv run python polish_eval.py notes --home ~/Tractus --out <폴더> [--provider P --model M]
        실제 노트(소유자 요청, 2026-10-22)에 제안만 만든다. 정답이 없어 개수·종류만 찍고, 검토표(<out>/review.md)를 만든다.
        노트 폴더에는 아무것도 쓰지 않는다. AI Hub 데이터 홈에는 쓰지 않는다.
"""

import argparse
import collections
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from rapidfuzz.distance import Levenshtein

import score

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
from tractus import polish  # noqa: E402
from tractus.llm import make_client, resolve_provider  # noqa: E402
from tractus.store import load_glossary  # noqa: E402

SR = 16000
VOICES = ["Yuna", "Grandpa (한국어(한국))"]  # 엔진이 다른 두 음성 (CLAUDE.md: 같은 엔진 음성은 한국어가 비거나 섞인다)
GAP = 0.6


def synth_meeting(t: dict, work: Path) -> tuple[Path, list[tuple[float, float, str]]]:
    """대본 문장마다 음성을 번갈아 읽혀 이어 붙인다 → (wav, [(시작, 끝, 대본)])"""
    parts, utts, at = [], [], 0.0
    for i, s in enumerate(t["segments"]):
        aiff, wav = work / f"{i}.aiff", work / f"{i}.wav"
        subprocess.run(["say", "-v", VOICES[i % 2], "-o", str(aiff), s["text"]], check=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(aiff), "-ar", str(SR), "-ac", "1", str(wav)], check=True)
        a, _ = sf.read(wav, dtype="float32")
        parts += [a, np.zeros(int(GAP * SR), dtype="float32")]
        utts.append((at, at + len(a) / SR, s["text"]))
        at += len(a) / SR + GAP
    out = work / "meeting.wav"
    sf.write(out, np.concatenate(parts), SR)
    return out, utts


def transcribe(wav: Path, title: str, home: Path) -> dict:
    env = {**os.environ, "TRACTUS_HOME": str(home)}
    subprocess.run(["uv", "run", "tractus", "transcribe", str(wav), "--title", title, "--track", "standard", "--no-diarize", "--no-align"],
                   cwd=ROOT, env=env, check=True, capture_output=True)
    d = max((home / "meetings").iterdir(), key=lambda p: p.stat().st_mtime)
    return json.loads((d / "transcript.json").read_text(encoding="utf-8"))


def refs_for(segs: list[dict], utts: list[tuple[float, float, str]]) -> dict[str, str]:
    """대본 문장을 가장 많이 겹치는 변환 문장에 붙인다 → {세그먼트 ID: 대본}"""
    out = collections.defaultdict(list)
    for a, b, text in utts:
        best = max(segs, key=lambda s: min(b, s["end"]) - max(a, s["start"]))
        out[best["id"]].append(text)
    return {k: " ".join(v) for k, v in out.items()}


def synth(args, p, m) -> None:
    client = make_client(p)
    total = collections.Counter()
    refs_all, before_all, after_all = [], [], []  # 회의마다 이어 붙인 문자열 (회의별 CER과 같은 방식)
    for d in sorted((ROOT / "tests/fixtures/eval/meetings").iterdir()):
        src = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
        work = Path(tempfile.mkdtemp(dir=args.out))
        wav, utts = synth_meeting(src, work)
        t = transcribe(wav, src["title"], work / "home")
        ref = refs_for(t["segments"], utts)
        t0 = time.perf_counter()
        dropped: dict = {}
        sug = polish.suggest(client, p, m, t, dropped=dropped)
        total.update({f"dropped_{k}": v for k, v in dropped.items()})
        took = time.perf_counter() - t0
        fix = {x["id"]: x["text"] for x in sug}
        verdict = collections.Counter()
        for s in t["segments"]:
            r = score.norm_ko(ref.get(s["id"], ""))
            before, after = s["text"], fix.get(s["id"], s["text"])
            if s["id"] in fix:
                d0, d1 = Levenshtein.distance(r, score.norm_ko(before)), Levenshtein.distance(r, score.norm_ko(after))
                verdict["better" if d1 < d0 else "worse" if d1 > d0 else "same"] += 1
        refs_all.append(" ".join(ref.values()))
        before_all.append(" ".join(s["text"] for s in t["segments"]))
        after_all.append(" ".join(fix.get(s["id"], s["text"]) for s in t["segments"]))
        total.update(verdict)
        total["segments"] += len(t["segments"])
        total["suggestions"] += len(sug)
        print(json.dumps({"meeting": src["title"], "segments": len(t["segments"]), "suggestions": len(sug), **verdict,
                          "cer_before": round(score.cer([" ".join(ref.values())], [" ".join(s["text"] for s in t["segments"])]), 2),
                          "cer_after": round(score.cer([" ".join(ref.values())], [" ".join(fix.get(s["id"], s["text"]) for s in t["segments"])]), 2),
                          "llm_s": round(took, 1)}, ensure_ascii=False))
        with (Path(args.out) / "synth_review.md").open("a", encoding="utf-8") as f:  # 가상 회의라 문장을 남겨도 된다
            f.write(f"\n## {src['title']}\n")
            for x in sug:
                f.write(f"- `{x['id']}` [{x['kind']}{' ' + ','.join(x['flags']) if x['flags'] else ''}]\n  - 대본: {ref.get(x['id'], '')}\n  - 변환: {x['before']}\n  - 제안: {x['text']}\n")
    print(json.dumps({"total": dict(total), "cer_before": round(score.cer(refs_all, before_all), 2), "cer_after": round(score.cer(refs_all, after_all), 2)}, ensure_ascii=False))


def notes(args, p, m) -> None:
    client = make_client(p)
    home = Path(args.home).expanduser()
    glossary = load_glossary(home / "glossary.md")
    review = Path(args.out) / "review.md"
    review.write_text("# 다듬기 제안 검토표 (실제 노트, 로컬 전용)\n", encoding="utf-8")
    for tp in sorted((home / "meetings").glob("*/transcript.json")):
        t = json.loads(tp.read_text(encoding="utf-8"))
        if t.get("kind") == "memo" or t.get("state") == "recorded" or t.get("sample") or len(t.get("segments") or []) < 20:
            continue
        t0 = time.perf_counter()
        dropped: dict = {}
        sug = polish.suggest(client, p, m, t, glossary, dropped=dropped)
        kinds = collections.Counter(x["kind"] for x in sug)
        print(json.dumps({"note": tp.parent.name[:10], "segments": len(t["segments"]), "chars": sum(len(s["text"]) for s in t["segments"]),
                          "suggestions": len(sug), "kinds": dict(kinds), "number_flag": sum("number" in x["flags"] for x in sug), "dropped": dropped,
                          "llm_s": round(time.perf_counter() - t0, 1)}, ensure_ascii=False))
        with review.open("a", encoding="utf-8") as f:
            f.write(f"\n## {t['title']} ({tp.parent.name[:10]}, 제안 {len(sug)}개 / 문장 {len(t['segments'])}개)\n")
            for x in sug:
                mm, ss = divmod(int(x["start"]), 60)
                f.write(f"- `{mm:02d}:{ss:02d}` [{x['kind']}{' ' + ','.join(x['flags']) if x['flags'] else ''}]\n  - 지금: {x['before']}\n  - 제안: {x['text']}\n")
    print(f"검토표: {review}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["synth", "notes"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--home", default="~/Tractus")
    ap.add_argument("--provider")
    ap.add_argument("--model")
    args = ap.parse_args()
    Path(args.out).mkdir(parents=True, exist_ok=True)
    if args.mode == "notes" and "aihub" in str(Path(args.home).expanduser()).lower():
        raise SystemExit("AI Hub 데이터 홈은 원격 AI에 보내지 않는다")
    p, m = resolve_provider(args.provider, args.model)
    (synth if args.mode == "synth" else notes)(args, p, m)


if __name__ == "__main__":
    shutil.which("say") or sys.exit("macOS say가 필요합니다")
    main()
