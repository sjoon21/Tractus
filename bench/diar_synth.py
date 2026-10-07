"""화자 분리용 가상 회의 (macOS `say`) → OUT/<id>.wav + OUT/ref/<id>.rttm. diar_eval.py der --set OUT으로 채점한다.

    uv run python bench/diar_synth.py OUT          # OUT은 저장소 밖 (예: 스크래치)
    uv run python bench/diar_eval.py der --engine nemotron fluid --set OUT

say2: Yuna + Grandpa(엔진이 다른 두 음성). say3: + Flo. say9: Yuna + 한국어 Eloquence 8개.
Eloquence 음성끼리는 같은 엔진이라 한 화자로 합쳐지기 쉽다. 순위 근거로 쓰지 않는다 (ARCHITECTURE §2.4.1).
화자당 4발화, 발화 사이 0.6초 무음, 순서는 고정 시드로 섞는다.
"""

import random
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

SR = 16000
GAP_S = 0.6
TURNS_PER = 4
SEED = 7
LINES = ["다음 분기 일정부터 확인하겠습니다.", "배포는 금요일 오후로 미루는 게 좋겠어요.", "테스트 결과는 오늘 저녁까지 공유드릴게요.",
         "예산 문제는 재무팀과 다시 이야기해 봐야 합니다.", "고객 피드백을 보면 검색 기능이 가장 급합니다.", "그 부분은 제가 담당하겠습니다.",
         "회의록은 공유 폴더에 올려 두겠습니다.", "디자인 시안은 두 가지로 준비했어요.", "서버 비용이 지난달보다 조금 늘었습니다.",
         "다음 주 월요일에 다시 모이면 될 것 같습니다.", "보안 점검 일정도 같이 잡아야 해요.", "신규 채용은 두 명으로 확정됐습니다."]
KO = "(한국어(한국))"
SETS = {
    "say2": ["Yuna", f"Grandpa {KO}"],
    "say3": ["Yuna", f"Grandpa {KO}", f"Flo {KO}"],
    "say9": ["Yuna"] + [f"{v} {KO}" for v in ("Grandpa", "Grandma", "Eddy", "Flo", "Reed", "Rocko", "Sandy", "Shelley")],
}


def tts(voice: str, text: str, tmp: Path) -> np.ndarray:
    """앞뒤 무음을 잘라낸 16 kHz int16."""
    aiff, wav = tmp / "a.aiff", tmp / "a.wav"
    subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(aiff), "-ac", "1", "-ar", str(SR), "-sample_fmt", "s16", str(wav)], check=True)
    with wave.open(str(wav)) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), "<i2")
    nz = np.flatnonzero(np.abs(x) > 300)
    return x[nz[0]:nz[-1] + 1] if nz.size else x


def main() -> None:
    out = Path(sys.argv[1])
    (out / "ref").mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)
    gap = np.zeros(int(GAP_S * SR), "<i2")
    for sid, voices in SETS.items():
        order = [i for i in range(len(voices)) for _ in range(TURNS_PER)]
        rng.shuffle(order)
        parts, ref, t = [], [], 0
        with tempfile.TemporaryDirectory() as tmp:
            for n, i in enumerate(order):
                x = tts(voices[i], LINES[n % len(LINES)], Path(tmp))
                ref.append((t / SR, (t + len(x)) / SR, f"V{i + 1}"))
                parts += [x, gap]
                t += len(x) + len(gap)
        pcm = np.concatenate(parts)
        with wave.open(str(out / f"{sid}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        (out / "ref" / f"{sid}.rttm").write_text("".join(f"SPEAKER {sid} 1 {s:.3f} {e - s:.3f} <NA> <NA> {k} <NA> <NA>\n" for s, e, k in ref))
        print(f"{sid}: {len(voices)}명, {len(order)}발화, {len(pcm) / SR:.1f}초")


if __name__ == "__main__":
    main()
