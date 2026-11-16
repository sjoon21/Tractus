// 네이티브 모달 <dialog> (showModal) 공용 모양: 가운데 카드 + 흐린 뒤 화면
export const DIALOG =
  "m-auto w-[min(560px,calc(100vw-48px))] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-pop backdrop:bg-black/30 backdrop:backdrop-blur-[2px] open:animate-in open:fade-in-0 open:zoom-in-95";
export const DIALOG_BODY = "flex flex-col gap-3 px-6 pt-6 pb-5";
export const DIALOG_TITLE = "m-0 text-[17px] font-semibold";
export const DIALOG_TEXT = "m-0 text-sm leading-relaxed text-muted-foreground";
/** 본문 위의 주의 문장 (함께 사라지는 것 등): 위험 색 글자 + 얇은 선 + 옅은 바탕 */
export const DIALOG_WARN = "m-0 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium leading-relaxed text-destructive";
export const DIALOG_FOOTER = "flex justify-end gap-2 border-t border-border bg-muted/50 px-6 py-4";
