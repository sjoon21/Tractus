// 사이드바 공용 클래스 (App·NoteLibrary·NoteRow·FolderTree)

/** 사이드바 한 줄 동작 (AI 질문, 파일 가져오기 …) */
export const SIDE_ITEM =
  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-45 gated:opacity-45 aria-[current=true]:bg-sidebar-accent aria-[current=true]:font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** 구역 제목 (즐겨찾기 · 폴더 · 태그 · 전체 노트) */
export const SIDE_HEAD = "flex h-7 items-center gap-1 px-2 text-[11px] font-semibold text-subtle-foreground";

/** 노트 줄 단추 */
export const NOTE_LINK =
  "block w-full rounded-md px-2 py-1.5 pr-8 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 aria-[current=true]:bg-sidebar-accent";

/** 사이드바 진행 카드 (가져오기·한꺼번에 변환) */
export const JOB_CARD = "mx-3 mt-2 flex flex-col gap-1.5 rounded-md border border-sidebar-border bg-background/60 p-2.5 text-xs text-muted-foreground";

/** 줄 끝 `…` 단추: 줄을 가리키거나 초점이 갈 때만 보인다 (부모에 group) */
export const ROW_MORE =
  "absolute top-1.5 right-1 grid size-6 place-items-center rounded-[5px] text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 [&_svg]:size-4";

/** 폴더 나무 한 줄 */
export const FOLDER_ROW = "group relative flex items-center gap-0.5 rounded-md pr-1";
export const FOLDER_NAME =
  "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-[13px] outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40 aria-pressed:bg-sidebar-accent aria-pressed:font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";
export const TWISTY =
  "grid size-4 shrink-0 place-items-center rounded-[3px] text-subtle-foreground hover:text-foreground [&_svg]:size-3";
