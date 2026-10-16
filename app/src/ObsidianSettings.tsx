// 설정의 Obsidian 섹션: 볼트와 오디오 함께 보내기. 저장 단추 없이 바로 저장한다 (set_obsidian)
import { useState } from "react";
import { api, errText, type Settings } from "./api";
import { Button } from "@/components/ui/button";
import { Row, Section } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { ObsidianLogo } from "@/components/ui/obsidian-logo";
import { AUDIO_HINT, AUDIO_LABEL, OBSIDIAN_SECTION, pickVault, VAULT_HINT, VAULT_LABEL, VAULT_NONE, VAULT_PICK } from "./obsidian";

export function ObsidianSection({ initial }: { initial: Settings }) {
  const [vault, setVault] = useState(initial.obsidian_vault ?? "");
  const [audio, setAudio] = useState(!!initial.obsidian_audio);
  const [err, setErr] = useState<string | null>(null);
  const run = async (f: () => Promise<void>) => {
    try {
      await f();
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <Section title={OBSIDIAN_SECTION} icon={<ObsidianLogo />}>
      <Row
        label={VAULT_LABEL}
        hint={VAULT_HINT}
        control={
          <Button variant="outline" size="sm" onClick={() => void run(async () => setVault((await pickVault(audio)) ?? vault))}>
            {VAULT_PICK}
          </Button>
        }
        below={
          <>
            <p className="m-0 truncate font-mono text-xs text-muted-foreground" title={vault || undefined}>
              {vault || VAULT_NONE}
            </p>
            {err && (
              <p className="m-0 mt-1 text-xs text-destructive" role="alert">
                {err}
              </p>
            )}
          </>
        }
      />
      <Row
        label={AUDIO_LABEL}
        hint={AUDIO_HINT}
        htmlFor="obsidian-audio"
        control={<Switch id="obsidian-audio" checked={audio} onChange={(e) => void run(async () => (await api.setObsidian(vault, e.target.checked), setAudio(e.target.checked)))} />}
      />
    </Section>
  );
}
