// 모델 화면 (docs/desktop.md §2.15): 구성 단추, 모델 표(이름·용도·크기·필수/권장/선택·상태·이 기능에 필요), 받기 진행, 지우기.
// 시작 점검(Checkup.tsx)도 구성 단추와 진행 표시를 같이 쓴다. 문구는 WORDS.md §4.14.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, errDetail, errText } from "./api";
import { trackOf } from "./caps";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorDetail } from "./ErrorDetail";
import { warningText } from "./lib";
import {
  capChip,
  diskShort,
  downloadErrorView,
  DOWNLOAD_DONE,
  DOWNLOAD_STOPPED,
  fmtBytes,
  installedSummary,
  installLabel,
  LEVEL_LABEL,
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
import { useCapabilities } from "./useCapabilities";

const LIST_FAILED = "모델 목록을 읽지 못했습니다";
const EXTERNAL_POLL_MS = 4000;
const EXTERNAL_NOTICE = "다른 곳(터미널 등)에서 모델을 받는 중입니다. 끝나면 이 화면이 새로 고쳐집니다.";

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
    const t = setTimeout(() => void load(), EXTERNAL_POLL_MS);
    return () => clearTimeout(t);
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
    <div className="preset-row" role="group" aria-label="모델 구성">
      {PRESETS.map((p) => {
        const plan = planOf(toInstall(presetIds(p.id as Preset, list.models, track), list.models), list.models);
        const short = diskShort(plan, free);
        const done = plan.length === 0;
        return (
          <div key={p.id} className="preset">
            <button
              type="button"
              className={p.id === "standard" && trackOf(track) === "std" ? "primary-button" : "ghost-button"}
              disabled={busy || done || !!short}
              onClick={() => void startPreset(plan, list.models)}
            >
              {p.label}
              <span className="preset-size tnum">{done ? "설치됨" : `약 ${fmtBytes(planSize(plan))}`}</span>
            </button>
            <p className="field-hint">{short ?? p.note}</p>
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
    <div className="download-panel" aria-live="polite">
      {dl.running && (
        <>
          <p className="download-line tnum">
            <span>{progressLine(dl)}</span>
            {frac !== null && <span>{Math.round(frac * 100)}%</span>}
          </p>
          <div className="job-track" role="progressbar" aria-label="모델 받기 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={frac === null ? undefined : Math.round(frac * 100)}>
            <div className={`job-fill ${frac === null ? "is-indeterminate" : ""}`} style={{ transform: `scaleX(${frac ?? 1})` }} />
          </div>
          {dl.file && <p className="field-hint tnum">{dl.file}</p>}
          <button type="button" className="ghost-button" disabled={dl.cancelling} onClick={cancelDownload}>
            멈추기
          </button>
        </>
      )}
      {!dl.running && dl.completed && <p className="download-ok">{DOWNLOAD_DONE}</p>}
      {!dl.running && dl.stopped && <p className="field-hint">{DOWNLOAD_STOPPED}</p>}
      {dl.warnings.map((w, i) => (
        <p key={`${w.code}${i}`} className="record-warning" role="status">
          {warningText(w)}
        </p>
      ))}
      {err && (
        <div className="inline-error" role="alert">
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
  return subtitle ? <span className="models-subtitle">{subtitle}</span> : null;
}

/** 접힌 자세히. 표 읽기 도우미가 행 머리글로 읽지 않도록 이름 칸이 아니라 행 아래 칸에 둔다 */
function ModelDetails({ m, rows }: { m: ModelRow; rows: DetailRow[] }) {
  return (
    <details className="models-more">
      <summary aria-label={`${m.name} ${MODEL_DETAIL_LABEL}`}>{MODEL_DETAIL_LABEL}</summary>
      <dl className="models-facts">
        {rows.map((r) => (
          <div key={r.label} className="models-fact">
            <dt>{r.label}</dt>
            <dd title={r.title}>
              {r.value}
              {r.title && <span className="sr-only">{` (${MODEL_FULL_REVISION_LABEL} ${r.title})`}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

const needsHelperNote = (m: ModelRow, helperFound: boolean | undefined) => m.id === "fluid" && helperFound === false;

export function ModelsView() {
  const { list, error, load, dl, external } = useModelsList();
  const busy = dl.running || external;
  const caps = useCapabilities();
  const [asking, setAsking] = useState<ModelRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; detail: string | null; error?: boolean } | null>(null);
  const helperFound = caps.report?.doctor?.tools.diar_helper.found;

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
      setMsg({ text: `‘${m.name}’을(를) 삭제했습니다.`, detail: null });
      await changed();
    } catch (e) {
      setMsg({ text: errText(e), detail: errDetail(e), error: true });
    } finally {
      setAsking(null);
      setRemoving(false);
    }
  };

  const sum = list ? installedSummary(list.models) : null;
  const dialog = asking && removeDialog(asking);
  return (
    <section className="settings models" aria-labelledby="models-title">
      <p className="eyebrow">모델</p>
      <h1 id="models-title">모델과 기능</h1>
      <p className="field-hint models-lead">
        음성 인식과 참석자 구분 같은 기능은 이 Mac에 받아 두는 모델 파일로 돕니다. 필수 모델만 있어도 녹음하고 텍스트로 바꾸고 요약할 수 있습니다. 나머지는 필요한 기능만 설치하세요. 없는 모델이 필요한 단추는 이유를 알려 주고 이 화면으로 안내합니다.
      </p>
      <p className="field-hint tnum models-where">
        {list ? (
          <>
            위치 {list.models_dir} · 디스크 여유 {fmtBytes(list.disk_free_bytes)}
            {sum && ` · 설치됨 ${sum.installed}/${sum.total}개 (${fmtBytes(sum.bytes)})`}
          </>
        ) : (
          !error && "불러오는 중…"
        )}
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error.text}
          <ErrorDetail detail={error.detail} />
        </div>
      )}
      {external && <p className="field-hint" role="status">{EXTERNAL_NOTICE}</p>}
      {list && <PresetButtons list={list} dl={dl} />}
      <DownloadPanel dl={dl} />
      {msg && (
        <div className={msg.error ? "inline-error" : "field-hint"} role={msg.error ? "alert" : "status"}>
          {msg.text}
          <ErrorDetail detail={msg.detail} />
        </div>
      )}
      {list && (
        <div className="models-scroll">
          <table className="models-table">
            <caption className="sr-only">모델 목록</caption>
            <thead>
              <tr>
                <th scope="col">모델</th>
                <th scope="col">크기</th>
                <th scope="col">구분</th>
                <th scope="col">상태</th>
                <th scope="col">이 기능에 필요</th>
                <th scope="col">
                  <span className="sr-only">동작</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.models.map((m) => {
                const detailRows = modelDetailRows(m);
                const hasMore = detailRows.length > 0;
                return (
                <Fragment key={m.id}>
                <tr className={hasMore ? "has-more" : undefined}>
                  <th scope="row">
                    <span className="models-name">{m.name}</span>
                    <ModelSubtitle m={m} />
                    <span className="models-purpose">{m.purpose}</span>
                    {needsHelperNote(m, helperFound) && <span className="models-purpose">먼저 recorder/diar 폴더에서 swift build -c release로 tractus-diar를 만들어야 합니다.</span>}
                  </th>
                  <td className="tnum">{fmtBytes(m.size_bytes)}</td>
                  <td>
                    <span className={`badge level-${m.level}`}>{LEVEL_LABEL[m.level]}</span>
                  </td>
                  <td>
                    <span className={`model-state is-${m.state}`}>{STATE_LABEL[m.state]}</span>
                    {m.state === "partial" && m.installed_bytes > 0 && <span className="models-purpose tnum">{fmtBytes(m.installed_bytes)} 받음</span>}
                  </td>
                  <td>
                    <ul className="chips" aria-label={`${m.name}이(가) 필요한 기능`}>
                      {m.needed_by.length === 0 && <li className="models-purpose">—</li>}
                      {m.needed_by.map((c) => (
                        <li key={c} className="chip">
                          {capChip(c)}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="models-actions">
                    {m.state !== "installed" && (
                      <button type="button" className="ghost-button" disabled={busy} onClick={() => (m.state === "corrupt" ? void reinstall(m) : install(m))}>
                        {installLabel(m.state)}
                      </button>
                    )}
                    {m.state !== "missing" && (
                      <button type="button" className="text-button is-danger" disabled={busy || removing} onClick={() => setAsking(m)} aria-label={`${m.name} 삭제`}>
                        삭제
                      </button>
                    )}
                  </td>
                </tr>
                {hasMore && (
                  <tr className="models-detail-row">
                    <td colSpan={6}>
                      <ModelDetails m={m} rows={detailRows} />
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {asking && dialog && (
        <ConfirmDialog title={dialog.title} body={dialog.body} cancelLabel={dialog.cancel} confirmLabel={dialog.confirm} busy={removing} onCancel={() => setAsking(null)} onConfirm={() => void remove(asking)} />
      )}
    </section>
  );
}
