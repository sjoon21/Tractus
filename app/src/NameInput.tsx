// 폴더 이름 입력창 (새 폴더·이름 바꾸기). Enter 저장, Esc 취소, 한글 조합 중에는 아무것도 하지 않는다 (lib.isImeKey).
// 이름이 잘못되면 입력창에 남아 이유를 보인다 (organize.checkFolderName: 코어와 같은 규칙).
import { useEffect, useRef, useState } from "react";
import { isImeKey } from "./lib";
import { checkFolderName, MAX_FOLDER_NAME, type Folder } from "./organize";

export function NameInput({
  initial = "",
  siblings,
  self,
  ariaLabel,
  placeholder,
  cancelOnBlur,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  /** 같은 위치의 폴더들 (이름이 겹치는지 본다) */
  siblings: readonly Folder[];
  /** 이름을 바꾸는 폴더 자신 (자기 이름과 겹침은 괜찮다) */
  self?: string;
  ariaLabel: string;
  placeholder?: string;
  /** 입력창을 벗어나면 취소한다 (사이드바의 줄 안 입력). 창 안의 입력은 취소하지 않는다 */
  cancelOnBlur?: boolean;
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false); // Enter·Esc 뒤에 따라오는 blur가 다시 처리하지 않게
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = () => {
    const c = checkFolderName(draft, siblings, self);
    if (!c.ok) return setError(c.error);
    finished.current = true;
    void onSubmit(c.name);
  };
  const id = `name-error-${self ?? "new"}`;
  return (
    <div className="name-input">
      <input
        ref={input}
        value={draft}
        maxLength={MAX_FOLDER_NAME + 20} // 붙여 넣은 긴 글을 잘라 버리지 않고 문장으로 알린다
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={!!error}
        aria-describedby={error ? id : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={(e) => {
          if (isImeKey(e.nativeEvent, composing.current)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finished.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (cancelOnBlur && !finished.current) {
            finished.current = true;
            onCancel();
          }
        }}
      />
      {error && (
        <p id={id} className="inline-error name-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
