// 시작 점검·설정에서 경로를 고르고 저장한다 (Tauri 대화상자 + 설정 저장). 무엇을 쓸지는 paths.ts의 fixPatch가 정한다.
import { open } from "@tauri-apps/plugin-dialog";
import { api, type Settings } from "./api";
import type { FixKind } from "./caps";
import { fixPatch, HOME_MOVED, needsFolder, needsPick } from "./paths";

export const pickPath = async (directory: boolean): Promise<string | null> => {
  const picked = await open({ multiple: false, directory });
  return typeof picked === "string" ? picked : null;
};

/** 설정 한 칸만 바꿔 저장한다. 다른 화면에서 바뀐 값(녹음 방식 등)을 덮어쓰지 않게 방금 읽은 설정에 얹는다 */
export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  await api.saveSettings({ ...(await api.getSettings()), ...patch });
}

/** 고치는 단추 하나를 처리한다. 사용자에게 보일 결과 문장을, 취소했으면 null을 돌려준다 */
export async function runPathFix(kind: FixKind): Promise<string | null> {
  const picked = needsPick(kind) ? await pickPath(needsFolder(kind)) : null;
  const patch = fixPatch(kind, picked);
  if (!patch) return null;
  await patchSettings(patch);
  return kind === "pick-home" ? HOME_MOVED : "저장했습니다.";
}
