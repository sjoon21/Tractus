import { useEffect, useRef, useState, type FormEvent } from "react";
import { Boxes, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageBody, PageHeader } from "@/components/ui/page";
import { Row, Section } from "@/components/ui/section";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { readTheme, saveTheme, THEME_OPTIONS, type ThemePref } from "./themePref";
import { LANG_OPTIONS, readLangPref, t, type LangPref } from "./i18n";
import { api, errDetail, errText, type McpStatus, type Settings, type VoiceList, type VoicePerson } from "./api";
import { AFTER_SETTING, afterRecord, type AfterRecord } from "./afterRecord";
import { ErrorDetail } from "./ErrorDetail";
import { CHECKUP_OPEN, MODELS_OPEN } from "./caps";
import { GateHint } from "./GatedButton";
import { useCapabilities } from "./useCapabilities";
import { BinField } from "./BinField";
import { onIndexed } from "./indexer";
import { statusLine } from "./lib";
import { LlmKeySection } from "./LlmKeySettings";
import { ObsidianSection } from "./ObsidianSettings";
import { CalendarSection } from "./CalendarSettings";
import { HELP_REPLAY, HELP_REPLAY_BUTTON, HELP_REPLAY_HINT, HELP_SECTION, HELP_TIPS, HELP_TIPS_HINT, resetOnboard } from "./onboarding";
import { readTips, resetTips, tipsOff } from "./tips";
import { TemplatesSection } from "./TemplatesSettings";
import { TRAY_KEEP_HINT, TRAY_KEEP_LABEL, TRAY_SHOW_HINT, TRAY_SHOW_LABEL } from "./trayText";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { CHECK_LABEL, INSTALL_LABEL, NOTES_LABEL, notesVersion, RELAUNCH_LABEL, RELAUNCH_WAIT, remembered, REPO_NOTE, UPDATE_HINT, updateReduce, updateText, versionLine, type UpdateEvent, type UpdateState } from "./update";

// 변환 엔진 위치는 모델 화면에서 바꾼다 (옮기기까지 함께 한다). 실행 파일 경로는 BinField (자동 / 직접 지정)
const FIELDS: { key: "home"; label: string; hint: string }[] = [{ key: "home", label: t("데이터 위치"), hint: t("노트와 녹음이 저장되는 폴더") }];
/** 저장 단추로 저장하는 값 (나머지는 바꾸면 바로 적용된다). 하나라도 바뀌면 아래 저장 줄이 나타난다 */
const FORM_KEYS = ["home", "tractus_bin", "rec_bin", "fake_recorder", "live_captions"] as const;
const LIVE_FULL = t("미리보기는 저장하지 않고, 녹음을 끝내면 정식으로 변환합니다. 메모리 16 GB 미만 Mac에서는 켜지지 않습니다.");

/** relaunchBlocked: 녹음·변환·가져오기 중(App의 idleBlockers와 같은 조건). 업데이트 절의 `다시 열기`를 잠근다 */
export function SettingsView({ onSaved, relaunchBlocked, onBack }: { onSaved: () => void; relaunchBlocked: boolean; onBack: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [base, setBase] = useState<Settings | null>(null); // 마지막으로 읽거나 저장한 값 (바뀐 것이 있는지 본다)
  const [msg, setMsg] = useState<string | null>(null);
  const [msgDetail, setMsgDetail] = useState<string | null>(null); // 저장 실패의 원래 문구(OS 사유)
  const [status, setStatus] = useState<McpStatus | { text: string; detail: string | null } | null>(null);
  const caps = useCapabilities();
  const liveGate = caps.can("live");

  useEffect(() => {
    api.getSettings().then(
      (v) => {
        setS(v);
        setBase(v);
      },
      (e) => {
        setMsg(errText(e));
        setMsgDetail(errDetail(e));
      },
    );
  }, []);

  // 스마트 검색 상태를 열어 둔 채로 문장을 고쳐 백그라운드 갱신이 끝나면 그 줄을 조용히 새로 읽는다
  const statusShown = useRef(false);
  statusShown.current = status !== null;
  useEffect(() => onIndexed(() => statusShown.current && void api.status().then(setStatus, () => {})), []);

  const checkStatus = () => {
    setStatus({ text: t("확인 중…"), detail: null });
    api.status().then(setStatus, (e) => setStatus({ text: errText(e), detail: errDetail(e) }));
  };

  // 메뉴 막대 아이콘 설정은 저장 단추를 기다리지 않고 바로 적용한다 (Rust가 아이콘을 만들거나 없앤다). 옛 설정 파일에는 값이 없고, 없으면 켜짐이다
  const trayOn = s?.tray_enabled !== false;
  const keepOn = s?.keep_in_tray !== false;
  const setTray = async (show: boolean, keep: boolean) => {
    try {
      await api.setTrayPrefs(show, keep);
      setS((cur) => cur && { ...cur, tray_enabled: show, keep_in_tray: keep });
      setMsg(null);
      setMsgDetail(null);
    } catch (err) {
      setMsg(errText(err));
      setMsgDetail(errDetail(err));
    }
  };

  // `녹음을 끝내면`도 저장 단추를 기다리지 않고 바로 저장한다 (끝낼 때 묻는 창의 `다음부터 묻지 않기`와 같은 값)
  const after = afterRecord(s?.after_record);
  const setAfter = async (value: AfterRecord) => {
    try {
      await api.setAfterRecord(value);
      setS((cur) => cur && { ...cur, after_record: value });
      setMsg(null);
      setMsgDetail(null);
    } catch (err) {
      setMsg(errText(err));
      setMsgDetail(errDetail(err));
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!s) return;
    try {
      // 코어(save_settings)가 이 화면이 고치는 칸만 저장한다: 녹음 방식·정렬처럼 다른 곳에서 바로 저장하는 값은 되돌리지 않는다
      await api.saveSettings(s);
      setBase(s);
      setMsg(t("저장했습니다."));
      setMsgDetail(null);
      onSaved();
    } catch (err) {
      setMsg(errText(err));
      setMsgDetail(errDetail(err));
    }
  };

  if (!s)
    return (
      <div className="grid h-full place-items-center p-8 text-[13px] text-muted-foreground">
        <div>
          <p className="m-0">{msg ?? t("불러오는 중…")}</p>
          <ErrorDetail detail={msgDetail} />
        </div>
      </div>
    );

  const dirty = !!base && FORM_KEYS.some((k) => s[k] !== base[k]);
  return (
    <section className="h-full overflow-y-auto" aria-label={t("설정")}>
      <PageHeader
        title={t("설정")}
        onBack={onBack}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={caps.openCheckup}>
              <Stethoscope aria-hidden />
              {CHECKUP_OPEN}
            </Button>
            <Button variant="ghost" size="sm" onClick={caps.openModels}>
              <Boxes aria-hidden />
              {MODELS_OPEN}
            </Button>
          </>
        }
      />
      <PageBody className="pb-24">
        <ThemeSection />

        <Section title={t("녹음")}>
          <Row
            label={AFTER_SETTING.label}
            hint={AFTER_SETTING.hint}
            htmlFor="after-record"
            control={
              <Select id="after-record" name="after_record" value={after} onChange={(e) => void setAfter(e.target.value as AfterRecord)}>
                {AFTER_SETTING.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            }
          />
          <Row
            label={t("녹음 중 실시간 텍스트 변환 (미리보기)")}
            hint={t("말하는 동안 미리 보여 줍니다. 메모리를 약 2 GB 더 씁니다.")}
            htmlFor="live-captions"
            control={
              <Switch
                id="live-captions"
                checked={s.live_captions}
                title={LIVE_FULL}
                aria-disabled={!liveGate.ok && !s.live_captions ? true : undefined}
                // 변환 엔진(0.6B)이 없으면 켤 수 없다. 이미 켜져 있던 것을 끄는 것은 언제나 된다. 이유는 아래 안내
                onChange={(e) => (liveGate.ok || !e.target.checked) && setS({ ...s, live_captions: e.target.checked })}
              />
            }
            below={liveGate.ok ? undefined : <GateHint gate={liveGate} className="m-0" />}
          />
        </Section>

        <LlmKeySection
          searchActions={
            <Button variant="outline" size="sm" onClick={checkStatus}>
              {t("스마트 검색 상태")}
            </Button>
          }
          searchStatus={
            status && (
              <div className="px-4 py-3 text-xs leading-relaxed text-muted-foreground tabular-nums" role="status">
                {"text" in status ? (
                  <>
                    {status.text}
                    <ErrorDetail detail={status.detail} />
                  </>
                ) : (
                  <>
                    <p className="m-0 text-[13px] text-foreground">{statusLine(status)}</p>
                    <GateHint gate={caps.can("smart-search")} className="m-0 mt-1" />
                  </>
                )}
              </div>
            )
          }
        />
        <TemplatesSection />
        <VoicesSection />

        <CalendarSection />

        <ObsidianSection initial={s} />

        <Section title={t("메뉴 막대")}>
          <Row label={TRAY_SHOW_LABEL} hint={TRAY_SHOW_HINT} htmlFor="tray-show" control={<Switch id="tray-show" checked={trayOn} onChange={(e) => void setTray(e.target.checked, keepOn)} />} />
          <Row
            label={TRAY_KEEP_LABEL}
            hint={TRAY_KEEP_HINT}
            htmlFor="tray-keep"
            className={trayOn ? undefined : "opacity-60"}
            control={<Switch id="tray-keep" checked={keepOn && trayOn} disabled={!trayOn} onChange={(e) => void setTray(trayOn, e.target.checked)} />}
          />
        </Section>

        <form id="settings-form" onSubmit={save}>
          <Section title={t("경로와 실행 파일")} description={t("개발과 문제 해결에 쓰는 설정입니다. 바꾼 뒤 저장해야 적용됩니다.")}>
            {FIELDS.map((f) => (
              <Row
                key={f.key}
                label={f.label}
                hint={f.hint}
                htmlFor={`settings-${f.key}`}
                below={<Input id={`settings-${f.key}`} className="font-mono text-xs" value={s[f.key]} onChange={(e) => setS({ ...s, [f.key]: e.target.value })} spellCheck={false} />}
              />
            ))}
            <BinField kind="tractus" value={s.tractus_bin} onChange={(v) => setS({ ...s, tractus_bin: v })} report={caps.report} />
            <BinField kind="rec" value={s.rec_bin} onChange={(v) => setS({ ...s, rec_bin: v })} report={caps.report} />
            <Row
              label={t("테스트용 모의 녹음 (가상 신호)")}
              hint={t("마이크 권한 없이 녹음 과정을 시험합니다")}
              htmlFor="fake-recorder"
              control={<Switch id="fake-recorder" checked={s.fake_recorder} onChange={(e) => setS({ ...s, fake_recorder: e.target.checked })} />}
            />
          </Section>
        </form>

        <HelpSection />

        <UpdateSection relaunchBlocked={relaunchBlocked} />
      </PageBody>

      {(dirty || msg) && (
        <div className="sticky bottom-0 z-10 border-t border-border bg-background/85 backdrop-blur-md">
          <div className="mx-auto flex max-w-[680px] items-center justify-end gap-3 px-6 py-2.5">
            <div className="mr-auto min-w-0 text-xs text-muted-foreground" role="status">
              {msg ?? t("저장하지 않은 변경 사항이 있습니다.")}
              <ErrorDetail detail={msgDetail} />
            </div>
            <Button type="submit" form="settings-form" disabled={!dirty}>
              {t("저장")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 도움말: 처음 사용 안내(체크리스트·기능 안내)를 다시 보거나 기능 안내를 끈다. 이 Mac에만 기억한다 (onboarding.ts·tips.ts) */
function HelpSection() {
  const [tipsOn, setTipsOn] = useState(() => !readTips().off);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Section title={HELP_SECTION}>
      <Row
        label={HELP_REPLAY}
        hint={msg ?? HELP_REPLAY_HINT}
        control={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetOnboard();
              resetTips();
              setTipsOn(true);
              setMsg(t("홈에서 시작하기 목록을 다시 볼 수 있습니다."));
            }}
          >
            {HELP_REPLAY_BUTTON}
          </Button>
        }
      />
      <Row
        label={HELP_TIPS}
        hint={HELP_TIPS_HINT}
        htmlFor="help-tips"
        control={
          <Switch
            id="help-tips"
            checked={tipsOn}
            onChange={(e) => {
              tipsOff(!e.target.checked);
              setTipsOn(e.target.checked);
            }}
          />
        }
      />
    </Section>
  );
}

const SEGMENT =
  "h-6 whitespace-nowrap rounded-[5px] px-3 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-xs";

/** 셋 중 하나를 고르는 칸 (테마·언어) */
function Segmented<V extends string>({ label, value, options, onPick }: { label: string; value: V; options: readonly { value: V; label: string }[]; onPick: (v: V) => void }) {
  return (
    <div className="grid grid-cols-3 gap-0.5 rounded-md bg-secondary p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onPick(o.value)} className={SEGMENT}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 화면 테마·언어: 저장 단추 없이 바로 적용한다. 테마는 이 Mac의 브라우저 저장소(themePref.ts), 언어는 settings.json(Rust i18n.rs)이고 시작할 때 정하므로 화면을 다시 연다 */
function ThemeSection() {
  const [theme, setTheme] = useState<ThemePref>(readTheme);
  const lang = readLangPref();
  const [langErr, setLangErr] = useState<string | null>(null);
  return (
    <Section title={t("화면")}>
      <Row
        label={t("테마")}
        control={
          <Segmented
            label={t("테마")}
            value={theme}
            options={THEME_OPTIONS}
            onPick={(v) => {
              saveTheme(v);
              setTheme(v);
            }}
          />
        }
      />
      <Row
        label={t("언어")}
        hint={langErr ?? t("바꾸면 앱 화면을 다시 엽니다.")}
        control={
          <Segmented<LangPref>
            label={t("언어")}
            value={lang}
            options={LANG_OPTIONS.map((o) => ({ value: o.value, label: o.label() }))}
            onPick={(v) => {
              if (v === lang) return;
              api
                .setUiLang(v)
                .then(() => location.reload())
                .catch((e) => setLangErr(t("언어를 바꾸지 못했습니다: {error}", { error: errText(e) })));
            }}
          />
        }
      />
    </Section>
  );
}

/** 업데이트 (v3.34, docs/desktop.md §3.5). 자동 설치는 없다: 확인·설치·다시 열기 모두 단추로만. 미리 만든 앱(번들)에서만 확인한다 */
function UpdateSection({ relaunchBlocked }: { relaunchBlocked: boolean }) {
  const [linkError, setLinkError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [bundle, setBundle] = useState<boolean | null>(null); // null: 아직 모른다 (단추를 그리지 않는다)
  const [st, setStRaw] = useState<UpdateState>(() => remembered.state);
  // 모듈의 상태(update.remembered)가 원본이다: 확인·받는 중에 화면을 떠나면 이 컴포넌트가 내려가 React의 setState 갱신 함수는 돌지 않으므로,
  // 거기서 줄이면 `확인 중`·`받는 중`에 멈춘 채 남아 돌아와도 단추가 영영 잠긴다. 모듈에서 줄이고 React에는 결과만 준다
  const dispatch = (ev: UpdateEvent) => setStRaw((remembered.state = updateReduce(remembered.state, ev)));
  // installed: 디스크의 앱은 이미 새 버전이라 다시 확인하면 같은 버전을 또 받게 된다. `다시 열기`만 남긴다
  const busy = st.phase === "checking" || st.phase === "downloading" || st.phase === "installed";

  useEffect(() => {
    getVersion().then(setVersion, () => setVersion("?"));
    api.updateAvailable().then(setBundle, () => setBundle(false));
  }, []);

  const onCheck = async () => {
    dispatch({ type: "check" });
    try {
      await remembered.update?.close().catch(() => {});
      const u = await check();
      remembered.update = u;
      if (u) dispatch({ type: "found", version: u.version, body: u.body });
      else dispatch({ type: "latest" });
    } catch (e) {
      dispatch({ type: "fail", error: e });
    }
  };

  const onInstall = async () => {
    const u = remembered.update;
    if (!u) return;
    dispatch({ type: "install" });
    try {
      await u.downloadAndInstall((event) => dispatch({ type: "download", event }));
      remembered.update = null;
      dispatch({ type: "installed" });
    } catch (e) {
      dispatch({ type: "fail", error: e });
    }
  };

  const text = updateText(st);
  const notesFor = notesVersion(st, version);
  const notesLink = notesFor && (
    <span className="text-xs">
      <Button variant="link" size="sm" className="text-xs" onClick={() => void api.openReleaseNotes(notesFor).then(() => setLinkError(null), (e) => setLinkError(errText(e)))}>
        {NOTES_LABEL} ({notesFor})
      </Button>
      {linkError && <span className="ml-2 text-destructive">{linkError}</span>}
    </span>
  );
  return (
    <Section title={t("업데이트")}>
      <Row
        label={<span className="tabular-nums">{versionLine(version)}</span>}
        hint={bundle === false ? REPO_NOTE : bundle ? UPDATE_HINT : undefined}
        control={
          bundle && (
            <>
              {st.phase === "found" && (
                <Button size="sm" onClick={() => void onInstall()}>
                  {INSTALL_LABEL}
                </Button>
              )}
              {st.phase === "installed" && (
                <Button size="sm" disabled={relaunchBlocked} onClick={() => void relaunch().catch((e) => dispatch({ type: "fail", error: e }))}>
                  {RELAUNCH_LABEL}
                </Button>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void onCheck()}>
                {CHECK_LABEL}
              </Button>
            </>
          )
        }
        below={
          bundle ? (
            <div className="flex flex-col gap-2">
              {text && (
                <div className="text-xs text-muted-foreground tabular-nums" role="status">
                  {text}
                  {st.phase === "installed" && relaunchBlocked && ` ${RELAUNCH_WAIT}`}
                  <ErrorDetail detail={st.phase === "error" ? st.detail : null} />
                </div>
              )}
              {st.phase === "found" && st.notes && <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-secondary px-3 py-2 font-sans text-xs leading-relaxed text-muted-foreground">{st.notes}</pre>}
              {notesLink}
            </div>
          ) : undefined
        }
      />
    </Section>
  );
}

/** 목소리 지우기 확인 문장: 이름만 굵게 (언어마다 이름 자리가 다르다) */
function forgetText(p: VoicePerson) {
  const [before, after = ""] = t("{name}의 목소리 표본 {n}개를 지웁니다. 노트에 붙인 이름은 그대로 남고, 다음 녹음부터 이 사람을 제안하지 않습니다.", { n: p.samples }).split("{name}");
  return (
    <>
      {before}
      <b className="font-semibold">{p.name}</b>
      {after}
    </>
  );
}

/** 목소리 프로필 (Phase 7.1). 지우기는 앱 안에서 한 번 더 묻는다 (window.confirm은 쓰지 않는다) */
function VoicesSection() {
  const [list, setList] = useState<VoiceList | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [asking, setAsking] = useState<VoicePerson | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.voicesList().then(setList, (e) => setMsg(errText(e)));
  useEffect(() => void load(), []);

  const forget = async (p: VoicePerson) => {
    setBusy(true);
    try {
      await api.voicesForget(p.id);
      setMsg(t("‘{name}’의 목소리를 지웠습니다.", { name: p.name }));
      setAsking(null);
      await load();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={t("참석자 목소리 프로필")}
      description={t("노트에서 참석자 이름을 바꿀 때 등록합니다. 다음 녹음부터 이름을 제안합니다. 목소리는 이 Mac에만 저장됩니다.")}
    >
      {list?.needs_reenroll && (
        <p className="m-0 bg-memo-wash px-4 py-2.5 text-xs text-memo" role="status">
          {t("목소리 인식 방식이 바뀌었습니다. 다시 등록하세요.")}
        </p>
      )}
      {!list && <p className="m-0 px-4 py-3 text-[13px] text-muted-foreground">{msg ?? t("불러오는 중…")}</p>}
      {list && list.people.length === 0 && <p className="m-0 px-4 py-3 text-[13px] text-muted-foreground">{t("아직 등록한 목소리가 없습니다.")}</p>}
      {list?.people.map((p) =>
        asking?.id === p.id ? (
          <div key={p.id} className="flex flex-wrap items-center gap-3 bg-accent/50 px-4 py-3" role="alertdialog" aria-label={t("목소리 삭제")}>
            <p className="m-0 min-w-0 flex-1 text-[13px]">
              {forgetText(asking)}
            </p>
            <div className="flex shrink-0 gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>
                {t("취소")}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void forget(asking)} disabled={busy} autoFocus>
                {t("지우기")}
              </Button>
            </div>
          </div>
        ) : (
          <Row
            key={p.id}
            label={p.name}
            hint={
              <span className="tabular-nums">
                {t("표본 {n}개", { n: p.samples })}
                {p.created_at && " · " + t("{date} 등록", { date: p.created_at.slice(0, 10) })}
              </span>
            }
            control={
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => setAsking(p)} aria-label={t("{name} 목소리 삭제", { name: p.name })}>
                {t("삭제")}
              </Button>
            }
          />
        ),
      )}
      {list && msg && (
        <p className="m-0 px-4 py-2.5 text-xs text-muted-foreground" role="status">
          {msg}
        </p>
      )}
    </Section>
  );
}
