// 화자 표시·편집 (docs/desktop.md §2.1). 편집은 전부 코어(`tractus speakers`)가 하고 앱은 고친 회의를 다시 받는다.
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { ErrorDetail } from "./ErrorDetail";
import { fmtTime, renameRequest, SPEAKER_INKS, suggestionText, VOICE_MODEL_MISSING, VOICE_MODEL_SETUP, voiceModelReady, type Segment, type SpeakerStat } from "./lib";

/** 목소리 인식 파일을 쓸 수 있는지 한 번 물어 두고 잠시 기억한다 (코어를 띄우는 일이라 이름 바꾸기를 열 때마다 묻지 않는다). 읽지 못하면 쓸 수 있다고 본다 */
const VOICE_MODEL_TTL_MS = 30_000;
let voiceModelSeen: { at: number; ready: boolean } | null = null;

function useVoiceModelReady(): boolean {
  const [ready, setReady] = useState(voiceModelSeen?.ready ?? true);
  useEffect(() => {
    if (voiceModelSeen && Date.now() - voiceModelSeen.at < VOICE_MODEL_TTL_MS) return setReady(voiceModelSeen.ready);
    let alive = true;
    api.voicesList().then(
      (l) => {
        voiceModelSeen = { at: Date.now(), ready: voiceModelReady(l) };
        if (alive) setReady(voiceModelSeen.ready);
      },
      () => {}, // 알 수 없으면 그대로 둔다: 등록은 코어가 한 번 더 거절한다
    );
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

/** 화자 색 (SpeakerStat.slot). 화자 미상이면 무채색. 슬롯 8..15는 같은 잉크에 속 빈 점(--spk-fill)·빗금 막대(--spk-bar).
 *  세 변수를 늘 함께 정한다: 중첩된 요소가 바깥 화자의 표시를 물려받지 않게 */
export const spkStyle = (slot: number | undefined) => {
  const ink = slot === undefined || slot < 0 ? "var(--ink-3)" : `var(--spk-${slot % SPEAKER_INKS})`;
  const second = slot !== undefined && slot >= SPEAKER_INKS;
  return {
    "--spk": ink,
    "--spk-fill": second ? "transparent" : ink,
    "--spk-bar": second ? `repeating-linear-gradient(135deg, ${ink} 0 2px, transparent 2px 4px)` : ink,
  } as React.CSSProperties;
};

export type MenuTarget = { kind: "seg"; seg: Segment; anchor: HTMLElement } | { kind: "speaker"; label: string; anchor: HTMLElement };
export type MergeAsk = { from: string; into: string };

/** 세그먼트 앞 화자 칩. 발언의 첫 세그먼트에만 이름을 쓰고, 이어지는 세그먼트는 점만 둔다 */
export const SpeakerChip = memo(function SpeakerChip({
  seg,
  display,
  turnStart,
  onOpen,
}: {
  seg: Segment;
  display: string | null;
  turnStart: boolean;
  onOpen: (seg: Segment, anchor: HTMLElement) => void;
}) {
  const name = display ?? "알 수 없음";
  return (
    <button
      className={`spk-chip ${turnStart ? "is-turn" : "is-cont"} ${seg.speaker ? "" : "is-unknown"}`}
      onClick={(e) => onOpen(seg, e.currentTarget)}
      aria-haspopup="dialog"
      aria-label={`${fmtTime(seg.start)} 대화의 참석자: ${name} — 바꾸기`}
      title={turnStart ? undefined : name}
    >
      <span className="spk-dot" aria-hidden />
      {turnStart && <span className="spk-name">{name}</span>}
    </button>
  );
});

/**
 * 이름 입력 + '이 목소리 기억하기' (Phase 7.1). 한글 조합 중의 Enter는 조합을 끝낼 뿐 제출하지 않는다(WebKit은 compositionend가
 * keydown보다 먼저 와서 조합 플래그만으로는 못 거른다 → isComposing·keyCode 229로 본다). Esc·폼 밖으로 초점 이탈은 취소.
 * 기억하기는 동의 확인을 한 번 더 받는다(생체정보). 확인 전에는 제출하지 않는다.
 */
export function RenameForm({
  display,
  initial,
  onSubmit,
  onCancel,
}: {
  /** 지금 보이는 이름 ("참석자 1" 또는 붙인 이름) */
  display: string;
  initial: string;
  onSubmit: (name: string, remember: boolean) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [remember, setRemember] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelReady = useVoiceModelReady();
  const submit = () => {
    const r = renameRequest(input.current?.value ?? "", modelReady && remember, consent);
    if ("error" in r) setError(r.error);
    else onSubmit(r.name, r.remember);
  };
  return (
    <div
      className="spk-rename-form"
      role="group"
      aria-label={`${display} 이름 바꾸기`}
      // WebKit은 클릭으로 체크박스에 초점을 주지 않는다 → 입력란이 초점을 잃어 취소되지 않게 누르기만 막는다(체크는 click으로 바뀐다)
      onMouseDown={(e) => e.target !== input.current && e.preventDefault()}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && onCancel()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation(); // 팝오버까지 닫지 않는다
          onCancel();
        }
      }}
    >
      <input ref={input} className="spk-rename" defaultValue={initial} placeholder={display} aria-label={`${display} 이름`} autoFocus onFocus={(e) => e.currentTarget.select()} />
      <label className="spk-check">
        <input
          type="checkbox"
          checked={modelReady && remember}
          disabled={!modelReady}
          onChange={(e) => {
            setRemember(e.target.checked);
            setError(null);
          }}
        />
        이 참석자 목소리 등록 (다음 녹음에서 자동 인식)
      </label>
      {!modelReady && (
        <p className="spk-check-note" role="status">
          {VOICE_MODEL_MISSING}
          <ErrorDetail detail={VOICE_MODEL_SETUP} />
        </p>
      )}
      {modelReady && remember && (
        <label className="spk-check is-consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              setError(null);
            }}
          />
          <span>
            본인이거나 녹음·등록에 동의를 받은 사람입니다
            <small>목소리는 생체정보입니다. 이 Mac에만 저장하고 설정에서 지울 수 있습니다</small>
          </span>
        </label>
      )}
      {error && (
        <p className="spk-rename-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SpeakersBar({
  stats,
  only,
  onFilter,
  busy,
  renaming,
  merge,
  onRename,
  onStartRename,
  onCancelRename,
  onAskMerge,
  onMerge,
  onCancelMerge,
  onMenu,
  onConfirm,
  onDismiss,
}: {
  stats: SpeakerStat[];
  only: string | null;
  onFilter: (label: string | null) => void;
  busy: boolean;
  renaming: string | null;
  merge: MergeAsk | null;
  onRename: (label: string, name: string, remember: boolean) => void;
  onStartRename: (label: string) => void;
  onCancelRename: () => void;
  onAskMerge: (ask: MergeAsk) => void;
  onMerge: () => void;
  onCancelMerge: () => void;
  onMenu: (label: string, anchor: HTMLElement) => void;
  /** 목소리 제안 확정 (= 그 이름으로 rename) / 거절 (dismiss) */
  onConfirm: (label: string, name: string) => void;
  onDismiss: (label: string) => void;
}) {
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const by = (label: string) => stats.find((s) => s.label === label);
  const from = merge && by(merge.from);
  const into = merge && by(merge.into);

  return (
    <section className="speakers" aria-labelledby="speakers-title">
      <div className="speakers-head">
        <h2 className="eyebrow" id="speakers-title">
          참석자 {stats.length}명 <span>(자동 감지)</span>
        </h2>
        {only && (
          <button className="text-button" onClick={() => onFilter(null)}>
            전체 보기
          </button>
        )}
      </div>

      <div className="speakers-share" aria-hidden>
        {stats.map((s) => (
          <span key={s.label} style={{ ...spkStyle(s.slot), flexGrow: s.talkSec }} className={only && only !== s.label ? "is-dim" : ""} />
        ))}
      </div>

      <ul className="speakers-list">
        {stats.map((s) => (
          <li
            key={s.label}
            style={spkStyle(s.slot)}
            className={`${dropOn === s.label ? "is-drop" : ""} ${only && only !== s.label ? "is-dim" : ""} ${renaming === s.label ? "is-editing" : ""}`}
            draggable={!busy && renaming !== s.label}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", s.label);
              e.dataTransfer.effectAllowed = "move";
              setDragFrom(s.label);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDropOn(null);
            }}
            onDragOver={(e) => {
              if (!dragFrom || dragFrom === s.label) return;
              e.preventDefault();
              setDropOn(s.label);
            }}
            onDragLeave={() => setDropOn((d) => (d === s.label ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom && dragFrom !== s.label) onAskMerge({ from: dragFrom, into: s.label });
              setDragFrom(null);
              setDropOn(null);
            }}
          >
            {renaming === s.label ? (
              <span className="speaker-filter is-editing">
                <span className="spk-dot" aria-hidden />
                <RenameForm
                  display={s.display}
                  initial={s.named ? s.display : (s.suggested?.name ?? "")}
                  onSubmit={(name, remember) => onRename(s.label, name, remember)}
                  onCancel={onCancelRename}
                />
              </span>
            ) : (
              <button
                className="speaker-filter"
                aria-pressed={only === s.label}
                title={`${s.display}만 보기 · 두 번 눌러 이름 바꾸기 · 다른 참석자에 끌어 놓아 동일 인물로 합치기`}
                onClick={() => onFilter(only === s.label ? null : s.label)}
                onDoubleClick={() => !busy && onStartRename(s.label)}
              >
                <span className="spk-dot" aria-hidden />
                <span className={`speaker-name ${s.named ? "" : "is-label"}`}>{s.display}</span>
                <span className="speaker-share tnum">{Math.round(s.share * 100)}%</span>
              </button>
            )}
            {s.suggested && renaming !== s.label && (
              <span className="spk-suggest" role="group" aria-label={`${s.display} 목소리 제안: ${suggestionText(s.suggested)}`}>
                <span className="spk-suggest-text tnum" aria-hidden>
                  {suggestionText(s.suggested)}
                </span>
                <button disabled={busy} onClick={() => onConfirm(s.label, s.suggested!.name.trim())} aria-label={`${s.display}을(를) ${s.suggested.name.trim()} 님으로 지정`}>
                  맞음
                </button>
                <button disabled={busy} onClick={() => onDismiss(s.label)} aria-label={`${s.suggested.name.trim()} 님이 아닙니다`}>
                  다름
                </button>
              </span>
            )}
            <button className="speaker-more" aria-label={`참석자 편집 — ${s.display}`} aria-haspopup="dialog" disabled={busy} onClick={(e) => onMenu(s.label, e.currentTarget)}>
              <MoreIcon />
            </button>
          </li>
        ))}
      </ul>

      {from && into && (
        <div className="speakers-confirm" role="alertdialog" aria-label="동일 인물로 합치기">
          <p>
            <b style={spkStyle(from.slot)}>{from.display}</b>와(과) <b style={spkStyle(into.slot)}>{into.display}</b>을(를) 동일 인물로 합칩니다. {from.display}의 대화 {from.segments}개가{" "}
            {into.display}(으)로 옮겨집니다.
            {!into.named && from.named && ` 이름 ‘${from.display}’도 함께 옮깁니다.`} 되돌리려면 대화마다 참석자를 다시 골라야 합니다.
          </p>
          <button className="primary-button" onClick={onMerge} disabled={busy} autoFocus>
            동일 인물로 합치기
          </button>
          <button className="text-button" onClick={onCancelMerge}>
            취소
          </button>
        </div>
      )}
    </section>
  );
}

/** 칩·화자 막대의 편집 메뉴. 네이티브 popover라 Esc·바깥 클릭으로 닫힌다 */
export function SpeakerMenu({
  target,
  stats,
  busy,
  onClose,
  onSet,
  onRename,
  onStartRename,
  onAskMerge,
}: {
  target: MenuTarget;
  stats: SpeakerStat[];
  busy: boolean;
  onClose: () => void;
  onSet: (segment: string, label: string) => void;
  onRename: (label: string, name: string, remember: boolean) => void;
  onStartRename: (label: string) => void;
  onAskMerge: (ask: MergeAsk) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.showPopover();
    const a = target.anchor.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    const below = a.bottom + 6 + m.height < window.innerHeight - 12;
    el.style.left = `${Math.max(12, Math.min(a.left, window.innerWidth - m.width - 12))}px`;
    el.style.top = `${below ? a.bottom + 6 : Math.max(12, a.top - m.height - 6)}px`;
    el.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [target]);

  /** 메뉴로 한 일은 칩으로 초점을 돌려준다 (바깥 클릭으로 닫힐 때는 그 클릭이 초점을 가져간다) */
  const done = (act?: () => void) => {
    ref.current?.hidePopover();
    target.anchor.focus();
    act?.();
  };

  const label = target.kind === "seg" ? target.seg.speaker : target.label;
  const current = stats.find((s) => s.label === label);

  return (
    <div
      ref={ref}
      popover="auto"
      className="spk-menu"
      role="dialog"
      aria-label="참석자 편집"
      onToggle={(e) => e.newState === "closed" && onClose()}
      onKeyDown={(e) => e.key === "Escape" && target.anchor.focus()}
    >
      {target.kind === "seg" ? (
        <>
          <p className="spk-menu-title tnum">{fmtTime(target.seg.start)} 대화의 참석자</p>
          <div className="spk-menu-group">
            {stats.map((s) => (
              <button key={s.label} style={spkStyle(s.slot)} aria-pressed={s.label === label} disabled={busy} onClick={() => done(s.label === label ? undefined : () => onSet(target.seg.id, s.label))}>
                <span className="spk-dot" aria-hidden />
                <span className={s.named ? "" : "is-label"}>{s.display}</span>
              </button>
            ))}
            <button disabled={busy} onClick={() => done(() => onSet(target.seg.id, "new"))}>
              <span className="spk-plus" aria-hidden>
                +
              </span>
              새 참석자
            </button>
          </div>
          {current &&
            (renaming ? (
              <div className="spk-menu-rename">
                <RenameForm
                  display={current.display}
                  initial={current.named ? current.display : (current.suggested?.name ?? "")}
                  onSubmit={(name, remember) => done(() => onRename(current.label, name, remember))}
                  onCancel={() => setRenaming(false)}
                />
                <span className="spk-menu-hint">Enter로 저장 · Esc 취소</span>
              </div>
            ) : (
              <button className="spk-menu-action" disabled={busy} onClick={() => setRenaming(true)}>
                ‘{current.display}’ 이름 바꾸기…
              </button>
            ))}
        </>
      ) : (
        current && (
          <>
            <p className="spk-menu-title" style={spkStyle(current.slot)}>
              <span className="spk-dot" aria-hidden />
              {current.display}
              <span className="tnum"> · 대화 {current.segments}개</span>
            </p>
            <button className="spk-menu-action" disabled={busy} onClick={() => done(() => onStartRename(current.label))}>
              이름 바꾸기…
            </button>
            {stats.length > 1 && <p className="spk-menu-sub">동일 인물로 합치기</p>}
            <div className="spk-menu-group">
              {stats
                .filter((s) => s.label !== current.label)
                .map((s) => (
                  <button key={s.label} style={spkStyle(s.slot)} disabled={busy} onClick={() => done(() => onAskMerge({ from: current.label, into: s.label }))}>
                    <span className="spk-dot" aria-hidden />
                    <span className={s.named ? "" : "is-label"}>{s.display}</span>
                  </button>
                ))}
            </div>
          </>
        )
      )}
    </div>
  );
}

const MoreIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <circle cx="3" cy="8" r="1.4" fill="currentColor" />
    <circle cx="8" cy="8" r="1.4" fill="currentColor" />
    <circle cx="13" cy="8" r="1.4" fill="currentColor" />
  </svg>
);
