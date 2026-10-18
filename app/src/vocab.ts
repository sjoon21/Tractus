// 고친 낱말을 자주 쓰는 단어로 제안하기 (v3.53): 대화 한 줄을 "언톨로지 → 온톨로지"처럼 고치면 고친 낱말을 돌려준다.
// 용어 고침으로 보는 것만: 바뀐 부분이 낱말 1~2개이고, 고치기 전과 소리가 비슷하고(자모 비교), 용어처럼 보인다(동사·어미로 끝나지 않음).
// 화면과 무관한 순수 함수: vocab.test.ts. 제안은 MeetingView가 알림으로 띄우고, 누르면 `glossary add`.

/** 낱말 끝에서 떼는 조사 (긴 것부터) */
const JOSA = ["에서는", "에서", "으로", "이랑", "한테", "까지", "부터", "처럼", "보다", "에게", "로", "를", "을", "이", "가", "은", "는", "에", "와", "과", "도", "의", "랑", "만"]; // i18n-ok: 한국어 처리 데이터
/** 이렇게 끝나면 용어가 아니라 말투를 고친 것이다 */
const VERBISH = /(다|요|죠|고|며|니까|는데)$/; // 지·게·데·서로 끝나는 명사(온톨로지·문서)가 많아 넣지 않는다 (i18n-ok: 한국어 처리 데이터)
/** 고치기 전과 이만큼은 비슷해야 오인식 고침이다 (아니면 다른 말로 바꿔 쓴 것) */
export const SIMILAR_MIN = 0.3;

/** 끝의 문장부호와 조사를 뗀다 (조사를 떼고도 두 글자 이상 남을 때만) */
export function stem(word: string): string {
  const w = word.replace(/[.,!?;:)"'”’」』\]]+$/u, "").replace(/^[("'“‘「『[]+/u, "");
  if (!/[가-힣]$/.test(w)) return w; // i18n-ok: 한국어 처리 데이터
  const j = JOSA.find((x) => w.endsWith(x) && [...w].length - [...x].length >= 2);
  return j ? w.slice(0, -j.length) : w;
}

/** 한글을 자모로 푼다 (소리 비교용). 한글이 아닌 글자는 소문자로 그대로 */
function jamo(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)! - 0xac00;
    if (c < 0 || c > 11171) out += ch.toLowerCase();
    else out += String.fromCharCode(0x1100 + Math.floor(c / 588), 0x1161 + Math.floor((c % 588) / 28)) + (c % 28 ? String.fromCharCode(0x11a7 + (c % 28)) : "");
  }
  return out;
}

function similarity(a: string, b: string): number {
  const x = [...jamo(a)];
  const y = [...jamo(b)];
  if (!x.length || !y.length) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

const termLike = (s: string) => {
  const n = [...s].length;
  return n >= 2 && n <= 30 && /[가-힣A-Za-z]/.test(s) && !/^\d+$/.test(s) && (/[A-Za-z0-9]/.test(s) || !VERBISH.test(s)); // i18n-ok: 한국어 처리 데이터
};

/** 고치기 전·후 문장 → 자주 쓰는 단어로 제안할 낱말. 용어 고침이 아니면 null */
export function termFromEdit(before: string, after: string): string | null {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const old = a.slice(p, a.length - s);
  const now = b.slice(p, b.length - s);
  if (now.length < 1 || now.length > 2 || old.length < 1 || old.length > 3) return null;
  const term = [...now.slice(0, -1), stem(now[now.length - 1])].join(" ");
  const was = [...old.slice(0, -1), stem(old[old.length - 1])].join(" ");
  if (term === was || !termLike(term) || term.replace(/\d/g, "") === was.replace(/\d/g, "") || similarity(was.replace(/\s/g, ""), term.replace(/\s/g, "")) < SIMILAR_MIN) return null;
  return term;
}
