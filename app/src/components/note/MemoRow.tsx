// 녹음 중 남긴 메모·북마크 한 줄 (대화 내용 사이에 끼어 시각 순으로 보인다)
import { EditableMark } from "../../MarkEdit";
import { fmtTime, type Memo } from "../../lib";
import { t } from "../../i18n";

export function MemoRow({ memo: m, onSeek, onSave, onDelete }: { memo: Memo; onSeek: (t: number) => void; onSave: (text: string) => void; onDelete: () => void }) {
  const isBookmark = m.kind === "bookmark";
  return (
    <li className={`memo is-${isBookmark ? "bookmark" : "memo"}`}>
      <EditableMark memo={m} onSave={onSave} onDelete={onDelete}>
        <button className="seg-button" onClick={() => onSeek(m.t)}>
          <time className="seg-time tnum">{fmtTime(m.t)}</time>
          <span className="memo-body">
            <span className="memo-kind">{isBookmark ? t("북마크") : t("메모")}</span>
            <span className="memo-text">{m.text}</span>
          </span>
        </button>
      </EditableMark>
    </li>
  );
}
