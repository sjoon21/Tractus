// 코어의 원래 오류 문구는 접힌 '자세히' 안에만 둔다 (WORDS.md §4.7). 화면 문장은 lib.errorView·warningText가 만든다.

import { t } from "./i18n";

export function ErrorDetail({ detail }: { detail: string | null | undefined }) {
  if (!detail) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">{t("자세히")}</summary>
      <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-muted p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{detail}</pre>
    </details>
  );
}
