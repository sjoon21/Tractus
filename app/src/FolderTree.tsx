// 사이드바의 폴더 나무: 폴더를 누르면 그 폴더(와 하위 폴더)의 노트만 목록에 보인다. 노트 줄을 폴더에 끌어 놓으면 옮긴다 (같은 일을 줄의 `…` 메뉴 `폴더로 이동`과 노트 머리의 폴더 단추로도 한다).
// 폴더 만들기·이름 바꾸기는 줄 안 입력창, 삭제는 확인 대화상자다 (노트는 지우지 않고 상위로 올린다).
import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { FolderPicker } from "./FolderPicker";
import { NameInput } from "./NameInput";
import { ItemMenu, Popover } from "./Popover";
import { DROP_ATTR, DROP_NONE, onNoteDrop, useDragOver } from "./noteDrag";
import { canNest, dropOutcome, FOLDER_DEPTH, folderOf, siblingsOf, subtreeIds, type Folder, type TreeNode } from "./organize";
import { useOrganize } from "./useOrganize";

type Edit = { kind: "create"; parent: string | null } | { kind: "rename"; id: string };

export function FolderTree({ expanded, onToggle, onExpand, notes }: { expanded: ReadonlySet<string>; onToggle: (id: string) => void; onExpand: (id: string) => void; notes: readonly { folder?: string | null }[] }) {
  const org = useOrganize();
  const [edit, setEdit] = useState<Edit | null>(null);
  const over = useDragOver(); // 끌어 온 노트가 올라와 있는 폴더 ("none"은 폴더 없음 줄)
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [del, setDel] = useState<{ folder: Folder; own: number; kids: number } | null>(null);
  const [moving, setMoving] = useState<{ folder: Folder; anchor: HTMLElement } | null>(null); // 폴더 위치 고르기
  const [busy, setBusy] = useState(false);
  const known = new Set(org.folders.map((f) => f.id));
  const loose = notes.filter((n) => folderOf(n, known) === null).length;

  // 노트 줄을 끌어 이 폴더 줄 위에서 놓으면 옮긴다 (noteDrag.ts: 포인터 이벤트)
  useEffect(
    () =>
      onNoteDrop((id, target) => {
        if (dropOutcome(org.metaOf(id), target, known).move) void org.moveNote(id, target);
      }),
  );
  const dropKey = (target: string | null) => ({ [DROP_ATTR]: target ?? DROP_NONE });

  const row = (n: TreeNode) => {
    const f = n.folder;
    const open = expanded.has(f.id);
    if (edit?.kind === "rename" && edit.id === f.id)
      return (
        <li key={f.id} className="folder-row is-editing" style={{ paddingLeft: 8 + (n.depth - 1) * 14 }}>
          <NameInput
            initial={f.name}
            self={f.id}
            siblings={siblingsOf(org.folders, f.parent)}
            ariaLabel={`폴더 ${f.name} 이름 (Enter 저장, Esc 취소)`}
            cancelOnBlur
            onCancel={() => setEdit(null)}
            onSubmit={async (name) => {
              setEdit(null);
              if (name !== f.name) await org.renameFolder(f.id, name);
            }}
          />
        </li>
      );
    return (
      <li key={f.id} className={`folder-row ${over === f.id ? "is-over" : ""}`} style={{ paddingLeft: 8 + (n.depth - 1) * 14 }} {...dropKey(f.id)}>
        {n.children.length > 0 ? (
          <button type="button" className="folder-twisty" aria-expanded={open} aria-label={`${f.name} ${open ? "접기" : "펼치기"}`} onClick={() => onToggle(f.id)}>
            <span aria-hidden>{open ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span className="folder-twisty is-empty" aria-hidden />
        )}
        <button type="button" className="folder-name" aria-pressed={org.filter.folder === f.id} title={`${f.name} 폴더의 노트만 보기`} onClick={() => org.selectFolder(f.id)}>
          <span className="folder-glyph" aria-hidden />
          <span className="folder-label">{f.name}</span>
          <span className="count tnum">{n.count}</span>
        </button>
        <button
          type="button"
          className="row-more"
          aria-label={`${f.name} 폴더 메뉴`}
          aria-haspopup="menu"
          aria-expanded={menu?.id === f.id}
          onClick={(e) => {
            const anchor = e.currentTarget;
            setMenu((m) => (m?.id === f.id ? null : { id: f.id, anchor }));
          }}
        >
          …
        </button>
      </li>
    );
  };

  const flat = (nodes: readonly TreeNode[]): React.ReactNode[] =>
    nodes.flatMap((n) => [
      row(n),
      ...(expanded.has(n.folder.id) ? flat(n.children) : []),
      ...(edit?.kind === "create" && edit.parent === n.folder.id ? [createRow(n.folder.id, n.depth + 1)] : []),
    ]);

  const createRow = (parent: string | null, depth: number) => (
    <li key={`new-${parent ?? "root"}`} className="folder-row is-editing" style={{ paddingLeft: 8 + (depth - 1) * 14 }}>
      <NameInput
        siblings={siblingsOf(org.folders, parent)}
        ariaLabel={parent ? "새 하위 폴더 이름 (Enter 만들기, Esc 취소)" : "새 폴더 이름 (Enter 만들기, Esc 취소)"}
        placeholder="새 폴더 이름"
        cancelOnBlur
        onCancel={() => setEdit(null)}
        onSubmit={async (name) => {
          setEdit(null);
          const made = await org.createFolder(name, parent);
          if (made && parent) onExpand(parent);
        }}
      />
    </li>
  );

  const target = menu && org.folders.find((f) => f.id === menu.id);
  const confirm = async () => {
    if (!del) return;
    setBusy(true);
    await org.deleteFolder(del.folder.id);
    setBusy(false);
    setDel(null);
  };
  const parentName = del?.folder.parent ? (org.folders.find((f) => f.id === del.folder.parent)?.name ?? "") : "";
  const dest = parentName ? `‘${parentName}’ 폴더로` : "폴더 없음으로"; // 조사: 폴더+로, 없음+으로

  return (
    <>
      {org.tree.length === 0 && edit?.kind !== "create" && <p className="nav-note side-hint">폴더를 만들어 노트를 나눠 두세요.</p>}
      <ul className="folder-list" aria-label="폴더">
        {flat(org.tree)}
        {edit?.kind === "create" && edit.parent === null && createRow(null, 1)}
        {org.tree.length > 0 && (
          <li className={`folder-row ${over === "none" ? "is-over" : ""}`} {...dropKey(null)}>
            <span className="folder-twisty is-empty" aria-hidden />
            <button type="button" className="folder-name is-none" aria-pressed={org.filter.folder === "none"} title="폴더에 넣지 않은 노트만 보기 (노트를 놓으면 폴더에서 뺍니다)" onClick={() => org.selectFolder("none")}>
              <span className="folder-label">폴더 없음</span>
              <span className="count tnum">{loose}</span>
            </button>
          </li>
        )}
      </ul>
      <button type="button" className="text-button side-add" onClick={() => setEdit({ kind: "create", parent: null })}>
        + 새 폴더
      </button>
      {menu && target && (
        <Popover anchor={menu.anchor} label={`${target.name} 폴더 메뉴`} onClose={() => setMenu(null)}>
          {(close) => (
            <ItemMenu
              close={close}
              entries={[
                {
                  id: "child",
                  label: "하위 폴더 만들기",
                  disabled: canNest(org.folders, target.id) ? undefined : FOLDER_DEPTH,
                  onSelect: () => {
                    onExpand(target.id);
                    setEdit({ kind: "create", parent: target.id });
                  },
                },
                { id: "rename", label: "이름 바꾸기", onSelect: () => setEdit({ kind: "rename", id: target.id }) },
                { id: "move", label: "다른 폴더로 옮기기…", onSelect: () => setMoving({ folder: target, anchor: menu.anchor }) },
                {
                  id: "delete",
                  label: "삭제…",
                  danger: true,
                  divider: true,
                  onSelect: () => setDel({ folder: target, own: notes.filter((x) => x.folder === target.id).length, kids: org.folders.filter((f) => f.parent === target.id).length }),
                },
              ]}
            />
          )}
        </Popover>
      )}
      {moving && (
        <FolderPicker
          anchor={moving.anchor}
          current={moving.folder.parent}
          exclude={subtreeIds(org.folders, moving.folder.id)}
          onClose={() => setMoving(null)}
          onPick={(parent) => {
            if (parent === (moving.folder.parent ?? null)) return;
            void org.moveFolder(moving.folder.id, parent).then((ok) => ok && parent && onExpand(parent));
          }}
        />
      )}
      {del && (
        <ConfirmDialog
          title={`‘${del.folder.name}’ 폴더를 삭제할까요?`}
          body={`폴더만 삭제되고 노트는 지워지지 않습니다. 폴더 안의 노트 ${del.own}개는 ${dest} 옮겨지고, 하위 폴더 ${del.kids}개는 한 단계 위로 올라갑니다.`}
          cancelLabel="취소"
          confirmLabel={busy ? "삭제하는 중…" : "폴더 삭제"}
          busy={busy}
          onCancel={() => setDel(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </>
  );
}
