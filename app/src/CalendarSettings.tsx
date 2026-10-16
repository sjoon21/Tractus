// 설정의 캘린더 섹션 (docs/design/calendar.md): 연결(권한 요청) → 캘린더 켜고 끄기. 저장 단추 없이 바로 저장한다
import { useEffect, useState } from "react";
import { api, errText, type CalendarStatus } from "./api";
import { Button } from "@/components/ui/button";
import { Row, Section } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { CAL_CONNECT, CAL_CONNECT_HINT, CAL_DENIED, CAL_DISCONNECT, CAL_LIST_HINT, CAL_NO_PROMPT, CAL_PRIVACY, CAL_SECTION } from "./calendar";

export function CalendarSection() {
  const [st, setSt] = useState<CalendarStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noPrompt, setNoPrompt] = useState(false); // 요청했는데 여전히 묻지 않은 상태: 안내와 시스템 설정 단추
  const load = () => api.calendarStatus().then(setSt, (e) => setErr(errText(e)));
  useEffect(() => void load(), []);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      setErr(null);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = !!st?.enabled && st.access === "granted";
  const denied = st?.access === "denied" || st?.access === "restricted" || st?.access === "write_only";
  return (
    <Section
      title={CAL_SECTION}
      description={connected ? CAL_LIST_HINT : CAL_CONNECT_HINT}
      actions={
        connected ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => api.calendarSet(false, st.hidden))}>
            {CAL_DISCONNECT}
          </Button>
        ) : undefined
      }
    >
      {!connected && (
        <Row
          label={denied ? CAL_DENIED : CAL_CONNECT}
          control={
            denied ? (
              <Button variant="outline" size="sm" onClick={() => void run(() => api.calendarPrivacy())}>
                {CAL_PRIVACY}
              </Button>
            ) : (
              <span className="flex items-center gap-1.5">
                {noPrompt && (
                  <Button variant="outline" size="sm" onClick={() => void run(() => api.calendarPrivacy())}>
                    {CAL_PRIVACY}
                  </Button>
                )}
                <Button size="sm" disabled={busy || !st} onClick={() => void run(async () => setNoPrompt((await api.calendarConnect()) === "undetermined"))}>
                  {CAL_CONNECT}
                </Button>
              </span>
            )
          }
          below={err || (noPrompt && !denied) ? <p className="m-0 text-xs text-destructive" role="alert">{err ?? CAL_NO_PROMPT}</p> : undefined}
        />
      )}
      {connected &&
        st.calendars.map((c) => {
          const on = !st.hidden.includes(c.id);
          return (
            <Row
              key={c.id}
              label={c.title}
              hint={c.source}
              htmlFor={`cal-${c.id}`}
              control={
                <Switch
                  id={`cal-${c.id}`}
                  checked={on}
                  disabled={busy}
                  onChange={(e) => void run(() => api.calendarSet(true, e.target.checked ? st.hidden.filter((x) => x !== c.id) : [...st.hidden, c.id]))}
                />
              }
            />
          );
        })}
      {connected && err && <p className="m-0 px-4 py-3 text-xs text-destructive" role="alert">{err}</p>}
    </Section>
  );
}
