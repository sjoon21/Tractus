---
meeting_id: 01M0C67Y40RMV2S860E7CD9PGX
provider: synthetic
model: handwritten
generated_at: 2026-08-19T14:00:00+09:00
---

# 검색 API latency 개선

지난주 배포 후 검색 API p95 latency가 280 밀리초에서 1.2초로 올라간 문제를 다뤘다. 원인은 자동완성 기능의 Elasticsearch wildcard 쿼리였다. 자동완성을 edge n-gram analyzer로 바꾸고 인기 검색어를 Redis에 캐싱해 p95 300 밀리초 이하로 복구하기로 했다. 재발 방지를 위해 CI에 검색 regression test를 추가하고, 첫 한 달은 경고만 준 뒤 배포 차단으로 전환한다.

## 주제

### 검색 latency 원인 분석 [00:00:00–00:00:58]

### 자동완성·캐시 개선안 [00:00:59–00:02:20]

### 검색 regression test와 배포 gate [00:02:20–00:03:33]

## 결정 사항

- 자동완성을 edge n-gram analyzer로 바꾸고 인기 검색어 Redis 캐시를 도입한다 (목표 p95 300 밀리초 이하) [00:01:39]
- latency 기준 초과 시 첫 한 달은 경고만 주고 이후 배포 차단으로 전환한다 [00:03:24]

## 할 일

- [ ] Elasticsearch reindex 및 edge n-gram analyzer 변경 — 한지민, 8월 26일 [00:02:01]
- [ ] 인기 검색어 Redis 캐시 도입 — 오태양, 8월 26일 [00:02:01]
- [ ] CI에 검색 regression test suite 추가 — 이서준, 9월 첫째 주 [00:02:36]
