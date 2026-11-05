// 창에 파일 끌어다 놓기: 끌어 오는 동안 덮개를 보이고, 놓으면 가져오기 줄에 세운다.
// 글만 있는 노트를 보고 있고 녹음을 추가할 수 있으면(dropNote) 파일 하나는 그 노트에 추가할지 먼저 묻는다(되돌릴 수 없다).
// 앱 안에서 끄는 것(화자 합치기)은 경로가 없어서 무시된다
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import type { AttachTarget } from "./attach";

export function useFileDrop(enqueue: (paths: string[]) => void) {
  const [dropping, setDropping] = useState(false);
  const [dropCount, setDropCount] = useState(0);
  /** 파일 하나를 놓으면 추가할 노트. 화면이 그릴 때마다 정한다 */
  const dropNote = useRef<AttachTarget | null>(null);
  const [dropAsk, setDropAsk] = useState<{ target: AttachTarget; path: string } | null>(null);
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") {
        setDropping(payload.paths.length > 0);
        setDropCount(payload.paths.length);
      } else if (payload.type === "leave") setDropping(false);
      else if (payload.type === "drop") {
        setDropping(false);
        if (dropNote.current && payload.paths.length === 1) setDropAsk({ target: dropNote.current, path: payload.paths[0] });
        else if (payload.paths.length) enqueue(payload.paths);
      }
    });
    return () => void un.then((f) => f());
  }, [enqueue]);
  return { dropping, dropCount, dropNote, dropAsk, setDropAsk };
}
