// `직접 프롬프트로 요약…` 대화상자 (docs/desktop.md §2.13). 네이티브 모달 <dialog>(ConfirmDialog와 같다): Esc는 취소, Tab은 안에서만 돈다.
// 요약 방법 입력은 여러 줄이라 Enter는 줄바꿈이고 ⌘Enter가 보낸다. 이름 칸에서는 Enter가 보낸다. 글자 조합(IME) 중에는 어떤 키도 가로채지 않는다.
// 입력 검사는 summaries.checkCustom (코어와 같은 한도·문장). 화면에 올릴 때만 렌더한다(마운트 = 열림).
import { useEffect, useId, useRef, useState } from "react";
import { isImeKey } from "./lib";
import { checkCustom, customSpec, MAX_NAME, promptCounter, type SummarySpec } from "./summaries";
import { Button } from "@/components/ui/button";
import { DIALOG, DIALOG_BODY, DIALOG_FOOTER, DIALOG_TEXT, DIALOG_TITLE } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { checkClass } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/components/ui/utils";

export const EXAMPLE_PROMPT = "예: 고객이 말한 불만을 유형별로 모아서, 유형마다 어떤 대화에서 나왔는지 정리해 줘";

export function CustomSummaryDialog({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (spec: SummarySpec) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState("");
  const [save, setSave] = useState(false);
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false); // 보내 보기 전에는 오류를 보이지 않는다 (처음부터 빨갛지 않게)
  const [composing, setComposing] = useState(false);
  const ids = { prompt: useId(), name: useId(), promptErr: useId(), nameErr: useId(), hint: useId() };
  const check = checkCustom({ prompt, save, name });

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);

  const submit = () => {
    setTried(true);
    if (check.ok) onSubmit(customSpec({ prompt, save, name }));
  };
  const enter = (e: React.KeyboardEvent, needMeta: boolean) => {
    if (e.key !== "Enter" || isImeKey(e.nativeEvent, composing) || e.shiftKey) return;
    if (needMeta && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    submit();
  };
  const imeProps = { onCompositionStart: () => setComposing(true), onCompositionEnd: () => setComposing(false) };

  return (
    <dialog
      ref={dialog}
      className={cn(DIALOG, "w-[min(540px,calc(100vw-32px))]")}
      aria-labelledby="custom-summary-title"
      aria-describedby={ids.hint}
      onCancel={(e) => {
        e.preventDefault(); // Esc: 닫는 일은 상태가 한다
        if (!composing) onCancel();
      }}
    >
      <div className={cn(DIALOG_BODY, "gap-3")}>
        <div className="flex flex-col gap-1">
          <h2 id="custom-summary-title" className={DIALOG_TITLE}>
            직접 프롬프트로 요약
          </h2>
          <p id={ids.hint} className={DIALOG_TEXT}>
            원하는 요약 방법을 적으면 AI가 그대로 정리합니다. 항목마다 근거가 된 대화가 함께 표시됩니다.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium" htmlFor={ids.prompt}>
            요약 방법
          </label>
          <Textarea
            id={ids.prompt}
            className="min-h-36 resize-y aria-invalid:border-destructive aria-invalid:ring-destructive/20"
            rows={7}
            value={prompt}
            placeholder={EXAMPLE_PROMPT}
            spellCheck={false}
            autoFocus
            aria-invalid={tried && !!check.prompt}
            aria-describedby={tried && check.prompt ? ids.promptErr : undefined}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => enter(e, true)}
            {...imeProps}
          />
          <div className="flex min-h-4 justify-between gap-3 text-xs">
            <span id={ids.promptErr} className="text-destructive" role="alert">
              {tried || prompt.trim().length > 0 ? check.prompt : null}
            </span>
            <span className={cn("shrink-0 tabular-nums", check.prompt && prompt.trim() ? "text-destructive" : "text-subtle-foreground")}>{promptCounter(prompt)}</span>
          </div>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-[13px]">
          <input type="checkbox" className={cn(checkClass, "mt-0.5")} checked={save} onChange={(e) => setSave(e.target.checked)} />
          <span>템플릿으로 저장 — 다음에도 이 요약 유형으로 고를 수 있습니다</span>
        </label>
        {save && (
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium" htmlFor={ids.name}>
              이름 ({MAX_NAME}자까지)
            </label>
            <Input
              id={ids.name}
              className="max-w-sm aria-invalid:border-destructive aria-invalid:ring-destructive/20"
              value={name}
              spellCheck={false}
              aria-invalid={tried && !!check.name}
              aria-describedby={tried && check.name ? ids.nameErr : undefined}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => enter(e, false)}
              {...imeProps}
            />
            <span id={ids.nameErr} className="min-h-4 text-xs text-destructive" role="alert">
              {tried ? check.name : null}
            </span>
          </div>
        )}
      </div>
      <div className={DIALOG_FOOTER}>
        <Button variant="outline" onClick={onCancel}>
          취소
        </Button>
        <Button aria-disabled={!check.ok} title="⌘Enter" onClick={submit}>
          요약 만들기
        </Button>
      </div>
    </dialog>
  );
}
