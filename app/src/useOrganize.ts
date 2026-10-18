// 노트 정리 상태 (docs/desktop.md §2.12): 사이드바의 폴더·태그 걸러내기, 목록 순서, 즐겨찾기·태그·폴더 바꾸기.
// 노트 목록과 폴더 목록은 App이 들고 있고, 여기서는 낙관적으로 먼저 보이고 노트별 저장 줄(editQueue)에 세워 코어에 저장한다.
// 저장하지 못하면 바꾼 키만 이전 값으로 되돌리고 알린다. 컨텍스트로 사이드바와 노트 머리가 같은 상태를 본다.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Notify } from "./App";
import { api, errDetail, errText, type MeetingInfo } from "./api";
import { editQueue } from "./editQueue";
import { t } from "./i18n";
import {
  applyMeta,
  buildFolderTree,
  collectTags,
  defaultOrder,
  DEFAULT_SORT,
  folderPath,
  foldKey,
  metaOf,
  NO_FILTER,
  readSortPrefs,
  type Folder,
  type MetaPatch,
  type NoteFilter,
  type NoteMeta,
  type SortKey,
  type SortOrder,
  type TagCount,
  type TreeNode,
} from "./organize";
import { EDIT_BLOCKED } from "./remove";

export interface OrganizeValue {
  folders: Folder[];
  tree: TreeNode[];
  tags: TagCount[];
  filter: NoteFilter;
  setQuery: (q: string) => void;
  /** 태그를 걸러내기에 넣거나 뺀다 (여럿이면 모두 붙은 노트) */
  toggleTag: (tag: string) => void;
  /** null: 폴더로 거르지 않음, "none": 폴더 없는 노트 */
  selectFolder: (id: string | "none" | null) => void;
  clearFilters: () => void;
  sort: SortKey;
  order: SortOrder;
  setSort: (k: SortKey) => void;
  toggleOrder: () => void;
  metaOf: (id: string) => NoteMeta;
  setFavorite: (id: string, on: boolean) => Promise<boolean>;
  setTags: (id: string, tags: string[]) => Promise<boolean>;
  /** 노트를 폴더로 (null이면 폴더에서 뺀다). 성공하면 알림 */
  moveNote: (id: string, folder: string | null) => Promise<boolean>;
  createFolder: (name: string, parent: string | null) => Promise<Folder | null>;
  renameFolder: (id: string, name: string) => Promise<boolean>;
  /** 폴더를 다른 폴더 아래(null이면 최상위)로 옮긴다. 자기 안으로·3단계 넘게·같은 이름이 있는 곳은 코어가 거절하고 문장을 알린다 */
  moveFolder: (id: string, parent: string | null) => Promise<boolean>;
  deleteFolder: (id: string) => Promise<boolean>;
  /** 노트 머리의 태그 입력창에 초점을 달라는 요청 (사이드바 줄 메뉴의 `태그 편집`). nonce가 바뀌면 새 요청 */
  tagFocus: { id: string; nonce: number } | null;
  requestTagFocus: (id: string) => void;
}

export const OrganizeContext = createContext<OrganizeValue | null>(null);

export function useOrganize(): OrganizeValue {
  const v = useContext(OrganizeContext);
  if (!v) throw new Error("OrganizeContext is missing");
  return v;
}

interface Args {
  meetings: MeetingInfo[];
  setMeetings: Dispatch<SetStateAction<MeetingInfo[]>>;
  folders: Folder[];
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  /** 노트 목록과 폴더를 디스크에서 다시 읽는다 */
  refresh: () => Promise<void>;
  notify: Notify;
}

export function useOrganizeState({ meetings, setMeetings, folders, setFolders, refresh, notify }: Args): OrganizeValue {
  const [filter, setFilter] = useState<NoteFilter>(NO_FILTER);
  const [prefs, setPrefs] = useState<{ sort: SortKey; order: SortOrder }>(DEFAULT_SORT);
  const [tagFocus, setTagFocus] = useState<{ id: string; nonce: number } | null>(null);
  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  // 순서는 설정에 저장해 둔다. 처음에 읽는다 (읽지 못하면 기본값: 최근 수정 순)
  useEffect(() => {
    api.getSettings().then(
      (s) => setPrefs(readSortPrefs(s)),
      () => {},
    );
  }, []);
  const savePrefs = useCallback(
    (next: { sort: SortKey; order: SortOrder }) => {
      setPrefs(next);
      api.setListPrefs(next.sort, next.order).catch((e) => notify({ text: t("목록 순서를 저장하지 못했습니다: {error}", { error: errText(e) }), detail: errDetail(e), error: true }));
    },
    [notify],
  );
  const setSort = useCallback((k: SortKey) => savePrefs({ sort: k, order: defaultOrder(k) }), [savePrefs]);
  const toggleOrder = useCallback(() => savePrefs({ sort: prefs.sort, order: prefs.order === "asc" ? "desc" : "asc" }), [savePrefs, prefs]);

  const tree = useMemo(() => buildFolderTree(folders, meetings), [folders, meetings]);
  const tags = useMemo(() => collectTags(meetings), [meetings]);

  // 지워진 폴더나 더는 쓰지 않는 태그를 걸러내기에 남겨 두지 않는다 (목록이 이유 없이 비어 보이지 않게)
  useEffect(() => {
    setFilter((f) => {
      const ids = new Set(folders.map((x) => x.id));
      const have = new Set(tags.map((t) => foldKey(t.tag)));
      const folder = f.folder && f.folder !== "none" && !ids.has(f.folder) ? null : f.folder;
      const keep = f.tags.filter((t) => have.has(foldKey(t)));
      return folder === f.folder && keep.length === f.tags.length ? f : { ...f, folder, tags: keep };
    });
  }, [folders, tags]);

  const setQuery = useCallback((query: string) => setFilter((f) => ({ ...f, query })), []);
  const toggleTag = useCallback(
    (tag: string) =>
      setFilter((f) => (f.tags.some((t) => foldKey(t) === foldKey(tag)) ? { ...f, tags: f.tags.filter((t) => foldKey(t) !== foldKey(tag)) } : { ...f, tags: [...f.tags, tag] })),
    [],
  );
  const selectFolder = useCallback((folder: string | "none" | null) => setFilter((f) => ({ ...f, folder: f.folder === folder ? null : folder })), []);
  const clearFilters = useCallback(() => setFilter(NO_FILTER), []);

  const patchNote = useCallback(
    async (id: string, patch: MetaPatch): Promise<boolean> => {
      if (editQueue.isBlocked(id)) {
        notify({ text: EDIT_BLOCKED, error: true });
        return false;
      }
      const before = metaOf(meetingsRef.current.find((m) => m.id === id));
      setMeetings((ms) => applyMeta(ms, id, patch));
      try {
        const stored = await editQueue.run(id, () => api.noteMeta(id, patch));
        if (stored === undefined) throw new Error(EDIT_BLOCKED);
        setMeetings((ms) => applyMeta(ms, id, stored));
        return true;
      } catch (e) {
        const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof NoteMeta]])) as MetaPatch;
        setMeetings((ms) => applyMeta(ms, id, undo));
        notify({ text: errText(e), detail: errDetail(e), error: true });
        return false;
      }
    },
    [setMeetings, notify],
  );
  const setFavorite = useCallback((id: string, favorite: boolean) => patchNote(id, { favorite }), [patchNote]);
  const setTags = useCallback((id: string, next: string[]) => patchNote(id, { tags: next }), [patchNote]);
  const moveNote = useCallback(
    async (id: string, folder: string | null) => {
      const ok = await patchNote(id, { folder });
      if (ok) {
        const title = meetingsRef.current.find((m) => m.id === id)?.title || t("제목 없음");
        notify({ text: folder ? t("‘{title}’ 노트를 ‘{folder}’ 폴더로 옮겼습니다", { title, folder: folderPath(foldersRef.current, folder) }) : t("‘{title}’ 노트를 폴더에서 뺐습니다", { title }) });
      }
      return ok;
    },
    [patchNote, notify],
  );

  const folderOp = useCallback(
    async (op: () => Promise<Folder[]>): Promise<Folder[] | null> => {
      try {
        const next = await op();
        setFolders(next);
        return next;
      } catch (e) {
        notify({ text: errText(e), detail: errDetail(e), error: true });
        return null;
      }
    },
    [setFolders, notify],
  );
  const createFolder = useCallback(
    async (name: string, parent: string | null) => {
      const before = new Set(foldersRef.current.map((f) => f.id));
      const next = await folderOp(() => api.foldersCreate(name, parent));
      return next?.find((f) => !before.has(f.id)) ?? null;
    },
    [folderOp],
  );
  const renameFolder = useCallback(async (id: string, name: string) => (await folderOp(() => api.foldersRename(id, name))) !== null, [folderOp]);
  const moveFolder = useCallback(async (id: string, parent: string | null) => (await folderOp(() => api.foldersMove(id, parent))) !== null, [folderOp]);
  const deleteFolder = useCallback(
    async (id: string) => {
      const next = await folderOp(() => api.foldersDelete(id));
      if (next) await refresh(); // 노트가 상위 폴더로 올라갔다
      return next !== null;
    },
    [folderOp, refresh],
  );
  const requestTagFocus = useCallback((id: string) => setTagFocus({ id, nonce: Date.now() }), []);

  const metaById = useCallback((id: string) => metaOf(meetingsRef.current.find((m) => m.id === id)), []);

  return useMemo(
    () => ({
      folders, tree, tags, filter, setQuery, toggleTag, selectFolder, clearFilters,
      sort: prefs.sort, order: prefs.order, setSort, toggleOrder,
      metaOf: metaById, setFavorite, setTags, moveNote, createFolder, renameFolder, moveFolder, deleteFolder, tagFocus, requestTagFocus,
    }),
    [folders, tree, tags, filter, setQuery, toggleTag, selectFolder, clearFilters, prefs, setSort, toggleOrder, metaById, setFavorite, setTags, moveNote, createFolder, renameFolder, moveFolder, deleteFolder, tagFocus, requestTagFocus],
  );
}
