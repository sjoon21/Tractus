// 설정 › AI 요약·질문: 서비스(Upstage·OpenAI·Claude·Gemini·직접 입력)마다 주소·API 키·AI 모델을 따로 두고(등록됨/미등록), 연결 테스트와 기본 서비스를 고른다 (docs/desktop.md §2.14).
// 키는 입력창에서 Rust로 한 번 가고, 화면에 다시 채우지 않는다. 서비스마다 키를 따로 보관한다. 요약·질문은 등록된 서비스 중에서 그때그때 고른다 (LlmServicePicker).
import { useEffect, useRef, useState } from "react";
import { api, errDetail, errText, type LlmSettings } from "./api";
import { PROVIDERS } from "./ask";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmbeddingSection } from "./EmbeddingSettings";
import { ErrorDetail } from "./ErrorDetail";
import { errorView, isImeKey } from "./lib";
import { useCapabilities } from "./useCapabilities";
import {
  baseUrlWarning,
  chatModels,
  defaultBaseUrl,
  defaultModel,
  ENV_OVERRIDE_NOTE,
  formProblem,
  isLlmChoice,
  keyProblem,
  keyReady,
  keyStatusText,
  KEY_CHANGED,
  LLM_CHOICES,
  LOCAL_ONLY_NOTE,
  normalizeBaseUrl,
  PRIVACY_NOTE,
  PROVIDER_NOTE,
  TEST_HINT,
  testOkText,
  toForm,
  toStored,
  type LlmForm,
} from "./llmKey";

type Msg = { text: string; detail: string | null; ok?: boolean };

const formOf = (s: LlmSettings, provider: string): LlmForm => toForm(provider, s.profiles[provider]?.base_url ?? "", s.profiles[provider]?.model ?? "");

export function LlmKeySection() {
  const [cfg, setCfg] = useState<LlmSettings | null>(null);
  const [form, setForm] = useState<LlmForm | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<Msg | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]); // 서비스에서 불러온 AI 모델 이름 (고르는 목록)
  const composing = useRef(false);
  const { refresh: refreshCaps } = useCapabilities();

  const fail = (e: unknown) => setMsg({ text: errText(e), detail: errDetail(e) });
  const load = () =>
    api.llmSettings().then((s) => {
      setCfg(s);
      setForm((f) => f ?? formOf(s, s.default)); // 입력 중인 내용은 다시 읽어도 지키지 않는다: 처음 한 번만 채운다
    }, fail);
  // 키·스마트 검색 방식이 바뀌면 기능 점검(스마트 검색)도 다시 한다
  const changed = () => {
    window.dispatchEvent(new Event(KEY_CHANGED));
    void refreshCaps();
  };
  useEffect(() => void load(), []);

  if (!form || !cfg) {
    return (
      <section className="voices" aria-labelledby="llm-key-title">
        <h2 id="llm-key-title">AI 요약·질문</h2>
        {msg ? (
          <p className="field-hint" role="status">
            {msg.text}
            <ErrorDetail detail={msg.detail} />
          </p>
        ) : (
          <p className="field-hint">{keyStatusText(null)}</p>
        )}
      </section>
    );
  }

  const info = PROVIDERS[form.provider];
  const choice = isLlmChoice(form.provider) ? form.provider : null;
  const saved = !!cfg.saved[form.provider];
  const isDefault = cfg.default === form.provider;
  const url = normalizeBaseUrl(form.baseUrl);
  const warning = "url" in url ? baseUrlWarning(url.url) : null;
  const urlText = "url" in url ? url.url : "";
  const ready = keyReady(form.provider, urlText || defaultBaseUrl(form.provider), saved);
  const change = (patch: Partial<LlmForm>) => setForm({ ...form, ...patch });

  /** 검사 → 선택(서비스·주소·AI 모델) 저장 → 입력한 키 저장. 성공하면 true. 키를 입력하지 않았으면 저장된 키를 그대로 둔다 */
  const save = async (needModel = true): Promise<boolean> => {
    const problem = formProblem(form, needModel) ?? (key.trim() || !ready ? keyProblem(key) : null);
    if (problem) {
      setMsg({ text: problem, detail: null });
      return false;
    }
    const stored = toStored(form);
    try {
      await api.llmSettingsSave(form.provider, stored.baseUrl, stored.model);
      if (key.trim()) await api.llmKeySave(form.provider, key);
      if (key.trim() && cfg.registered.length === 0) await api.llmDefaultSave(form.provider); // 처음 등록한 서비스가 기본이 된다
      setKey(""); // 저장한 키는 화면에 남기지 않는다
      changed();
      await load();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const onSave = async () => {
    setBusy(true);
    setMsg(null);
    if (await save()) setMsg({ text: "AI 서비스 설정을 저장했습니다.", detail: null, ok: true });
    setBusy(false);
  };

  const onTest = async () => {
    setBusy(true);
    setMsg({ text: "연결을 확인하는 중…", detail: null });
    try {
      if (!(await save())) return;
      const r = await api.llmTest(form.provider);
      if (r.ok) return setMsg({ text: testOkText(r), detail: null, ok: true });
      const v = errorView(r.message, r.code, "연결하지 못했습니다");
      setMsg({ text: v.text, detail: v.detail });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.llmKeyDelete(form.provider);
      setAsking(false);
      setMsg({ text: "API 키를 삭제했습니다.", detail: null });
      changed();
      await load();
    } catch (e) {
      setAsking(false);
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const select = (provider: string) => {
    setForm(formOf(cfg, provider));
    setKey("");
    setMsg(null);
    setModels([]);
  };

  const makeDefault = async () => {
    setBusy(true);
    try {
      await api.llmDefaultSave(form.provider);
      setMsg({ text: `기본 AI 서비스를 ${info?.label ?? form.provider}(으)로 바꿨습니다.`, detail: null, ok: true });
      changed();
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** 입력한 내용을 저장한 뒤 서비스가 아는 AI 모델 이름을 불러와 고르게 한다 */
  const loadModels = async () => {
    setBusy(true);
    setMsg({ text: "AI 모델 목록을 불러오는 중…", detail: null });
    try {
      if (!(await save(false))) return; // 목록을 보려는 것이니 AI 모델 이름은 없어도 된다
      const r = await api.llmModels(form.provider);
      if (r.models.length > 0) {
        const list = chatModels(r.models);
        setModels(list);
        return setMsg({ text: `AI 모델 ${list.length}개를 불러왔습니다. AI 모델 칸에서 고를 수 있습니다.`, detail: null, ok: true });
      }
      const v = errorView(r.message, r.code, "불러온 AI 모델이 없습니다");
      setMsg({ text: v.text, detail: v.detail });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const model = defaultModel(form.provider);
  return (
    <section className="voices" aria-labelledby="llm-key-title">
      <h2 id="llm-key-title">AI 요약·질문</h2>
      <p className="field-hint">
        {PRIVACY_NOTE} {LOCAL_ONLY_NOTE}
      </p>
      {cfg.env_override && <p className="field-hint">{ENV_OVERRIDE_NOTE}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
      >
        <ul className="llm-services" aria-label="AI 서비스">
          {LLM_CHOICES.map((p) => {
            const on = cfg.registered.includes(p);
            return (
              <li key={p}>
                <button type="button" className="llm-service" aria-pressed={form.provider === p} disabled={busy} onClick={() => select(p)}>
                  <span>
                    {PROVIDERS[p].label}
                    {p === "custom" ? " (OpenAI 호환)" : ""}
                  </span>
                  <span className={`badge ${on ? "is-on" : ""}`}>{on ? "등록됨" : "미등록"}</span>
                  {on && cfg.default === p && <span className="badge">기본</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {choice && <p className="field-hint">{PROVIDER_NOTE[choice]}</p>}
        <label className="field">
          <span className="field-label">서비스 주소</span>
          <input
            type="text"
            name="llm-base-url"
            value={form.baseUrl}
            placeholder={defaultBaseUrl(form.provider) || "https://…/v1"}
            onChange={(e) => change({ baseUrl: e.target.value })}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {warning && <span className="field-hint">{warning}</span>}
        </label>
        <label className="field">
          <span className="field-label">{info?.label ?? form.provider} API 키</span>
          <input
            type="password"
            name="llm-api-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isImeKey(e.nativeEvent, composing.current)) e.preventDefault(); // 한글 조합 중 Enter는 저장이 아니다
            }}
            autoComplete="new-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">AI 모델</span>
          <input
            type="text"
            name="llm-model"
            list="llm-model-list"
            value={form.model}
            placeholder={model || "AI 모델 이름을 입력하세요"}
            onChange={(e) => change({ model: e.target.value })}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <datalist id="llm-model-list">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <div className="settings-actions">
          <button className="primary-button" type="submit" disabled={busy}>
            저장
          </button>
          <button className="ghost-button" type="button" disabled={busy} onClick={() => void onTest()}>
            연결 테스트
          </button>
          <button className="ghost-button" type="button" disabled={busy} onClick={() => void loadModels()}>
            AI 모델 목록 불러오기
          </button>
          <button className="ghost-button" type="button" disabled={busy || !ready || isDefault} onClick={() => void makeDefault()}>
            기본으로 사용
          </button>
          <button className="ghost-button" type="button" disabled={busy || !saved} onClick={() => setAsking(true)}>
            삭제
          </button>
          <span className="field-hint" role="status">
            {keyStatusText(saved)}
          </span>
        </div>
        <span className="field-hint">{TEST_HINT}</span>
      </form>
      <EmbeddingSection cfg={cfg} onChanged={async () => {
        changed();
        await load();
      }} />
      {msg && (
        <p className="field-hint" role="status">
          {msg.text}
          <ErrorDetail detail={msg.detail} />
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title="API 키를 삭제할까요?"
          body={`이 Mac에 저장된 ${info?.label ?? ""} 키를 지웁니다. 키를 다시 등록하기 전에는 이 서비스로 요약과 질문을 쓸 수 없습니다.`}
          cancelLabel="취소"
          confirmLabel="삭제"
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => void remove()}
        />
      )}
    </section>
  );
}
