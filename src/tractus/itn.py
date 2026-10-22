"""한국어 숫자 표기 바꾸기(ITN): 음성 인식이 한글로 적은 한자어 수를 숫자로 ("삼십 프로" → "30프로", "이천이십육 년" → "2026년").

보수적으로 바꾼다 (틀리게 바꾸는 것이 그대로 두는 것보다 나쁘다):
- 뒤에 단위(UNITS)와 조사가 오는 수, 또는 단위가 없어도 수일 수밖에 없는 수(세 글자 이상이면서 십·백·천·만·억·조가 든 것, 두 글자는 "○십")만 바꾼다.
- 한 글자 수("삼", "오")는 띄어 쓴 단위 앞에서만 바꾼다 ("오 분" → "5분"). 붙여 쓴 단위는 ATTACHED_OK만:
  "오세요"·"사위"·"사명"·"일시"처럼 수가 아닌 낱말이 많다.
- `이` 한 글자는 바꾸지 않는다: "이 시간", "이 분"(이 사람), "이 점"처럼 "this"로 더 자주 쓰인다.
- 고유어 수("두 번", "세 가지")는 그대로 둔다: "한번 해 보자"처럼 수가 아닌 뜻이 많다.
- 만·억·조는 단위 말로 남긴다 ("삼십오만" → "35만", "오조 원" → "5조 원"): 회의록에서 흔한 표기이고 AI Hub 철자 전사와 같다.
측정: bench/itn_eval.py (AI Hub 발화 단위 결과로 오류율이 내려가는지, 나빠진 발화가 몇 개인지).
"""

from __future__ import annotations

import re

DIGITS = {"영": 0, "공": 0, "일": 1, "이": 2, "삼": 3, "사": 4, "오": 5, "육": 6, "칠": 7, "팔": 8, "구": 9}
SMALL = {"십": 10, "백": 100, "천": 1000}
BIG = {"만": 10**4, "억": 10**8, "조": 10**12}
_N = "".join(DIGITS) + "".join(SMALL) + "".join(BIG)

UNITS = sorted("""원 달러 엔 위안 유로 명 개 개월 년 년도 월 일 시 시간 분 초 주 주년 주차 번 번째 차 차례 회 회차 층 대 건 배 세 살
    점 프로 퍼센트 % 위 등 페이지 쪽 장 권 호 기 킬로 미터 센티 밀리 그램 톤 리터 기가 메가 테라 바이트 평 인분 군데 종류
    단계 포인트 년생 학년 학기 분기 시즌 버전 레벨 라운드""".split(), key=len, reverse=True)  # 긴 것부터 ("개월"이 "개"보다 먼저)
ATTACHED_OK = {"년", "년도", "월", "개월", "프로", "퍼센트", "%", "층", "분기", "주년"}
# 단위 바로 뒤에 올 수 있는 글자: 조사·어미의 첫 글자. 아니면 단위가 아니라 다른 낱말의 앞부분이다 ("오 박사", "삼 개발", "일 배포")
PARTICLE_START = set("이가을를은는에의도만로으와과부까나쯤씩째간짜밖마보처동입였라랑요인")
NOT_UNIT = {"회의", "기간", "시도", "대로"}  # 단위 + 조사처럼 보이지만 흔한 다른 낱말

# 수: 숫자 글자 덩어리. 만·억·조 뒤에서는 띄어 쓴 다음 덩어리도 같은 수다 ("삼억 오천만")
_RUN = re.compile(f"(?<![가-힣0-9])((?:[{_N}]*[만억조] )*[{_N}]+)( ?)({'|'.join(map(re.escape, UNITS))})?")


def parse(run: str) -> list[tuple[int, str]] | None:
    """한자어 수 → [(만 미만 값, 큰 단위 글자)] ("삼억 오천만" → [(3, "억"), (5000, "만")]). 수의 모양이 아니면 None."""
    groups: list[tuple[int, str]] = []
    cur, digit, last_small, last_big = 0, None, 10**4, 10**13
    for ch in run.replace(" ", ""):
        if ch in DIGITS:
            if digit is not None:  # "일이", "오일"처럼 숫자 글자가 이어지면 수가 아니다
                return None
            digit = DIGITS[ch]
        elif ch in SMALL:
            if SMALL[ch] >= last_small or digit == 0:  # "백천"처럼 순서가 거꾸로이거나 "영십"
                return None
            cur += (1 if digit is None else digit) * SMALL[ch]
            digit, last_small = None, SMALL[ch]
        else:
            n = cur + (digit or 0)
            if BIG[ch] >= last_big or n == 0:  # "만억", 앞이 비거나 0인 "억" ("공조")
                return None
            groups.append((n, ch))
            cur, digit, last_small, last_big = 0, None, 10**4, BIG[ch]
    tail = cur + (digit or 0)
    if tail or digit == 0 or not groups:
        groups.append((tail, ""))
    return groups


def render(groups: list[tuple[int, str]]) -> str:
    return " ".join(f"{n}{big}" for n, big in groups)


def _replace(m: re.Match) -> str:
    run, space, unit = m.group(1), m.group(2), m.group(3)
    flat = run.replace(" ", "")
    nxt = m.string[m.end() : m.end() + 1]
    if unit is None:
        if not (len(flat) >= 3 and any(c in SMALL or c in BIG for c in flat) or len(flat) == 2 and flat[1] == "십"):  # "구조", "오만", "사천"은 그대로
            return m.group(0)
        if not space and nxt and re.match("[가-힣]", nxt):  # "오십견", "구조를"처럼 낱말 안이면 그대로
            return m.group(0)
    elif nxt and re.match("[가-힣]", nxt) and (nxt not in PARTICLE_START or unit + nxt in NOT_UNIT):  # 단위 글자로 시작하는 다른 낱말
        return m.group(0)
    elif len(flat) == 1:
        if flat == "이" or flat in BIG:  # "만 원"은 그대로 둔다
            return m.group(0)
        if not space and (flat in SMALL or unit not in ATTACHED_OK):  # "백분율", "십시일반", "사위"
            return m.group(0)
    groups = parse(run)
    if groups is None:
        return m.group(0)
    out = render(groups)
    if unit is None:
        return out + space
    return out + (" " if groups[-1][1] and space else "") + unit  # "30분"은 붙이고 "5조 원"은 띄어 둔다


def korean_numbers(text: str) -> str:
    """음성 인식 결과 한 줄의 한자어 수를 숫자로. 한글이 없으면 그대로."""
    if not re.search("[가-힣]", text):
        return text
    return _RUN.sub(_replace, text)

