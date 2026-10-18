"""채점: CER(ko), WER(en), HiKE MER·PIER, 반복 출력."""

import json
import re
import sys
import unicodedata
from pathlib import Path

import jiwer

HIKE_SRC = Path(__file__).resolve().parent / "third_party/HiKE"
# openai/whisper-large-v3-turbo의 normalizer.json (MIT). Whisper 모델 없이도 AMI WER을 채점하려고 복사해 둠
WHISPER_NORMALIZER = Path(__file__).resolve().parent / "assets/whisper_english_normalizer.json"


def norm_ko(text: str) -> str:
    """문장부호·공백 제거, 영어 소문자화. 숫자 표기는 그대로 둔다(정규화하지 않음)."""
    text = unicodedata.normalize("NFC", text).lower()
    return "".join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P"))


def cer(refs: list[str], hyps: list[str]) -> float:
    """코퍼스 단위 CER(%). 발화별 평균이 아니라 전체 문자 기준."""
    pairs = [(norm_ko(r), norm_ko(h)) for r, h in zip(refs, hyps)]
    pairs = [(r, h) for r, h in pairs if r]
    return jiwer.cer([r for r, _ in pairs], [h for _, h in pairs]) * 100


_en_norm = None


def wer_en(refs: list[str], hyps: list[str]) -> float:
    """Whisper EnglishTextNormalizer 적용 후 코퍼스 단위 WER(%)."""
    global _en_norm
    if _en_norm is None:
        from transformers.models.whisper.english_normalizer import EnglishTextNormalizer

        _en_norm = EnglishTextNormalizer(json.loads(WHISPER_NORMALIZER.read_text()))
    pairs = [(_en_norm(r), _en_norm(h)) for r, h in zip(refs, hyps)]
    pairs = [(r, h if h else "<empty>") for r, h in pairs if r.strip()]
    return jiwer.wer([r for r, _ in pairs], [h for _, h in pairs]) * 100


def hike_scores(rows: list[dict]) -> dict:
    """HiKE 공식 src/main.py의 평가 부분과 같은 계산. 발화별 점수의 평균."""
    sys.path.insert(0, str(HIKE_SRC / "src/metrics/pier/jiwer"))
    sys.path.insert(0, str(HIKE_SRC))
    from src.metrics import mer, pier_fixed
    from src.utils import add_space, normalize_text, replace_loanword

    per_level: dict[str, list[tuple[float, float, bool]]] = {}
    for r in rows:
        m = r["meta"]
        pred = normalize_text(replace_loanword(r["hyp"], m["loanwords"]))
        ref_pier = replace_loanword(m["text_pier_labeled"], m["loanwords"])
        ref_mer = replace_loanword(m["text_normalized"], m["loanwords"])
        score = (mer(ref_mer, pred)[0], pier_fixed(ref_pier, add_space(pred)), repetitions(r["hyp"]) > 0)
        per_level.setdefault(m["cs_level"], []).append(score)
        per_level.setdefault("all", []).append(score)
    # 평균(공식 지표)은 반복 루프 몇 건에 끌려간다. 중앙값과 반복 발화 수를 함께 남긴다.
    return {
        lvl: {
            "mer": sum(s[0] for s in v) / len(v),
            "pier": sum(s[1] for s in v) / len(v),
            "mer_median": sorted(s[0] for s in v)[len(v) // 2],
            "loops": sum(s[2] for s in v),
            "n": len(v),
        }
        for lvl, v in per_level.items()
    }


def term_recall(rows: list[dict]) -> float:
    """용어집 용어가 정답에 나온 횟수 중 전사에도 나온 비율(%). 대소문자 무시, 영문 단어 경계 기준."""

    def count(term: str, text: str) -> int:
        return len(re.findall(r"(?<![a-z])" + re.escape(term.lower()) + r"(?![a-z])", text.lower()))

    hit = total = 0
    for r in rows:
        for t in r["meta"]["glossary"]:
            c = count(t, r["ref"])
            total += c
            hit += min(c, count(t, r["hyp"]))
    return hit / total * 100 if total else 0.0


_REPEAT = re.compile(r"(.{4,}?)\1{2,}")


def repetitions(text: str) -> int:
    """4글자 이상 문자열이 연속 3회 이상 반복된 구간 수(공백·문장부호 제거 후)."""
    return len(_REPEAT.findall(norm_ko(text)))


if __name__ == "__main__":
    assert norm_ko("Hello, 세계! 6프로.") == "hello세계6프로"
    assert round(cer(["가나다라"], ["가나다마"]), 1) == 25.0
    assert repetitions("회의를 시작합니다. 회의를 시작합니다. 회의를 시작합니다.") == 1
    assert repetitions("네 네 네 좋습니다") == 0
    assert term_recall([{"ref": "WTO 가입과 OECD", "hyp": "wto 가입과 오이씨디", "meta": {"glossary": ["WTO", "OECD"]}}]) == 50.0
    print("ok")
