"""한국어 숫자 표기 바꾸기 (tractus.itn). 측정 근거는 bench/itn_eval.py와 docs/design/korean-itn.md."""

import pytest

from tractus.itn import korean_numbers, parse

CASES = {
    "점유율이 삼십 프로 정도": "점유율이 30프로 정도",
    "이천이십육 년 계획": "2026년 계획",
    "예산은 삼십오만 원입니다": "예산은 35만 원입니다",
    "오조 원 규모": "5조 원 규모",
    "삼억 오천만 원": "3억 5000만 원",
    "회의는 삼십 분 동안": "회의는 30분 동안",
    "육 프로를 넘으면": "6프로를 넘으면",
    "칠 명이 왔고 오 분 쉬고": "7명이 왔고 5분 쉬고",
    "삼월에 사층에서": "3월에 4층에서",
    "이번 주에 이 시간에 이 분이": "이번 주에 이 시간에 이 분이",
    "구조를 바꾸고 오만하게": "구조를 바꾸고 오만하게",
    "일시 정지하고 일단 일대 일로": "일시 정지하고 일단 일대 일로",
    "오세요 사위 사명 사원 사번": "오세요 사위 사명 사원 사번",
    "사실 오늘 사람들이 구분해": "사실 오늘 사람들이 구분해",
    "두 번 세 가지": "두 번 세 가지",
    "백 프로 십 분 이십 명": "100프로 10분 20명",
    "삼십 이백오십": "30 250",
    "오십견 삼천리 만 원": "오십견 삼천리 만 원",
    "이십일 일": "21일",
    "공조 체계와 구조 개선 일조 원": "공조 체계와 구조 개선 1조 원",
    "오 박사 삼 개발 일 배포 사 회의": "오 박사 삼 개발 일 배포 사 회의",
    "삼 년이 지나 오십 명씩 이십 분간": "3년이 지나 50명씩 20분간",
    "hello 123": "hello 123",
}


@pytest.mark.parametrize("src,want", CASES.items())
def test_korean_numbers(src, want):
    assert korean_numbers(src) == want


def test_parse_rejects_shapes_that_are_not_numbers():
    assert parse("이천이십육") == [(2026, "")]
    assert parse("삼억오천만") == [(3, "억"), (5000, "만")] and parse("천백") == [(1100, "")]
    for word in ("일이", "오일", "백천", "공조", "만억"):
        assert parse(word) is None, word


def test_output_without_hangul_is_untouched():
    assert korean_numbers("WTO 2026 plan") == "WTO 2026 plan"
