import { Button } from "@/components/ui/button";
import { t } from "./i18n";
import { requestSettings } from "./llmKey";

/** 요약·질문 오류 옆의 `설정 열기` (AI 키가 없을 때). App이 설정 화면으로 간다 */
export function OpenSettings() {
  return (
    <Button variant="outline" size="sm" className="ml-2 h-6 px-2 align-middle" onClick={requestSettings}>
      {t("설정 열기")}
    </Button>
  );
}
