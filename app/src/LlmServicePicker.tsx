// 요약·질문마다 쓸 AI 서비스를 고르는 작은 칸 (docs/desktop.md §2.14). 등록된 서비스만 나오고, 하나뿐이면 보이지 않는다.
// 기본은 설정의 `기본으로 사용`이고, 고른 서비스는 요약·질문 기능마다 따로 기억한다.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { PROVIDERS } from "./ask";
import { KEY_CHANGED, pickService, readChoice, showServicePicker, writeChoice, type LlmFeature } from "./llmKey";

export interface LlmServices {
  /** 이번에 쓸 서비스. 환경이 서비스를 정하거나 아직 못 읽었으면 null (코어에 맡긴다) */
  provider: string | null;
  registered: string[];
  show: boolean;
  choose: (provider: string) => void;
}

/** 등록된 서비스와 기본 서비스를 읽는다. 설정에서 키·기본 서비스를 바꾸면(KEY_CHANGED) 다시 읽는다 */
export function useLlmServices(feature: LlmFeature): LlmServices {
  const [info, setInfo] = useState<{ registered: string[]; def: string; fixed: boolean } | null>(null);
  const [remembered, setRemembered] = useState<string | null>(() => readChoice(feature));
  useEffect(() => {
    const load = () => void api.llmSettings().then((s) => setInfo({ registered: s.registered, def: s.default, fixed: s.provider_fixed }), () => setInfo(null));
    load();
    window.addEventListener(KEY_CHANGED, load);
    return () => window.removeEventListener(KEY_CHANGED, load);
  }, []);
  const choose = useCallback(
    (provider: string) => {
      writeChoice(feature, provider);
      setRemembered(provider);
    },
    [feature],
  );
  if (!info || info.fixed) return { provider: null, registered: [], show: false, choose };
  return { provider: pickService(info.registered, info.def, remembered), registered: info.registered, show: showServicePicker(info.registered, info.fixed), choose };
}

export function LlmServicePicker({ services, disabled }: { services: LlmServices; disabled?: boolean }) {
  if (!services.show) return null;
  return (
    <label className="llm-pick">
      <span>AI 서비스</span>
      <select value={services.provider ?? ""} disabled={disabled} onChange={(e) => services.choose(e.target.value)}>
        {services.registered.map((p) => (
          <option key={p} value={p}>
            {PROVIDERS[p]?.label ?? p}
          </option>
        ))}
      </select>
    </label>
  );
}
