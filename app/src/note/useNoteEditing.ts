// 노트 데이터와 편집 (MeetingView에서 옮김, 동작 그대로): 코어가 확인한 노트(base)와 저장 중인 문장 편집(pending)을 겹친 화면용 노트,
// 편집 줄(serial)·문장 저장·되돌리기(⌘Z)·화자 편집·메모 저장·제목 바꾸기·녹음 중 메모 고치기. 화면 상태(고르는 줄·메뉴 등)는 들고 있지 않다.
import { useCallback, useMemo, useRef, useState } from "react";
import { api, errDetail, errText, type MeetingDetail, type SpeakerEdit } from "../api";
import type { Notify } from "../App";
import { editQueue } from "../editQueue";
import { indexer } from "../indexer";
import { t } from "../i18n";
import { applyEdits, inverseEdits, oneLine, renameRemembering, segText, type Memo, type TextEdit } from "../lib";
import { flushMemos, type EditKind } from "../memo";
import { appendBlock } from "../memoEdit";
import { EDIT_BLOCKED } from "../remove";
import { termFromEdit } from "../vocab";

export function useNoteEditing({ id, summaryStale, notify, onEdited, onChanged }: { id: string; summaryStale: boolean; notify: Notify; onEdited?: (id: string, updatedAt: string) => void; onChanged: () => void }) {
  // base: 코어가 확인한 회의. pending: 저장 중인 문장 편집 묶음(낙관적 반영). 화면은 둘을 겹친 것
  const [base, setBase] = useState<MeetingDetail | null>(null);
  // 코어가 마지막으로 확인한 회의 (렌더를 기다리지 않는다). 되돌리기 묶음은 이것으로 만든다
  const confirmed = useRef<MeetingDetail | null>(null);
  const [summaryRev, setSummaryRev] = useState(0); // 노트를 다시 읽을 때마다 올라간다: 요약 탭이 요약 파일을 다시 읽는다
  const commit = useCallback((d: MeetingDetail) => {
    confirmed.current = d;
    setBase(d);
    setSummaryRev((r) => r + 1);
  }, []);
  const [pending, setPending] = useState<TextEdit[][]>([]);
  const detail = useMemo(() => (base && pending.length ? { ...base, segments: pending.reduce(applyEdits, base.segments) } : base), [base, pending]);

  // 요약이 낡았는지: 코어가 실제로 바꾼 편집 횟수(editSeq)를 요약마다 시작할 때의 값과 견준다 (SummariesPanel).
  // 요약하는 동안 고친 문장은 요약이 끝나도 '낡음'으로 남는다
  const [editSeq, setEditSeq] = useState(summaryStale ? 1 : 0);
  const editSeqRef = useRef(summaryStale ? 1 : 0); // 저장이 끝나 값이 바뀌어도 await 뒤에 최신 값을 읽는다 (요약 직전 저장이 '낡음'으로 남지 않게)
  const editKinds = useRef<EditKind[]>(summaryStale ? ["text"] : []); // 고친 것의 종류 (안내 문장: 대화 내용 / 메모 / 둘 다). 개수가 editSeq다
  const bumpEdit = useCallback((kind: EditKind) => {
    editKinds.current = [...editKinds.current, kind];
    setEditSeq(++editSeqRef.current);
  }, []);

  const onMemoSaved = useCallback(
    (m: MeetingDetail) => {
      commit(m);
      onEdited?.(id, m.info.updated_at ?? "");
      bumpEdit("memo");
      indexer.touch(); // 한가할 때 조용히 검색에 반영한다
    },
    [commit, bumpEdit, onEdited, id],
  );

  // 요약을 내 메모 끝에 붙인다 (녹음 노트의 메모 탭). 쓰던 메모를 먼저 저장하고 최신 본문에 붙인 뒤 편집기를 새 본문으로 다시 연다
  const [memoRev, setMemoRev] = useState(0);
  const sendToMemo = useCallback(
    async (markdown: string) => {
      if (!(await flushMemos())) return;
      if (editQueue.isBlocked(id)) return notify({ text: EDIT_BLOCKED, error: true });
      const body = appendBlock(confirmed.current?.note_memo?.body ?? "", markdown);
      try {
        const r = await editQueue.run(id, () => api.noteSave(id, body));
        if (!r) return notify({ text: EDIT_BLOCKED, error: true });
        onMemoSaved(r.meeting);
        setMemoRev((n) => n + 1);
        notify({ text: t("요약을 메모에 붙였습니다") });
      } catch (e) {
        notify({ text: t("메모에 붙이지 못했습니다: {error}", { error: errText(e) }), detail: errDetail(e), error: true });
      }
    },
    [id, notify, onMemoSaved],
  );

  // 제목 바꾸기: 낙관적으로 바꾸고 줄을 세워 저장한다. 실패하면 원래 제목으로 되돌리고 알린다. 폴더 이름은 그대로다 (코어)
  const renameNote = useCallback(
    (title: string) => {
      if (editQueue.isBlocked(id)) return notify({ text: EDIT_BLOCKED, error: true });
      const before = confirmed.current?.info.title ?? "";
      const setTitle = (t: string) => setBase((b) => (b ? { ...b, info: { ...b.info, title: t } } : b));
      setTitle(title);
      setInFlight((n) => n + 1);
      void Promise.resolve(editQueue.run(id, () => api.noteTitle(id, title)))
        .then((saved) => {
          if (saved === undefined) throw new Error(EDIT_BLOCKED);
          if (confirmed.current) confirmed.current = { ...confirmed.current, info: { ...confirmed.current.info, title: saved } };
          setTitle(saved);
          onChanged(); // 사이드바 제목
        })
        .catch((e) => {
          setTitle(before);
          notify({ text: errText(e), detail: errDetail(e), error: true });
        })
        .finally(() => setInFlight((n) => n - 1));
    },
    [id, notify, onChanged],
  );

  const [editError, setEditError] = useState<string | null>(null);
  // 편집은 노트마다 한 줄로 세운다(editQueue.ts): 코어가 transcript.json을 읽고-고쳐-쓴다. 화자·문장 편집·목소리 등록·내보내기가 같은 줄에 선다.
  // 줄은 모듈에 있어 삭제가 이 줄이 빌 때까지 기다릴 수 있고, 삭제를 기다리는 동안에는 새 편집을 받지 않는다
  const [inFlight, setInFlight] = useState(0);
  const editing = inFlight > 0;
  const serial = useCallback(
    (task: () => Promise<void>) => {
      if (editQueue.isBlocked(id)) {
        setEditError(EDIT_BLOCKED);
        return Promise.resolve();
      }
      setInFlight((n) => n + 1);
      return Promise.resolve(editQueue.run(id, task))
        .then(() => {})
        .finally(() => setInFlight((n) => n - 1));
    },
    [id],
  );
  // 녹음 중 남긴 메모·북마크 고치기·지우기 (marks.ts, `tractus marks save`): 낙관적으로 바꾸고 줄을 세워 저장한다. 실패하면 코어가 확인한 목록으로 되돌린다
  const saveMarks = useCallback(
    (next: Memo[]) => {
      if (editQueue.isBlocked(id)) return setEditError(EDIT_BLOCKED);
      setBase((b) => (b ? { ...b, memos: next } : b));
      void serial(async () => {
        try {
          const { marks } = await api.marksSave(id, next);
          if (confirmed.current) confirmed.current = { ...confirmed.current, memos: marks };
          setBase((b) => (b ? { ...b, memos: marks } : b));
        } catch (e) {
          const back = confirmed.current?.memos ?? [];
          setBase((b) => (b ? { ...b, memos: back } : b));
          notify({ text: errText(e), detail: errDetail(e), error: true });
        }
      });
    },
    [id, serial, notify],
  );
  // 오류 표시는 사용자가 새로 고칠 때만 지운다: 줄에 선 다음 작업이 시작하며 지우면 실패를 못 보고 지나간다
  const editSpeakers = useCallback(
    (edit: SpeakerEdit) => {
      setEditError(null);
      return serial(async () => {
        try {
          commit(await api.editSpeakers(id, edit));
        } catch (e) {
          setEditError(errText(e));
        }
      });
    },
    [id, serial, commit],
  );
  // 이름 바꾸기 + 목소리 기억하기 (7.1). 코어가 rename까지 하므로 편집 한 번이다. 등록이 실패하면 이름만 바꾼다(renameRemembering). 동의 확인은 RenameForm이 받았다
  const renameSpeaker = useCallback(
    (label: string, name: string, remember: boolean) => {
      if (!remember) return void editSpeakers({ op: "rename", label, name });
      setEditError(null);
      void serial(async () => {
        const r = await renameRemembering(
          () => api.voicesEnroll(id, label, name),
          () => api.editSpeakers(id, { op: "rename", label, name }),
        );
        if ("meeting" in r) commit(r.meeting);
        if ("samples" in r) notify({ text: t("‘{name}’ 님의 목소리를 등록했습니다 (표본 {n}개). 다음 녹음부터 자동으로 알아봅니다", { name, n: r.samples }) });
        else if ("renameError" in r) setEditError(t("이름을 바꾸지 못했습니다: {error} (목소리: {voiceError})", { error: errText(r.renameError), voiceError: errText(r.voiceError) }));
        else setEditError(t("이름은 ‘{name}’(으)로 바꿨지만 목소리는 등록하지 못했습니다: {error}", { name, error: errText(r.voiceError) }));
      });
    },
    [id, serial, commit, editSpeakers, notify],
  );

  // 문장 편집 (5.3): 낙관적으로 반영하고 줄을 세워 저장한다. 되돌리기는 묶음 단위(⌘Z)
  const undoStack = useRef<TextEdit[][]>([]);
  // 저장 한 묶음 (serial 안에서 부른다). 되돌리기 묶음은 저장이 성공한 뒤 코어가 확인한 직전 상태로 만든다:
  // 화면(낙관적 반영)으로 만들면 앞 묶음이 실패했을 때 저장된 적 없는 문장으로 되돌린다
  // 고친 낱말을 자주 쓰는 단어로 제안한다 (vocab.ts). 여러 개면 한 알림으로 묻는다. 한 번 물은 낱말은 이 화면에서 다시 묻지 않는다
  const askedTerms = useRef(new Set<string>());
  const suggestTerms = useCallback(
    (all: string[]) => {
      const terms = all.filter((x) => !askedTerms.current.has(x));
      if (!terms.length) return;
      for (const x of terms) askedTerms.current.add(x);
      const term = terms.join(", ");
      notify({
        text: t("자주 쓰는 단어에 추가할까요? — {term} (다음 녹음부터 더 정확하게 인식합니다)", { term }),
        action: {
          label: t("추가"),
          run: () =>
            void api.glossaryAdd(terms).then(
              (n) => notify({ text: n ? t("자주 쓰는 단어에 추가했습니다 — {term} (다음 녹음부터 더 정확하게 인식합니다)", { term }) : t("이미 자주 쓰는 단어에 있습니다 — {term}", { term }) }),
              (e) => notify({ text: t("자주 쓰는 단어에 추가하지 못했습니다: {error}", { error: errText(e) }), error: true }),
            ),
        },
      });
    },
    [notify],
  );
  const persist = useCallback(
    async (edits: TextEdit[], isUndo: boolean, suggest = false) => {
      const before = confirmed.current;
      try {
        const { changed, meeting } = await api.editSegments(id, edits);
        commit(meeting);
        if (changed > 0) {
          onEdited?.(id, meeting.info.updated_at ?? "");
          bumpEdit("text");
          indexer.touch(); // 한가할 때 조용히 검색에 반영한다 (마지막 수정 뒤 60초, 갱신 사이 5분)
          if (!isUndo && before) undoStack.current.push(inverseEdits(before.segments, edits));
          const old = suggest && edits.length === 1 ? before?.segments.find((s) => s.id === edits[0].id) : undefined;
          const term = old ? termFromEdit(segText(old), edits[0].text) : null;
          if (term) suggestTerms([term]);
        }
      } catch (e) {
        // 아무것도 쓰이지 않았다(코어 계약). 화면은 원래 문장으로 돌아가므로 고친 문장을 메시지에 남긴다
        setEditError(
          edits.length === 1
            ? t("저장하지 못했습니다 (“{text}”): {error}", { text: oneLine(edits[0].text), error: errText(e) })
            : t("저장하지 못했습니다 (대화 {n}개): {error}", { n: edits.length, error: errText(e) }),
        );
        if (isUndo) undoStack.current.push(edits);
      } finally {
        setPending((p) => p.filter((x) => x !== edits));
      }
    },
    [id, commit, bumpEdit, onEdited, suggestTerms],
  );
  /** suggestTerm: 대화 한 줄을 직접 고쳤을 때 (찾아 바꾸기는 '자주 쓰는 단어에 추가' 체크가 따로 있다) */
  const saveText = useCallback(
    (edits: TextEdit[], suggestTerm = false) => {
      if (!edits.length) return;
      if (editQueue.isBlocked(id)) return setEditError(EDIT_BLOCKED); // 삭제를 기다리는 중: 낙관적 반영도 하지 않는다
      setEditError(null);
      setPending((p) => [...p, edits]);
      void serial(() => persist(edits, false, suggestTerm));
    },
    [id, serial, persist],
  );

  // 되돌리기도 줄에 선다: 앞선 저장이 끝나 스택에 오른 뒤에 꺼낸다(저장 중에 ⌘Z를 눌러도 순서가 맞다)
  const undo = useCallback(() => {
    setEditError(null);
    void serial(async () => {
      const inv = undoStack.current.pop();
      if (!inv) return;
      setPending((p) => [...p, inv]);
      await persist(inv, true);
    });
  }, [serial, persist]);

  return {
    base, setBase, confirmed, commit, detail, summaryRev, setSummaryRev,
    editSeq, editSeqRef, editKinds, bumpEdit, onMemoSaved,
    memoRev, setMemoRev, sendToMemo, renameNote,
    inFlight, editing, serial, editError, setEditError, saveMarks, editSpeakers, renameSpeaker,
    undoStack, suggestTerms, persist, saveText, undo, setPending,
  };
}
