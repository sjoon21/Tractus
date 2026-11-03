// 화자 편집: 코어가 파일과 색인을 고치고(약 3초) 고친 노트를 돌려준다. 이름 바꾸기에는 목소리 기억하기(7.1)가 붙는다.
import { useCallback } from "react";
import { api, errText, type SpeakerEdit } from "../api";
import type { Notify } from "../App";
import { t } from "../i18n";
import { renameRemembering } from "../lib";
import type { EditQueue } from "./useEditQueue";
import type { NoteData } from "./useNoteData";

export function useSpeakerEditing({ id, data, queue, notify }: { id: string; data: NoteData; queue: EditQueue; notify: Notify }) {
  const { commit } = data;
  const { serial, setEditError } = queue;
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
    [id, serial, commit, setEditError],
  );
  // 코어가 rename까지 하므로 편집 한 번이다. 등록이 실패하면 이름만 바꾼다(renameRemembering). 동의 확인은 RenameForm이 받았다
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
    [id, serial, commit, editSpeakers, notify, setEditError],
  );
  return { editSpeakers, renameSpeaker };
}
