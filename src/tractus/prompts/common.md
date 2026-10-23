# 모든 기능이 함께 쓰는 문구

`json_schema`·`retry`는 `llm.complete_json`이 붙인다. `lang_en`은 영어 화면에서 각 기능의 `lang` 대신 들어간다(`i18n.ai_prompt`).

## json_schema

반드시 아래 JSON Schema를 따르는 JSON 객체 하나만 출력한다. 설명이나 코드 펜스를 붙이지 않는다.

## retry

응답이 검증에 실패했습니다:
{error}
스키마와 조건에 맞는 JSON만 다시 출력하세요.

## lang_en

- 결과는 모두 영어(English)로 쓴다. 노트가 다른 언어여도 영어로 옮겨 쓰고, 영어 기술 용어는 원문 표기를 살린다.
