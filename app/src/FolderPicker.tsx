// 노트를 넣을 폴더 고르기: `폴더 없음`, 폴더 나무, `새 폴더…`. 노트 머리의 폴더 단추와 사이드바 줄 메뉴의 `폴더로 이동`이 같이 쓴다.
// `새 폴더…`는 최상위에 폴더를 만들고 그 폴더로 노트를 옮긴다 (하위 폴더는 사이드바의 폴더 메뉴에서 만든다).
import { useMemo, useState } from "react";
import { t } from "./i18n";
import { NameInput } from "./NameInput";
import { ItemMenu, Popover, type MenuEntry } from "./Popover";
import { siblingsOf, type TreeNode } from "./organize";
import { useOrganize } from "./useOrganize";

const flatten = (nodes: readonly TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);

/** exclude: 고르기 목록에서 뺄 폴더 (폴더를 옮길 때 그 폴더와 하위 폴더). 폴더를 옮길 때는 `새 폴더…`가 없고 맨 위 줄이 `최상위`다 */
export function FolderPicker({
  anchor,
  current,
  onPick,
  onClose,
  exclude,
}: {
  anchor: HTMLElement;
  current: string | null;
  onPick: (folder: string | null) => void;
  onClose: () => void;
  exclude?: ReadonlySet<string>;
}) {
  const org = useOrganize();
  const [creating, setCreating] = useState(false);
  const rows = useMemo(() => flatten(org.tree).filter((n) => !exclude?.has(n.folder.id)), [org.tree, exclude]);
  const known = new Set(org.folders.map((f) => f.id));
  const at = current && known.has(current) ? current : null;

  const entries: MenuEntry[] = [
    { id: "none", label: exclude ? t("최상위") : t("폴더 없음"), checked: at === null, onSelect: () => onPick(null) },
    ...rows.map((n) => ({ id: n.folder.id, label: n.folder.name, indent: n.depth - 1, checked: at === n.folder.id, onSelect: () => onPick(n.folder.id) })),
    ...(exclude ? [] : [{ id: "new", label: t("새 폴더…"), divider: true, stay: true, onSelect: () => setCreating(true) }]),
  ];
  return (
    <Popover anchor={anchor} label={creating ? t("새 폴더 만들기") : exclude ? t("옮길 위치 고르기") : t("폴더 고르기")} role={creating ? "group" : "menu"} onClose={onClose}>
      {(close) =>
        creating ? (
          <div className="p-1">
            <NameInput
              ariaLabel={t("새 폴더 이름 (Enter 만들기, Esc 취소)")}
              placeholder={t("새 폴더 이름")}
              siblings={siblingsOf(org.folders, null)}
              onCancel={() => close(true)}
              onSubmit={async (name) => {
                const made = await org.createFolder(name, null);
                if (made) onPick(made.id); // 만든 폴더로 옮긴다
                close(true);
              }}
            />
          </div>
        ) : (
          <ItemMenu entries={entries} close={close} />
        )
      }
    </Popover>
  );
}
