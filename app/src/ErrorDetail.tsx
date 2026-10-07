// 코어의 원래 오류 문구는 접힌 '자세히' 안에만 둔다 (WORDS.md §4.7). 화면 문장은 lib.errorView·warningText가 만든다.

export function ErrorDetail({ detail }: { detail: string | null | undefined }) {
  if (!detail) return null;
  return (
    <details className="error-detail">
      <summary>자세히</summary>
      <pre>{detail}</pre>
    </details>
  );
}
