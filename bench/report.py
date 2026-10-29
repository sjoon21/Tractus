"""results/summary.jsonl을 Markdown 표로 정리한다. 같은 조건을 다시 돌렸으면 마지막 결과를 쓴다.

    python rescore.py && python report.py > results/REPORT.md
"""

import json
from pathlib import Path

ROWS = [json.loads(line) for line in (Path(__file__).resolve().parent / "results/summary.jsonl").open()]
MODELS = ["qwen3-1.7b", "qwen3-0.6b", "whisper-turbo", "nemotron-0.6b", "lfm3-audio-2b"]


def pick(model: str, dataset: str, lang: str = "fixed", chunk: float | None = 30.0, glossary: bool = False,
         segments: str = "vad") -> dict | None:
    hits = [
        r for r in ROWS
        if r["model"] == model and r["dataset"] == dataset and r["lang"] == lang and r["glossary"] == glossary
        and (dataset != "aihub" or r["chunk_s"] == chunk) and r.get("segments", "vad") == segments
    ]
    return hits[-1] if hits else None


def fmt(r: dict | None, fn, spec: str = ".2f") -> str:
    return "—" if r is None else format(fn(r), spec)


def pair(model: str, dataset: str, fn, spec: str = ".2f") -> str:
    """언어 고정 / 자동 두 조건을 'a / b'로 보여준다."""
    return " / ".join(fmt(pick(model, dataset, lang), fn, spec) for lang in ("fixed", "auto"))


def main():
    print("## E1 기본 비교\n")
    print("한 칸에 두 값이 있으면 `언어 고정 / 자동 감지`다. 낮을수록 좋다.\n")
    print("lfm3-audio-2b 행만 mlx-audio 0.6.3(`uv run --no-default-groups --group lfm3`)에서 쟀다. 다른 행은 앱과 같은 기본 환경(mlx-audio 0.5.7)이다.\n")
    print("| 모델 | FLEURS-ko CER | HiKE MER | HiKE PIER | HiKE MER 중앙값 | HiKE 반복 루프 | AI Hub CER | AMI WER |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for m in MODELS:
        hike = lambda key: pair(m, "hike", lambda r: r["hike"]["all"][key], ".1f" if key != "loops" else "d")  # noqa: E731
        print(
            f"| {m} | {fmt(pick(m, 'fleurs'), lambda r: r['cer'])} | {hike('mer')} | {hike('pier')} | {hike('mer_median')} "
            f"| {hike('loops')} | {pair(m, 'aihub', lambda r: r['cer'])} | {fmt(pick(m, 'ami'), lambda r: r['wer'])} |"
        )

    print("\n## 속도·메모리 (언어 고정)\n")
    print("| 모델 | RTF AI Hub | RTF HiKE | RTF AMI | 1시간 처리 시간 (AI Hub 기준) | 피크 메모리 MLX | 최대 RSS |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for m in MODELS:
        rs = [r for r in (pick(m, d) for d in ("fleurs", "hike", "aihub", "ami")) if r]
        a = pick(m, "aihub")
        print(
            f"| {m} | {fmt(a, lambda r: r['rtf'], '.3f')} | {fmt(pick(m, 'hike'), lambda r: r['rtf'], '.3f')} "
            f"| {fmt(pick(m, 'ami'), lambda r: r['rtf'], '.3f')} | {fmt(a, lambda r: r['rtf'] * 60, '.1f')}분 "
            f"| {max(r['peak_mlx_gb'] for r in rs):.2f} GB | {max(r['max_rss_gb'] for r in rs):.2f} GB |"
        )

    print("\n## HiKE 코드스위칭 수준별 MER / PIER\n")
    print("| 모델 | 언어 | 단어 | 구 | 문장 |")
    print("| --- | --- | --- | --- | --- |")
    for m in MODELS:
        for lang in ("fixed", "auto"):
            h = pick(m, "hike", lang)
            if h:
                lv = " | ".join(f"{h['hike'][k]['mer']:.1f} / {h['hike'][k]['pier']:.1f}" for k in ("word", "phrase", "sentence"))
                print(f"| {m} | {lang} | {lv} |")

    print("\n## E2 장시간 완주 (AI Hub 4개 세션, 66–90분, 언어 고정, 30초 청크)\n")
    print("| 모델 | 세션별 CER (190 / 195 / 196 / 201) | 반복 출력 | 오류 |")
    print("| --- | --- | --- | --- |")
    for m in MODELS:
        a = pick(m, "aihub")
        if a:
            ps = " / ".join(f"{v['cer']:.1f}" for _, v in sorted(a["per_session"].items()))
            print(f"| {m} | {ps} | {a['repetitions']} | {a['errors']}/{a['n']} |")

    print("\n## E3 용어집 (AI Hub, 언어 고정)\n")
    print("| 모델 | 용어집 | CER | 용어 재현율 | 반복 출력 |")
    print("| --- | --- | --- | --- | --- |")
    for m in ("qwen3-1.7b", "whisper-turbo"):
        for g in (False, True):
            a = pick(m, "aihub", glossary=g)
            print(f"| {m} | {'있음' if g else '없음'} | {fmt(a, lambda r: r['cer'])} | {fmt(a, lambda r: r['term_recall'], '.1f')}% | {fmt(a, lambda r: r['repetitions'], 'd')} |")

    print("\n## E4 청크 길이 (qwen3-1.7b, AI Hub, 언어 고정)\n")
    print("| 최대 청크 | CER | 용어 재현율 | RTF |")
    print("| --- | --- | --- | --- |")
    for c in (15.0, 30.0, 60.0):
        a = pick("qwen3-1.7b", "aihub", chunk=c)
        print(f"| {int(c)}초 | {fmt(a, lambda r: r['cer'])} | {fmt(a, lambda r: r['term_recall'], '.1f')}% | {fmt(a, lambda r: r['rtf'], '.3f')} |")

    print("\n## E5 자르기 방식 (AI Hub, 언어 고정, 30초 이하)\n")
    print("vad: 제품과 같은 Silero 청크, label: 정답 발화 경계로 묶음, utt: 정답 발화 하나씩.\n")
    print("| 모델 | 자르기 | CER | 발음전사 CER | 반복 출력 | RTF | 피크 메모리 MLX |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for m in ("qwen3-1.7b", "lfm3-audio-2b"):
        for seg in ("vad", "label", "utt"):
            a = pick(m, "aihub", segments=seg)
            if a:
                print(f"| {m} | {seg} | {a['cer']:.2f} | {a['cer_pron']:.2f} | {a['repetitions']} | {a['rtf']:.3f} | {a['peak_mlx_gb']:.2f} GB |")


if __name__ == "__main__":
    main()
