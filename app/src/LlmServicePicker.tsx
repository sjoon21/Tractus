// 요약·질문마다 쓸 AI 서비스를 고르는 단추와 메뉴 (docs/desktop.md §2.14, shadcn AI Elements의 Model Selector 모양). 등록된 서비스만 나오고, 하나뿐이면 보이지 않는다.
// 기본은 설정의 `기본으로 사용`이고, 고른 서비스는 요약·질문 기능마다 따로 기억한다. 칸 이름(`AI 서비스`)은 화면에 쓰지 않고 aria-label로만 말한다.
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { MENU, MENU_ITEM } from "@/components/menu";
import { cn } from "@/components/ui/utils";
import { Popover } from "./Popover";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { api } from "./api";
import { t } from "./i18n";
import { PROVIDERS } from "./ask";
import { KEY_CHANGED, pickService, readChoice, showServicePicker, writeChoice, type LlmFeature } from "./llmKey";

export interface LlmServices {
  /** 이번에 쓸 서비스. 환경이 서비스를 정하거나 아직 못 읽었으면 null (코어에 맡긴다) */
  provider: string | null;
  registered: string[];
  /** 서비스마다 설정에 저장한 AI 모델 (비면 서비스 기본값) */
  models: Record<string, string>;
  show: boolean;
  choose: (provider: string) => void;
}

/** 등록된 서비스와 기본 서비스를 읽는다. 설정에서 키·기본 서비스를 바꾸면(KEY_CHANGED) 다시 읽는다 */
export function useLlmServices(feature: LlmFeature): LlmServices {
  const [info, setInfo] = useState<{ registered: string[]; def: string; fixed: boolean; models: Record<string, string> } | null>(null);
  const [remembered, setRemembered] = useState<string | null>(() => readChoice(feature));
  useEffect(() => {
    const load = () =>
      void api.llmSettings().then(
        (s) => setInfo({ registered: s.registered, def: s.default, fixed: s.provider_fixed, models: Object.fromEntries(Object.entries(s.profiles ?? {}).map(([k, v]) => [k, v.model])) }),
        () => setInfo(null),
      );
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
  if (!info || info.fixed) return { provider: null, registered: [], models: {}, show: false, choose };
  return { provider: pickService(info.registered, info.def, remembered), registered: info.registered, models: info.models, show: showServicePicker(info.registered, info.fixed), choose };
}

const label = (p: string) => PROVIDERS[p]?.label ?? p;
const modelOf = (services: LlmServices, p: string) => services.models[p] || PROVIDERS[p]?.model || "";

const Mark = ({ p }: { p: string }) => <ProviderLogo provider={p} />;

export function LlmServicePicker({ services, disabled, className }: { services: LlmServices; disabled?: boolean; className?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!services.show) return null;
  const now = services.provider ?? "";
  return (
    <>
      <button
        type="button"
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-45 aria-expanded:bg-accent aria-expanded:text-foreground",
          className,
        )}
        aria-label={t("AI 서비스: {name}", { name: label(now) })}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        disabled={disabled}
        onClick={(e) => setAnchor((a) => (a ? null : e.currentTarget))}
      >
        <Mark p={now} />
        <span className="truncate">{label(now)}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
      </button>
      {anchor && (
        <Popover anchor={anchor} label={t("AI 서비스")} align="start" onClose={() => setAnchor(null)}>
          {(close) => (
            <div className={cn(MENU, "border-0 p-0 shadow-none")} role="none">
              {services.registered.map((p, i) => (
                <button
                  key={p}
                  type="button"
                  role="menuitemradio"
                  aria-checked={p === now}
                  autoFocus={p === now || (!now && i === 0)}
                  className={cn(MENU_ITEM, "h-auto py-1.5")}
                  onKeyDown={(e) => {
                    const items = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
                    const at = items.indexOf(e.currentTarget);
                    const to = e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length : -1;
                    if (to < 0) return;
                    e.preventDefault();
                    items[to]?.focus();
                  }}
                  onClick={() => {
                    services.choose(p);
                    close(true);
                  }}
                >
                  <Mark p={p} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{label(p)}</span>
                    {modelOf(services, p) && <span className="truncate text-[11px] text-subtle-foreground">{modelOf(services, p)}</span>}
                  </span>
                  <Check className={cn("size-4 shrink-0", p === now ? "opacity-100" : "opacity-0")} aria-hidden />
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
    </>
  );
}
