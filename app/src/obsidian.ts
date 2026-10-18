// Obsidian으로 보내기 (docs/design/obsidian-export.md, WORDS.md §4.23): 내보내기 메뉴의 한 항목과 설정 두 개.
import { ask } from "@tauri-apps/plugin-dialog";
import { api, errText, type ObsidianSent } from "./api";
import type { Notify, Toast } from "./App";
import { baseName } from "./lib";
import { pickPath } from "./pathFix";
import { t } from "./i18n";

export const OBSIDIAN_ITEM = { label: "Obsidian", note: t("볼트로 보내기") };
export const OBSIDIAN_SECTION = "Obsidian";
export const VAULT_LABEL = t("볼트");
export const VAULT_HINT = t("노트를 볼트의 Tractus 폴더에 Markdown으로 보냅니다.");
export const VAULT_NONE = t("고르지 않음");
export const VAULT_PICK = t("찾아보기…");
export const AUDIO_LABEL = t("오디오도 함께 보내기");
export const AUDIO_HINT = t("볼트를 동기화하면 오디오도 올라갑니다 (1시간에 약 14MB).");
export const OPEN_LABEL = t("Obsidian에서 열기");
export const EDITED_ASK = t("볼트의 이 노트에 Obsidian에서 고친 내용이 있습니다. 덮어쓰면 고친 내용은 사라집니다.");

/** 보낸 결과의 알림. edited는 여기 오지 않는다 (먼저 묻는다) */
export function sentToast(r: ObsidianSent, open: (path: string) => void): Toast {
  const name = baseName(r.path).replace(/\.md$/, "");
  return {
    text: r.status === "unchanged" ? t("이미 보낸 내용과 같습니다 — {name}", { name }) : t("Obsidian으로 보냈습니다 — {name}", { name }),
    action: { label: OPEN_LABEL, run: () => open(r.path) },
  };
}

/** 볼트를 고른다 (취소하면 null). 고르면 바로 저장한다 */
export async function pickVault(audio: boolean): Promise<string | null> {
  const dir = await pickPath(true);
  if (dir) await api.setObsidian(dir, audio);
  return dir;
}

/** 노트를 보낸다. 볼트를 아직 안 골랐으면 먼저 고르게 하고, 볼트에서 고친 파일이면 덮어쓸지 묻는다 */
export async function sendToObsidian(id: string, summary: string | undefined, notify: Notify): Promise<void> {
  const open = (path: string) => void api.obsidianOpen(path).catch((e) => notify({ text: errText(e), error: true }));
  try {
    const s = await api.getSettings();
    if (!s.obsidian_vault && !(await pickVault(!!s.obsidian_audio))) return;
    let r = await api.obsidianSend(id, summary, false);
    if (r.status === "edited") {
      const ok = await ask(EDITED_ASK, { title: t("Obsidian으로 보내기"), kind: "warning", okLabel: t("덮어쓰기"), cancelLabel: t("취소") });
      if (!ok) return;
      r = await api.obsidianSend(id, summary, true);
    }
    notify(sentToast(r, open));
  } catch (e) {
    notify({ text: t("Obsidian으로 보내지 못했습니다: {error}", { error: errText(e) }), error: true });
  }
}
