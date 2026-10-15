// 네이티브 모달 <dialog> (showModal) 공용 모양: 가운데 카드 + 흐린 뒤 화면
export const DIALOG =
  "m-auto w-[min(440px,calc(100vw-32px))] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-pop backdrop:bg-black/30 backdrop:backdrop-blur-[2px] open:animate-in open:fade-in-0 open:zoom-in-95";
export const DIALOG_BODY = "flex flex-col gap-2 px-5 pt-5 pb-4";
export const DIALOG_TITLE = "m-0 text-[15px] font-semibold";
export const DIALOG_TEXT = "m-0 text-[13px] leading-relaxed text-muted-foreground";
export const DIALOG_FOOTER = "flex justify-end gap-2 border-t border-border bg-muted/50 px-5 py-3";
