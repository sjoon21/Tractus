// 모델 화면 (docs/desktop.md §2.15): 구성 단추, 모델 표(이름·용도·크기·필수/권장/선택·상태·이 기능에 필요), 받기 진행, 지우기.
// 시작 점검(Checkup.tsx)도 구성 단추와 진행 표시를 같이 쓴다. 문구는 WORDS.md §4.14.
import { AlertTriangle, CheckCircle2, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { OK_BADGE, OK_TEXT, WARN_TEXT } from "@/components/settings/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageBody, PageHeader } from "@/components/ui/page";
import { Progress } from "@/components/ui/progress";
import { Row, Section } from "@/components/ui/section";
import { Select } from "@/components/ui/select";
import { cn } from "@/components/ui/utils";
import { api, errDetail, errText } from "./api";
import { trackOf } from "./caps";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorDetail } from "./ErrorDetail";
import { t } from "./i18n";
import { warningText } from "./lib";
import { KEY_CHANGED } from "./llmKey";
import {
  capChip,
  diskShort,
  downloadErrorView,
  DOWNLOAD_DONE,
  DOWNLOAD_STOPPED,
  fmtBytes,
  installedSummary,
  installLabel,
  engineSummary,
  engineAdded,
  engineChosen,
  engineInUse,
  ENGINE_ADD,
  ENGINE_ADD_HINT,
  ENGINE_ADD_PLACEHOLDER,
  ENGINE_ADD_TITLE,
  ENGINE_AUTO_CHOSEN,
  ENGINE_AUTO_OPTION,
  ENGINE_IN_USE,
  ENGINE_NONE_INSTALLED,
  ENGINE_PICK_HINT,
  ENGINE_PICK_LABEL,
  ENGINE_PICK_TITLE,
  engineAutoOption,
  engineNowUsing,
  validRepo,
  levelLabel,
  moveDialog,
  moveDone,
  movable,
  pruneDialog,
  pruneDone,
  pruneLabel,
  unregisteredSummary,
  modelDetailRows,
  modelSubtitle,
  MODEL_DETAIL_LABEL,
  MODEL_FULL_REVISION_LABEL,
  type DetailRow,
  overallFraction,
  planOf,
  planSize,
  presetIds,
  PRESETS,
  progressLine,
  removeDialog,
  STATE_LABEL,
  toInstall,
  corruptIn,
  type DownloadState,
  type ModelRow,
  type ModelsList,
  type PlanItem,
  type Preset,
} from "./models";
import { cancelDownload, startDownload, useDownload } from "./modelsJob";
import { patchSettings, pickPath } from "./pathFix";
import { useCapabilities } from "./useCapabilities";

const LIST_FAILED = t("모델 목록을 읽지 못했습니다");
const EXTERNAL_POLL_MS = 4000;
const EXTERNAL_NOTICE = t("다른 곳(터미널 등)에서 모델을 받는 중입니다. 끝나면 이 화면이 새로 고쳐집니다.");

/** 모델 목록을 읽는다. 받기가 끝나면 다시 읽는다 */
export function useModelsList() {
  const [list, setList] = useState<ModelsList | null>(null);
  const [error, setError] = useState<{ text: string; detail: string | null } | null>(null);
  const dl = useDownload();
  const load = useCallback(
    () =>
      api.modelsList().then(
        (l) => {
          setList(l);
          setError(null);
        },
        (e) => setError({ text: errText(e) || LIST_FAILED, detail: errDetail(e) }),
      ),
    [],
  );
  useEffect(() => void load(), [load]);
  const was = useRef(dl.running);
  useEffect(() => {
    if (was.current && !dl.running) void load();
    was.current = dl.running;
  }, [dl.running, load]);
  // 다른 곳(터미널)이 받는 중이면 끝날 때까지 가끔 다시 읽는다
  const external = !!list?.download_active && !dl.running;
  useEffect(() => {
    if (!external) return;
    const timer = setTimeout(() => void load(), EXTERNAL_POLL_MS);
    return () => clearTimeout(timer);
  }, [external, list, load]);
  return { list, error, load, dl, external };
}

/** 구성에 손상된 모델이 있으면 먼저 지운다 (코어는 손상된 모델 받기를 거부하고, 지우기는 `models remove`로만 한다) */
async function startPreset(plan: PlanItem[], models: ModelRow[]): Promise<void> {
  try {
    for (const id of corruptIn(plan.map((p) => p.id), models)) await api.modelsRemove(id);
  } catch {
    // 지우지 못해도 받기를 시도한다: 코어가 이유를 알려 준다
  }
  await startDownload(plan);
}

/** 구성 단추 세 개. 이미 받은 모델은 빼고 남은 것만 받는다 */
export function PresetButtons({ list, dl }: { list: ModelsList; dl: DownloadState }) {
  const busy = dl.running || list.download_active;
  const { report } = useCapabilities();
  const track = report?.doctor?.recommended_track;
  const free = list.disk_free_bytes;
  return (
    <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label={t("모델 구성")}>
      {PRESETS.map((p) => {
        const plan = planOf(toInstall(presetIds(p.id as Preset, list.models, track), list.models), list.models);
        const short = diskShort(plan, free);
        const done = plan.length === 0;
        const main = p.id === "standard" && trackOf(track) === "std";
        return (
          <div key={p.id} className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-3">
            <Button variant={main ? "default" : "outline"} size="sm" disabled={busy || done || !!short} onClick={() => void startPreset(plan, list.models)}>
              {p.label}
              <span className={cn("text-[11px] font-normal tabular-nums", main ? "opacity-70" : "text-muted-foreground")}>{done ? t("설치됨") : t("약 {size}", { size: fmtBytes(planSize(plan)) })}</span>
            </Button>
            <p className={cn("m-0 text-xs leading-relaxed", short ? WARN_TEXT : "text-muted-foreground")}>{short ?? p.note}</p>
          </div>
        );
      })}
    </div>
  );
}

/** 받기 진행·결과. 받는 중이면 멈추기, 끝나면 결과 한 줄, 실패하면 문장과 자세히 */
export function DownloadPanel({ dl }: { dl: DownloadState }) {
  const frac = overallFraction(dl);
  const err = dl.error ? downloadErrorView(dl.error) : null;
  const idle = !dl.running && !dl.completed && !dl.stopped && !err && dl.warnings.length === 0;
  if (idle) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 text-xs" aria-live="polite">
      {dl.running && (
        <div className="flex items-center gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="m-0 flex justify-between gap-3 text-[13px] tabular-nums">
              <span className="min-w-0 truncate">{progressLine(dl)}</span>
              {frac !== null && <span className="text-muted-foreground">{Math.round(frac * 100)}%</span>}
            </p>
            <div role="progressbar" aria-label={t("모델 받기 진행률")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={frac === null ? undefined : Math.round(frac * 100)}>
              <Progress value={frac} />
            </div>
            {dl.file && <p className="m-0 truncate text-muted-foreground tabular-nums">{dl.file}</p>}
          </div>
          <Button variant="outline" size="sm" disabled={dl.cancelling} onClick={cancelDownload}>
            {t("멈추기")}
          </Button>
        </div>
      )}
      {!dl.running && dl.completed && (
        <p className={cn("m-0 flex items-center gap-1.5 text-[13px]", OK_TEXT)}>
          <CheckCircle2 className="size-4" aria-hidden />
          {DOWNLOAD_DONE}
        </p>
      )}
      {!dl.running && dl.stopped && <p className="m-0 text-muted-foreground">{DOWNLOAD_STOPPED}</p>}
      {dl.warnings.map((w, i) => (
        <p key={`${w.code}${i}`} className={cn("m-0", WARN_TEXT)} role="status">
          {warningText(w)}
        </p>
      ))}
      {err && (
        <div className="text-destructive" role="alert">
          {err.text}
          <ErrorDetail detail={err.detail} />
        </div>
      )}
    </div>
  );
}

/** 이름 아래 한 줄: 이 모델이 무엇인지 (옛 코어면 아무것도 보이지 않는다) */
function ModelSubtitle({ m }: { m: ModelRow }) {
  const subtitle = modelSubtitle(m);
  return subtitle ? <span className="block text-xs text-subtle-foreground">{subtitle}</span> : null;
}

/** 접힌 자세히. 표 읽기 도우미가 행 머리글로 읽지 않도록 이름 칸이 아니라 행 아래 칸에 둔다 */
function ModelDetails({ m, rows }: { m: ModelRow; rows: DetailRow[] }) {
  return (
    <details className="mt-2">
      <summary aria-label={t("{name} 자세히", { name: m.name })} className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        {MODEL_DETAIL_LABEL}
      </summary>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-secondary px-3 py-2 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="m-0 min-w-0 break-words" title={r.title}>
              {r.value}
              {r.title && <span className="sr-only">{` (${MODEL_FULL_REVISION_LABEL} ${r.title})`}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

const STATE_TONE: Record<ModelRow["state"], string> = { installed: OK_BADGE, missing: "", partial: "bg-memo-wash text-memo", corrupt: "bg-rec-wash text-rec" };

/** 스마트 검색에 쓰는 이 Mac의 모델 ID (코어 models_registry) */
const EMBEDDING_ID = "embedding";
const NOT_IN_USE = t("사용하지 않음");

/** 스마트 검색을 Upstage로 쓰는 중인가 (그러면 이 Mac의 검색 모델은 쓰지 않는다). 설정에서 바꾸면 다시 읽는다 */
function useViaUpstage(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const load = () => void api.getSettings().then((s) => setOn(s.embedding_provider === "upstage"), () => setOn(false));
    load();
    window.addEventListener(KEY_CHANGED, load);
    return () => window.removeEventListener(KEY_CHANGED, load);
  }, []);
  return on;
}

const needsHelperNote = (m: ModelRow, helperFound: boolean | undefined) => m.id === "fluid" && helperFound === false;

export function ModelsView({ onBack }: { onBack: () => void }) {
  const { list, error, load, dl, external } = useModelsList();
  const busy = dl.running || external;
  const caps = useCapabilities();
  const [asking, setAsking] = useState<ModelRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [folderAsk, setFolderAsk] = useState<{ kind: "move"; dest: string } | { kind: "prune" } | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; detail: string | null; error?: boolean } | null>(null);
  const helperFound = caps.report?.doctor?.tools.diar_helper.found;
  const viaUpstage = useViaUpstage();
  // 기본 변환 엔진 (docs/design/asr-engines.md): 비면 자동. 변환할 때 Rust가 `--engine`으로 넘긴다
  const [asrEngine, setAsrEngine] = useState<string | null>(null);
  useEffect(() => void api.getSettings().then((st) => setAsrEngine(st.asr_engine || null), () => setAsrEngine(null)), []);
  const [repo, setRepo] = useState("");
  const [adding, setAdding] = useState(false);
  const inUse = list ? engineInUse(list.models, asrEngine, caps.report?.doctor?.recommended_track) : null;
  // 드롭다운: 받아 둔 엔진만 고를 수 있다(받지 않은 엔진은 아래 목록에서 받으면 나타난다). 빈 값 = 자동
  const engines = list ? list.models.filter((m) => m.engine && m.installed) : [];
  const autoEngine = list ? list.models.find((m) => m.id === engineInUse(list.models, null, caps.report?.doctor?.recommended_track)) : undefined;
  const pickValue = asrEngine && engines.some((m) => m.id === asrEngine) ? asrEngine : "";
  const choose = async (m: ModelRow | null) => {
    try {
      await api.setAsrEngine(m?.id ?? null);
      setAsrEngine(m?.id ?? null);
      setMsg({ text: m ? engineChosen(m.name) : ENGINE_AUTO_CHOSEN, detail: null });
    } catch (e) {
      setMsg({ text: errText(e), detail: errDetail(e), error: true });
    }
  };
  const addEngine = async () => {
    const r = repo.trim();
    if (!validRepo(r)) return;
    setAdding(true);
    setMsg(null);
    try {
      await api.modelsAdd(r);
      setRepo("");
      setMsg({ text: engineAdded(r), detail: null });
      await changed();
    } catch (e) {
      setMsg({ text: errText(e), detail: errDetail(e), error: true });
    } finally {
      setAdding(false);
    }
  };

  const changed = async () => {
    await load();
    await caps.refresh();
  };

  const install = (m: ModelRow) => {
    if (!list) return;
    setMsg(null);
    void startDownload(planOf([m.id], list.models));
  };
  // 손상된 모델은 지우고 새로 받는다 (코어는 지우는 일을 `models remove`로만 한다)
  const reinstall = async (m: ModelRow) => {
    if (!list) return;
    setMsg(null);
    try {
      await api.modelsRemove(m.id);
      await changed();
      void startDownload(planOf([m.id], list.models));
    } catch (e) {
      setMsg({ text: errText(e), detail: errDetail(e), error: true });
    }
  };
  const remove = async (m: ModelRow) => {
    setRemoving(true);
    try {
      await api.modelsRemove(m.id);
      setMsg({ text: t("‘{name}’을(를) 삭제했습니다.", { name: m.name }), detail: null });
      await changed();
    } catch (e) {
      setMsg({ text: errText(e), detail: errDetail(e), error: true });
    } finally {
      setAsking(null);
      setRemoving(false);
    }
  };

  // 모델 폴더 위치 바꾸기(옮기기 포함)와 사용하지 않는 폴더 정리. 옮기기가 먼저 돌고, 성공해야 설정(models_dir)을 바꾼다
  // ponytail: 옮기다 중간에 실패하면 일부만 옮겨진 채 남는다. 설정은 그대로라 다시 하면 남은 것만 옮긴다
  const runFolder = async (ask: NonNullable<typeof folderAsk>) => {
    setFolderBusy(true);
    try {
      if (ask.kind === "move") {
        const r = await api.modelsMove(ask.dest);
        await patchSettings({ models_dir: ask.dest });
        setMsg({ text: moveDone(r.moved.length), detail: null });
      } else {
        const r = await api.modelsPrune();
        setMsg({ text: pruneDone(r.removed.length, r.freed_bytes), detail: null });
      }
      await changed();
    } catch (e) {
      setMsg({ text: errText(e), detail: errDetail(e), error: true });
    } finally {
      setFolderAsk(null);
      setFolderBusy(false);
    }
  };
  const chooseFolder = async () => {
    const dest = await pickPath(true);
    if (!dest || !list) return;
    setMsg(null);
    // 옮길 모델이 없으면 묻지 않고 바로 바꾼다
    if (movable(list.models).count === 0) void runFolder({ kind: "move", dest });
    else setFolderAsk({ kind: "move", dest });
  };
  const unused = unregisteredSummary(list);
  const folderDialog = folderAsk && list ? (folderAsk.kind === "move" ? moveDialog(folderAsk.dest, movable(list.models)) : unused && pruneDialog(unused)) : null;

  const sum = list ? installedSummary(list.models) : null;
  const engine = list ? engineSummary(list.models) : null;
  const dialog = asking && removeDialog(asking);
  return (
    <section className="h-full overflow-y-auto" aria-labelledby="models-title">
      <PageHeader title={t("모델")} onBack={onBack} />
      <PageBody wide>
        <div className="flex flex-col gap-1 px-1">
          <h2 id="models-title" className="m-0 text-[13px] font-semibold">
            {t("모델과 기능")}
          </h2>
          <p className="m-0 max-w-[640px] text-xs leading-relaxed text-muted-foreground">
            {t("음성 인식과 참석자 구분 같은 기능은 이 Mac에 받아 두는 모델 파일로 돕니다. 필수 모델만 있어도 녹음하고 텍스트로 바꾸고 요약할 수 있습니다. 나머지는 필요한 기능만 설치하세요. 없는 모델이 필요한 단추는 이유를 알려 주고 이 화면으로 안내합니다.")}
          </p>
        </div>

        {error && (
          <div className="text-xs text-destructive" role="alert">
            {error.text}
            <ErrorDetail detail={error.detail} />
          </div>
        )}

        <Section title={t("모델 폴더")}>
          <Row
            label={list ? <code className="block truncate font-mono text-xs" title={list.models_dir}>{list.models_dir}</code> : !error && <span className="text-muted-foreground">{t("불러오는 중…")}</span>}
            hint={
              list && (
                <span className="tabular-nums">
                  {t("디스크 여유 {size}", { size: fmtBytes(list.disk_free_bytes) })}
                  {sum && " · " + t("설치됨 {installed}/{total}개 ({size})", { installed: sum.installed, total: sum.total, size: fmtBytes(sum.bytes) })}
                </span>
              )
            }
            control={
              list && (
                <>
                  {unused && (
                    <Button variant="ghost" size="sm" disabled={busy || folderBusy} onClick={() => setFolderAsk({ kind: "prune" })}>
                      {pruneLabel(unused)}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" disabled={busy || folderBusy} onClick={() => void chooseFolder()}>
                    <FolderOpen aria-hidden />
                    {t("위치 바꾸기…")}
                  </Button>
                </>
              )
            }
          />
          {engine && (
            <p className={cn("m-0 flex items-center gap-2 px-4 py-2.5 text-[13px]", engine.ok ? "text-foreground" : WARN_TEXT)} role="status">
              {engine.ok ? <CheckCircle2 className={cn("size-4 shrink-0", OK_TEXT)} aria-hidden /> : <AlertTriangle className="size-4 shrink-0" aria-hidden />}
              {engine.text}
            </p>
          )}
        </Section>

        {external && (
          <p className="m-0 px-1 text-xs text-muted-foreground" role="status">
            {EXTERNAL_NOTICE}
          </p>
        )}

        {list && (
          <Section title={ENGINE_PICK_TITLE}>
            <Row
              htmlFor="asr-engine"
              label={ENGINE_PICK_LABEL}
              hint={inUse ? engineNowUsing(list.models.find((m) => m.id === inUse)?.name ?? inUse) + " " + ENGINE_PICK_HINT : ENGINE_NONE_INSTALLED}
              control={
                <Select id="asr-engine" className="max-w-[18rem]" value={pickValue} disabled={busy || engines.length === 0} aria-label={ENGINE_PICK_TITLE} onChange={(e) => void choose(engines.find((m) => m.id === e.target.value) ?? null)}>
                  <option value="">{autoEngine ? engineAutoOption(autoEngine.name) : ENGINE_AUTO_OPTION}</option>
                  {engines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              }
            />
          </Section>
        )}

        {list && (
          <section className="flex flex-col gap-2" aria-label={t("모델 구성")}>
            <h2 className="m-0 px-1 text-[13px] font-semibold">{t("모델 구성")}</h2>
            <PresetButtons list={list} dl={dl} />
            <DownloadPanel dl={dl} />
          </section>
        )}
        {msg && (
          <div className={cn("px-1 text-xs", msg.error ? "text-destructive" : "text-muted-foreground")} role={msg.error ? "alert" : "status"}>
            {msg.text}
            <ErrorDetail detail={msg.detail} />
          </div>
        )}

        {list && (
          <Section title={t("모델 목록")}>
            {list.models.map((m) => {
              const detailRows = modelDetailRows(m);
              const unusedHere = m.id === EMBEDDING_ID && viaUpstage;
              return (
                <article key={m.id} className="px-4 py-3" aria-label={m.name}>
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium">{m.name}</span>
                        <Badge variant="outline" className={cn(m.level === "required" && "border-border-strong text-foreground")}>
                          {levelLabel(m)}
                        </Badge>
                      </div>
                      <ModelSubtitle m={m} />
                      <p className="m-0 mt-1 text-xs leading-relaxed text-muted-foreground">{m.purpose}</p>
                      {needsHelperNote(m, helperFound) && <p className={cn("m-0 mt-1 text-xs leading-relaxed", WARN_TEXT)}>{t("먼저 recorder/diar 폴더에서 swift build -c release로 tractus-diar를 만들어야 합니다.")}</p>}
                      <ul className="m-0 mt-2 flex list-none flex-wrap gap-1 p-0" aria-label={t("{name}이(가) 필요한 기능", { name: m.name })}>
                        {m.needed_by.length === 0 && <li className="text-xs text-subtle-foreground">—</li>}
                        {m.needed_by.map((c) => (
                          <li key={c}>
                            <Badge>{capChip(c)}</Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {m.state === "partial" && m.installed_bytes > 0 ? t("{size} 받음", { size: fmtBytes(m.installed_bytes) }) + " / " : ""}
                          {fmtBytes(m.size_bytes)}
                        </span>
                        {m.engine && m.id === inUse && <Badge className={OK_BADGE}>{ENGINE_IN_USE}</Badge>}
                        {unusedHere ? (
                          <Badge>{NOT_IN_USE}</Badge>
                        ) : (
                          <Badge variant={m.state === "missing" ? "outline" : "default"} className={STATE_TONE[m.state]}>
                            {STATE_LABEL[m.state]}
                          </Badge>
                        )}
                      </div>
                      {(m.state !== "installed" && !unusedHere) || m.state !== "missing" ? (
                        <div className="flex items-center gap-1">
                          {m.state !== "missing" && (
                            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy || removing} onClick={() => setAsking(m)} aria-label={t("{name} 삭제", { name: m.name })}>
                              {t("삭제")}
                            </Button>
                          )}
                          {m.state !== "installed" && !unusedHere && (
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => (m.state === "corrupt" ? void reinstall(m) : install(m))}>
                              {installLabel(m.state)}
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {detailRows.length > 0 && <ModelDetails m={m} rows={detailRows} />}
                </article>
              );
            })}
          </Section>
        )}

        {list && (
          <Section title={ENGINE_ADD_TITLE}>
            <form
              className="flex flex-col gap-2 px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                void addEngine();
              }}
            >
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">{ENGINE_ADD_HINT}</p>
              <div className="flex items-center gap-2">
                <Input className="max-w-md font-mono text-xs" value={repo} placeholder={ENGINE_ADD_PLACEHOLDER} aria-label={ENGINE_ADD_TITLE} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(e) => setRepo(e.target.value)} disabled={adding || busy} />
                <Button type="submit" variant="outline" size="sm" disabled={adding || busy || !validRepo(repo)}>
                  {ENGINE_ADD}
                </Button>
              </div>
            </form>
          </Section>
        )}
      </PageBody>
      {folderAsk && folderDialog && (
        <ConfirmDialog title={folderDialog.title} body={folderDialog.body} cancelLabel={folderDialog.cancel} confirmLabel={folderDialog.confirm} busy={folderBusy} onCancel={() => setFolderAsk(null)} onConfirm={() => void runFolder(folderAsk)} />
      )}
      {asking && dialog && (
        <ConfirmDialog title={dialog.title} body={dialog.body} cancelLabel={dialog.cancel} confirmLabel={dialog.confirm} busy={removing} onCancel={() => setAsking(null)} onConfirm={() => void remove(asking)} />
      )}
    </section>
  );
}
