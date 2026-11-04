// 사전 화면 (WORDS.md §4.29, §7.2: custom vocabulary)
import type { Dict } from "../i18n";

export default {
  사전: "Vocabulary",
  "사전: 텍스트로 변환할 때 더 정확하게 알아들을 단어": "Vocabulary: words to recognize more accurately when transcribing",
  "이름·제품명·전문 용어처럼 잘못 알아듣기 쉬운 단어를 적어 두면, 다음 녹음부터 텍스트로 변환할 때 더 정확하게 알아듣습니다.":
    "Add words that are easy to mishear, like names, product names and jargon. Future recordings will transcribe them more accurately.",
  "회의록·스마트 교정을 쓰면 사전 단어도 함께 AI 서비스로 보냅니다.": "Minutes and Smart fix also send these words to your AI service.", // words-ok: 탭 이름 `회의록`
  "지금 고른 변환 엔진은 사전 단어를 쓰지 않습니다.": "The transcription engine you chose doesn’t use custom vocabulary.",
  "단어를 적고 Enter": "Type a word and press Enter",
  "사전에 단어 추가": "Add a word to custom vocabulary",
  "{n}개 추가": ["Add {n} word", "Add {n} words"],
  "단어 {n}개": ["{n} word", "{n} words"],
  "변환에는 최근에 추가한 단어부터 {max}개까지 씁니다": "Transcription uses up to {max}, most recently added first",
  "사전에서 찾기": "Find in custom vocabulary",
  "맞는 단어가 없습니다": "No matching words",
  "아직 단어가 없습니다. 위 칸에 적거나, 대화 내용을 고칠 때 사전에 추가할 수 있습니다.": "No words yet. Type one above, or add words while fixing a transcript.",
  "데이터 폴더를 바꿨다면 이전 폴더의 glossary.md를 확인하세요.": "If you changed the data folder, check glossary.md in the previous one.",
  "‘{term}’ 고치기": "Edit “{term}”",
  "‘{term}’ 지우기": "Delete “{term}”",
  "사전에서 지웠습니다 — {term}": "Removed from custom vocabulary — {term}",
  되돌리기: "Undo",
  "{n}개는 추가하지 못했습니다 (40자가 넘거나 사전이 가득 찼습니다)": ["Couldn’t add {n} word (over 40 characters, or the list is full)", "Couldn’t add {n} words (over 40 characters, or the list is full)"],
} satisfies Dict;
