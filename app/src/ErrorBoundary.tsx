// 화면을 그리다 오류가 나면 흰 창 대신 짧은 안내와 `다시 불러오기`를 보인다 (WebView2·WKWebView 공통). 노트는 디스크에 있어 다시 불러와도 잃지 않는다.
// 원래 오류는 접힌 `자세히`에만 둔다(ErrorDetail). 시험: ErrorBoundary.test.tsx
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./components/ui/button";
import { Empty } from "./components/ui/empty";
import { ErrorDetail } from "./ErrorDetail";
import { t } from "./i18n";

export class ErrorBoundary extends Component<{ children: ReactNode; onReload?: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const reload = this.props.onReload ?? (() => location.reload());
    return (
      <main role="alert" className="flex min-h-screen flex-col items-center justify-center bg-background text-foreground">
        <Empty
          title={t("화면을 그리지 못했습니다")}
          action={
            <Button variant="default" onClick={reload}>
              {t("다시 불러오기")}
            </Button>
          }
        >
          {t("다시 불러오면 대부분 해결됩니다. 노트는 그대로 있습니다.")}
        </Empty>
        <div className="w-full max-w-md px-4">
          <ErrorDetail detail={error.stack || String(error)} />
        </div>
      </main>
    );
  }
}
