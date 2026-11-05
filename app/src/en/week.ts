// 홈의 `이번 주` 띠 (WORDS.md §4.31)
import type { Dict } from "../i18n";

export default {
  "이번 주": "This week",
  "{month} {range}일": "{month}, {range}",
  지난주: "Previous week",
  "다음 주": "Next week",
  요일: "Days",
  "{day}일 {weekday}요일 · 일정 {e} · 노트 {n}": "{weekday} {day} · events {e} · notes {n}",
  "일정과 노트가 없습니다": "No events or notes",
  종일: "All day",
} satisfies Dict;
