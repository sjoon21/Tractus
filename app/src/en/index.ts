// 영어 사전: 한국어 문구(키) → 영어. 화면 영역마다 파일 하나, 같은 키는 한 곳에만 둔다(i18n.test.ts가 겹침을 막는다).
// 용어는 WORDS.md §7. 영어일 때만 불러온다(main.tsx).
import type { Dict } from "../i18n";

const parts = import.meta.glob<{ default: Dict }>("./*.ts", { eager: true });

export const EN: Dict = Object.assign({}, ...Object.entries(parts).filter(([p]) => p !== "./index.ts").map(([, m]) => m.default));
