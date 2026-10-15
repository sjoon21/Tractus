# 앱 화면 디자인 지침

macOS 노트 앱(Granola·Apple Notes) 톤. 무채색 바탕에 색은 의미로만 쓴다. Tailwind v4 + shadcn 방식의 부품(`src/components/ui/`, Radix 없이 네이티브 요소).
토큰은 `src/theme.css`가 원본이다. 전역 바탕 규칙은 `src/base.css`, 상태가 많은 노트 화면 선택자(대화 내용·참석자·재생 막대)는 `src/components/note/note.css`에 있다(둘 다 `components` 레이어라 Tailwind 유틸리티가 이긴다).

## 1. 색 (의미로만)

| 토큰 (Tailwind) | 뜻 |
| --- | --- |
| `background` / `foreground` | 본문 바탕·글자 |
| `muted-foreground` / `subtle-foreground` | 보조 글자 / 더 옅은 글자(개수·시각) |
| `sidebar`, `sidebar-accent` | 왼쪽 목록 바탕, 그 안의 가리킴·선택 |
| `accent` | 본문 쪽 가리킴·선택 바탕 |
| `border`, `border-strong`, `input` | 선, 강한 선, 입력 테두리 |
| `rec`, `rec-wash` | 지금·녹음·재생 위치 (시스템 빨강) |
| `memo`, `memo-wash` | 사람이 남긴 것: 메모·북마크·고친 문장·즐겨찾기 |
| `ring` | 키보드 초점 (시스템 파랑) |
| `destructive` | 되돌리기 어려운 동작 하나 (삭제) |
| `--spk-0…7` | 참석자 색 (`Speakers.spkStyle`) |

- 테마는 `<html data-theme="light|dark">`(`themePref.ts`). `dark:` 변형을 거의 쓸 일이 없다: 토큰이 알아서 바뀐다.
- 빨강 바탕 블록·큰 색 면을 만들지 않는다. 강조는 글자색·얇은 선·옅은 wash.

## 2. 글자 크기 (px)

| 쓰임 | 클래스 |
| --- | --- |
| 노트 제목 | `text-[22px] font-semibold tracking-tight` |
| 화면 머리(설정·모델·검색) | `PageHeader` (15px semibold) |
| 구역 제목 | `text-[13px] font-semibold` |
| 기본 UI 글자·단추·입력 | `text-[13px]` |
| 읽는 글(대화 내용·메모 본문) | `text-[15px] leading-7` |
| 오른쪽 패널 읽는 글(요약·답) | `text-[14px] leading-6` |
| 보조·메타·설명 | `text-xs` (12px) `text-muted-foreground` |
| 배지·단축키 | 11px (`Badge`, `Kbd`) — 이보다 작게 쓰지 않는다 |

- 대문자 자간 넓힌 eyebrow(`letter-spacing: .14em`)를 쓰지 않는다. 숫자는 `tabular-nums`.

## 3. 크기·간격

- 조작 높이: 기본 `h-8`, 작은 것 `h-7`(목록·툴바), 아이콘 단추 `size-7`/`size-8`. 단추는 내용만큼 넓다(폭을 늘이지 않는다). 입력창은 한 줄 값이면 `max-w-sm`~`max-w-md`, 경로처럼 긴 값만 넓게.
- 화면 여백: 본문 `px-6`~`px-8`, 구역 사이 `gap-8`, 구역 안 `gap-2`~`gap-3`. 모서리 `rounded-md`(6px)·`rounded-lg`(8px)만.
- 창 맨 위 52px은 신호등 단추·창 끌기 자리다(`data-tauri-drag-region`). 화면 머리는 `PageHeader`를 쓰면 맞는다.

## 4. 부품

- `Button` — `variant`: `default`(그 화면의 주 동작 하나), `outline`, `secondary`, `ghost`(툴바·부차 동작), `destructive`(확인 창의 삭제), `rec`, `link`. `size`: `sm`·`default`·`lg`·`icon`·`icon-sm`. 옛 `.text-button`(밑줄 글자 단추)은 `ghost` `sm` 또는 `link`로.
- `Input`, `Textarea`, `Select`(네이티브), `Switch`(켜고 끄는 설정), `checkClass`(체크박스·라디오), `Kbd`, `Badge`(`default`·`memo`·`rec`·`outline`), `Progress`(값 0..1 또는 null).
- `Section` + `Row` — 설정처럼 이름/조작이 짝인 목록(macOS 시스템 설정의 묶음 카드). `PageHeader`(뒤로 + 제목 + 동작) + `PageBody`(가운데 읽기 폭).
- 메뉴·팝오버: `Popover`/`ItemMenu`(`src/Popover.tsx`), 클래스 `MENU`·`MENU_ITEM`(`src/components/menu.ts`).
- 아이콘: `lucide-react` 16px(`[&_svg]:size-4`). 아이콘만 있는 단추에는 `aria-label`과 `title`.
- 모델·도구가 없어 못 쓰는 단추는 반드시 `GatedButton`(이유 팝오버). `className`에 `buttonVariants(...)`를 넘긴다.

## 5. 규칙

- **문구**: 화면 문구·`aria-label`을 바꾸거나 지우기 전에 저장소 루트의 `WORDS.md`를 읽는다. 용어를 바꾸지 않는다. 화면을 어지럽히는 긴 안내는 줄이거나 `title`(툴팁)로 옮겨도 된다. 끝나면 WORDS.md §5 금지어 검사(출력 없음).
- **동작**: 키보드·초점·`role`·`aria-*`·`id`(다른 곳이 찾는 것)·테스트가 찾는 클래스는 그대로 둔다. 로직은 바꾸지 않는다(이 작업은 겉모습이다).
- **CSS**: 화면 모양은 Tailwind 클래스로 쓴다. 클래스 이름에 `aria-disabled`·`disabled` 글자를 쓰지 않는다(테스트가 HTML에서 그 속성을 찾는다): `gated:`·`off:` 변형을 쓴다.
- **확인**: `pnpm dev`(또는 `pnpm tauri dev`) 중에 `/preview.html`이 가짜 데이터로 앱을 띄운다(`src/preview/main.tsx`). 라이트·다크, 창 폭 900·1280·1600에서 본다. 넘치는 글자·잘린 단추·가로 스크롤이 없어야 한다.
