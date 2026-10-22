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


def _spaced(text: str) -> str:
    """문장부호만 지우고 띄어쓰기는 남긴다 (공백은 하나로)."""
    text = unicodedata.normalize("NFC", text).lower()
    return " ".join("".join(c for c in text if not unicodedata.category(c).startswith("P")).split())


def wer_ko(refs: list[str], hyps: list[str]) -> float:
    """띄어쓰기를 살린 코퍼스 단위 WER(%). CER(norm_ko)이 지우는 띄어쓰기 오류가 보인다 (2026-10-18, STT 품질 측정)."""
    pairs = [(_spaced(r), _spaced(h)) for r, h in zip(refs, hyps)]
    pairs = [(r, h or "<empty>") for r, h in pairs if r]
    return jiwer.wer([r for r, _ in pairs], [h for _, h in pairs]) * 100


# 혼자 떨어진 소리 군말. 정답(AI Hub)에는 있고 모델은 대부분 지워서, 그대로 세면 모델이 군말을 지운 것이 오류로 잡힌다
FILLERS = {"어", "음", "아", "에", "으", "흠", "엄", "어어", "음음"}


def cer_nofill(refs: list[str], hyps: list[str]) -> float:
    """혼자 떨어진 소리 군말(FILLERS)을 양쪽에서 뺀 CER(%)."""
    drop = lambda s: " ".join(w for w in _spaced(s).split() if w not in FILLERS)  # noqa: E731
    return cer([drop(r) for r in refs], [drop(h) for h in hyps])


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


def pair_kind(spelling: str) -> str:
    return "num" if re.search(r"\d", spelling) else "latin" if re.search(r"[A-Za-z]", spelling) else "other"


def cer_best(rows: list[dict], kinds: frozenset = frozenset({"num", "latin", "other"})) -> float:
    """표기 차이를 뺀 CER(%): 발화마다 이중전사 짝을 철자·발음 중 전사에 가까운 쪽으로 골라 채점한다.
    run.py --segments utt 결과만 (meta.parts·forms가 발화마다 짝). kinds 밖의 짝은 철자 그대로 (빈 집합 = 철자 기준 발화 단위 CER).
    짝마다 따로 고른다(다른 짝은 철자로 둔 채): 한 발화 안의 짝끼리 거의 독립이라 충분하다."""
    from data import _DUAL, aihub_clean
    from rapidfuzz.distance import Levenshtein

    edits = chars = 0
    for r in rows:
        for form, hyp in zip(r["meta"]["forms"], r["meta"]["parts"]):
            h = norm_ko(hyp)
            pairs = list(_DUAL.finditer(form))
            choice = []
            for i, m in enumerate(pairs):
                if pair_kind(m.group(2)) not in kinds:
                    choice.append(2)
                    continue
                trial = lambda g: norm_ko(aihub_clean(_pick(form, pairs, {i: g})))  # noqa: E731
                choice.append(1 if Levenshtein.distance(trial(1), h) < Levenshtein.distance(trial(2), h) else 2)
            ref = norm_ko(aihub_clean(_pick(form, pairs, dict(enumerate(choice)))))
            if ref:
                edits += Levenshtein.distance(ref, h)
                chars += len(ref)
    return edits / chars * 100 if chars else 0.0


def _pick(form: str, pairs: list, groups: dict[int, int]) -> str:
    """짝 i를 groups[i](1 발음, 2 철자, 없으면 철자)로 바꾼 form. aihub_clean이 나머지를 철자로 푼다"""
    out, last = [], 0
    for i, m in enumerate(pairs):
        out += [form[last : m.start()], m.group(groups.get(i, 2))]
        last = m.end()
    return "".join(out) + form[last:]


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
    row = {"meta": {"forms": ["(육 프로)/(6프로) 올랐고 (더블유티오)/(WTO) 가입"], "parts": ["육 프로 올랐고 WTO 가입"]}}
    assert round(cer_best([row], frozenset()), 1) > 0  # 철자 기준이면 "육 프로"가 오류
    assert cer_best([row]) == 0.0
    assert cer_best([row], frozenset({"latin"})) > 0  # 숫자 짝은 철자 그대로
    print("ok")
