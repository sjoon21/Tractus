//! 요약 유형(템플릿)과 한 노트의 여러 요약 (docs/desktop.md §2.13). 만들기·유형 저장·삭제는 코어(`tractus summarize --template/--custom`,
//! `templates`, `summaries`)가 하고 앱은 인수·stdin JSON만 만든다. 요약 목록은 파일(summary.json, summaries/<key>.json)을 느슨하게 읽는다.
//! 앱은 모든 key·ID를 모양으로 검증한 뒤 인수에 넣는다 (경로 조작·옵션 주입 방지).

use crate::i18n::{t, tv};
use super::{blocking, cancel_index, hold, is_meeting_id, meetings, release, run_tractus, stdout_json, AppState, BusyGuard};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

const MAX_PROMPT: usize = 4000;
const MAX_NAME: usize = 40;
const MAX_DESC: usize = 100;
/// 기본 요약(summary.json)의 key
const DEFAULT_KEY: &str = "meeting";

fn is_hex8(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 내 요약 유형 ID: `u-` + 16진수 8자
pub fn is_user_template_id(id: &str) -> bool {
    id.strip_prefix("u-").is_some_and(is_hex8)
}

/// 기본 유형(소문자 3–12자) 또는 내 유형 ID
pub fn is_template_id(id: &str) -> bool {
    is_user_template_id(id) || ((3..=12).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase()))
}

/// 요약 key: 유형 ID 또는 한 번만 쓴 직접 요약(`c-` + 16진수 8자)
pub fn is_summary_key(key: &str) -> bool {
    is_template_id(key) || key.strip_prefix("c-").is_some_and(is_hex8)
}

/// 직접 쓴 요약 방법으로 요약할 때 stdin으로 넘기는 값
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct CustomSummary {
    pub prompt: String,
    /// 이름을 주면 내 요약 유형으로도 저장한다
    #[serde(default)]
    pub save_as: Option<String>,
    /// 한 번만 쓴 요약(c-…)을 다시 만들 때 같은 key로 덮어쓴다
    #[serde(default)]
    pub key: Option<String>,
}

fn check_prompt(prompt: &str) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(t("요약 방법을 입력하세요."));
    }
    if prompt.chars().count() > MAX_PROMPT {
        return Err(t("요약 방법은 4,000자까지 쓸 수 있습니다."));
    }
    Ok(prompt.to_string())
}

fn check_name(name: &str) -> Result<String, String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(t("이름을 입력하세요."));
    }
    if name.chars().count() > MAX_NAME {
        return Err(t("이름은 40자까지 쓸 수 있습니다."));
    }
    Ok(name)
}

/// `tractus summarize <노트> --progress-json [--template <ID> | --custom]`. 유형을 주지 않으면 기본(회의록)
pub fn summarize_args(id: &str, template: Option<&str>, custom: bool) -> Result<Vec<String>, String> {
    if !is_meeting_id(id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    let mut args: Vec<String> = ["summarize", id, "--progress-json"].map(String::from).to_vec();
    match (template, custom) {
        (Some(_), true) => return Err(t("요약 유형과 직접 입력은 함께 쓸 수 없습니다.")),
        (Some(t), false) if is_template_id(t) => args.extend(["--template".into(), t.into()]),
        (Some(_), false) => return Err(t("요약 유형을 찾을 수 없습니다.")),
        (None, true) => args.push("--custom".into()),
        (None, false) => {}
    }
    Ok(args)
}

/// `--custom`의 stdin JSON {"prompt", "save_as"?, "key"?}. 요약 방법은 인수가 아니라 stdin으로 넘긴다
pub fn custom_input(c: &CustomSummary) -> Result<String, String> {
    let mut body = serde_json::Map::new();
    body.insert("prompt".into(), json!(check_prompt(&c.prompt)?));
    if let Some(name) = c.save_as.as_deref().filter(|n| !n.trim().is_empty()) {
        body.insert("save_as".into(), json!(check_name(name)?));
    } else if let Some(key) = &c.key {
        if !key.strip_prefix("c-").is_some_and(is_hex8) {
            return Err(t("요약을 찾을 수 없습니다."));
        }
        body.insert("key".into(), json!(key));
    }
    Ok(Value::Object(body).to_string())
}

/// `tractus templates save --name=<이름> [--description=<설명>] [--id <ID>]`와 stdin JSON {"prompt"}.
/// `--name=` 꼴로 붙인다: "-박" 같은 이름을 옵션으로 읽지 않게
pub fn save_template_args(id: Option<&str>, name: &str, description: &str, prompt: &str) -> Result<(Vec<String>, String), String> {
    let name = check_name(name)?;
    let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
    if description.chars().count() > MAX_DESC {
        return Err(t("설명은 100자까지 쓸 수 있습니다."));
    }
    let mut args: Vec<String> = vec!["templates".into(), "save".into(), format!("--name={name}"), format!("--description={description}")];
    if let Some(id) = id {
        if !is_user_template_id(id) {
            return Err(t("요약 유형을 찾을 수 없습니다."));
        }
        args.extend(["--id".into(), id.into()]);
    }
    Ok((args, json!({ "prompt": check_prompt(prompt)? }).to_string()))
}

/// 요약 유형 하나. prompt는 요약 방법 본문
#[derive(Deserialize, Serialize, Debug, PartialEq, Default)]
#[serde(default)]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub builtin: bool,
}

/// `templates list --json`의 마지막 줄 {"templates": [...]} 또는 `templates save`의 객체 하나. 읽지 못하는 항목은 건너뛴다
fn parse_templates(out: &str) -> Result<Vec<TemplateInfo>, String> {
    let v = stdout_json(out).map_err(|_| t("요약 유형을 읽지 못했습니다"))?;
    let items = v.get("templates").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![v.clone()]);
    Ok(items.into_iter().filter_map(|t| serde_json::from_value::<TemplateInfo>(t).ok()).filter(|t| !t.id.is_empty()).collect())
}

/// 노트에 요약 파일이 하나라도 있는지 (summary.json 또는 summaries/*.json). 노트 목록의 `요약 없음` 배지에 쓴다
pub fn any_summary(dir: &Path) -> bool {
    dir.join("summary.json").is_file()
        || std::fs::read_dir(dir.join("summaries"))
            .map(|rd| rd.flatten().any(|e| e.path().extension().is_some_and(|x| x == "json") && e.path().file_stem().and_then(|s| s.to_str()).is_some_and(is_summary_key)))
            .unwrap_or(false)
}

fn read_doc(path: &Path, key: &str) -> Option<Value> {
    let Value::Object(mut obj) = serde_json::from_str::<Value>(&std::fs::read_to_string(path).ok()?).ok()? else { return None };
    obj.insert("key".into(), json!(key));
    Some(Value::Object(obj))
}

/// 노트의 요약들(기본 → summaries/ 만든 시각 순, 같으면 key 순). 만든 시각이 없으면 맨 앞. 내 유형·직접 요약의 key는 무작위라 key 순은 만든 순서가 아니다. 원본 JSON에 `key`를 덧붙여 돌려준다 (옛 스키마도 그대로: 화면이 가른다). 깨진 파일은 건너뛴다
pub fn read_docs(dir: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = read_doc(&dir.join("summary.json"), DEFAULT_KEY).into_iter().collect();
    let Ok(rd) = std::fs::read_dir(dir.join("summaries")) else { return out };
    let mut paths: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    paths.sort();
    let mut rest: Vec<Value> = paths
        .iter()
        .filter_map(|p| {
            let key = p.file_stem()?.to_str()?;
            (is_summary_key(key) && key != DEFAULT_KEY).then(|| read_doc(p, key)).flatten()
        })
        .collect();
    let made = |v: &Value| v["generated_at"].as_str().unwrap_or("").to_string();
    rest.sort_by_cached_key(|v| (made(v), v["key"].as_str().unwrap_or("").to_string())); // 안정 정렬이라 key 순(위)이 같은 시각 안에서 유지된다
    out.extend(rest);
    out
}

#[tauri::command]
pub async fn templates_list(state: State<'_, AppState>) -> Result<Vec<TemplateInfo>, String> {
    let s = state.settings();
    blocking(move || parse_templates(&run_tractus(&s, &["templates".into(), "list".into(), "--json".into()], None, &t("요약 유형을 읽지 못했습니다"))?)).await
}

/// 내 요약 유형 만들기(id 없음)·고치기. 저장한 유형을 돌려준다
#[tauri::command]
pub async fn templates_save(state: State<'_, AppState>, id: Option<String>, name: String, description: String, prompt: String) -> Result<TemplateInfo, String> {
    let s = state.settings();
    let (args, input) = save_template_args(id.as_deref(), &name, &description, &prompt)?;
    blocking(move || {
        let out = run_tractus(&s, &args, Some(&input), &t("요약 유형을 저장하지 못했습니다"))?;
        parse_templates(&out)?.into_iter().next().ok_or_else(|| t("요약 유형을 읽지 못했습니다"))
    })
    .await
}

#[tauri::command]
pub async fn templates_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if !is_user_template_id(&id) {
        return Err(t("기본 요약 유형은 고치거나 삭제할 수 없습니다."));
    }
    let s = state.settings();
    blocking(move || run_tractus(&s, &["templates".into(), "delete".into(), id], None, &t("요약 유형을 삭제하지 못했습니다")).map(|_| ())).await
}

/// 노트의 요약 전부 (원본 JSON + key)
#[tauri::command]
pub async fn summaries_list(state: State<'_, AppState>, id: String) -> Result<Vec<Value>, String> {
    let home = state.settings().home();
    blocking(move || Ok(read_docs(&meetings::find_dir(&home, &id)?))).await
}

#[tauri::command]
pub async fn summaries_delete(state: State<'_, AppState>, id: String, key: String) -> Result<(), String> {
    if !is_meeting_id(&id) || !is_summary_key(&key) {
        return Err(t("요약을 찾을 수 없습니다."));
    }
    let s = state.settings();
    let args: Vec<String> = ["summaries", &id, "delete", &key].map(String::from).to_vec();
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        run_tractus(&s, &args, None, &t("요약을 삭제하지 못했습니다")).map(|_| ())
    })
    .await
}

/// 회의록: 칸·위키용 Markdown·짧은 판 (`tractus minutes <노트> show`). 없으면 {"minutes": null}
#[tauri::command]
pub async fn minutes_show(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    if !is_meeting_id(&id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    let s = state.settings();
    let args: Vec<String> = ["minutes", &id, "show"].map(String::from).to_vec();
    blocking(move || stdout_json(&run_tractus(&s, &args, None, &t("회의록을 읽지 못했습니다"))?)).await // words-ok: 회의록은 문서 이름
}

/// 회의록 칸 고치기 (`tractus minutes <노트> save`, stdin {"minutes": …}). 모양·근거 ID 검사는 코어가 한다. 돌려주는 값은 minutes_show와 같다
#[tauri::command]
pub async fn minutes_save(state: State<'_, AppState>, id: String, minutes: Value) -> Result<Value, String> {
    if !is_meeting_id(&id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    let s = state.settings();
    let args: Vec<String> = ["minutes", &id, "save"].map(String::from).to_vec();
    let input = json!({ "minutes": minutes }).to_string();
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        stdout_json(&run_tractus(&s, &args, Some(&input), &t("회의록을 저장하지 못했습니다"))?) // words-ok: 회의록은 문서 이름
    })
    .await
}

/// 요약 하나 만들기. 이벤트는 "job"으로 보내고 {job, kind: "summarize"}를 덧붙인다 (job_start와 같다: 화면의 작업 상태가 그대로 쓴다).
/// provider: 고른 AI 서비스 (없으면 기본 서비스). template이 없고 custom도 없으면 기본(회의록). custom이 있으면 stdin으로 요약 방법을 넘긴다. 작업하는 동안 그 노트는 삭제할 수 없다
#[tauri::command]
pub fn summary_start(app: AppHandle, state: State<'_, AppState>, id: String, job: String, template: Option<String>, custom: Option<CustomSummary>, provider: Option<String>) -> Result<(), String> {
    let args = summarize_args(&id, template.as_deref(), custom.is_some())?;
    let input = custom.as_ref().map(custom_input).transpose()?;
    let cmd = state.llm_cmd(&args, provider.as_deref())?;
    let tag = json!({"job": job, "kind": "summarize"}).as_object().unwrap().clone();
    let (busy, key) = (state.busy.clone(), hold(&state.busy, &id));
    cancel_index(&state.index);
    let (slot_busy, slot_key) = (busy.clone(), key.clone());
    let started = crate::procs::spawn_streaming(cmd, tag, move |ev| {
        if ev["event"] == "exit" {
            release(&slot_busy, &slot_key);
        }
        let _ = app.emit("job", ev);
    });
    match started {
        Ok((mut stdin, _)) => {
            // 코어는 stdin을 끝까지 읽고 시작한다. 파이썬이 뜨는 동안 UI 스레드가 막히지 않게 따로 쓰고 닫는다
            std::thread::spawn(move || {
                if let Some(input) = input {
                    if let Err(e) = stdin.write_all(input.as_bytes()) {
                        eprintln!("요약 방법을 넘기지 못했습니다: {e}"); // 코어가 입력 오류로 끝나고 exit가 간다
                    }
                }
            });
            Ok(())
        }
        Err(e) => {
            release(&busy, &key);
            Err(e)
        }
    }
}

/// `tractus polish <노트> run --progress-json`: AI 다듬기 제안 만들기 (docs/design/transcript-polish.md). 이벤트는 "job"으로 {job, kind: "polish"}를 덧붙인다.
/// 창이 끝날 때마다 progress에 그 구간의 suggestions가 온다. provider: 고른 AI 서비스. 작업하는 동안 그 노트는 삭제할 수 없다
#[tauri::command]
pub fn polish_start(app: AppHandle, state: State<'_, AppState>, id: String, job: String, provider: Option<String>) -> Result<(), String> {
    if !is_meeting_id(&id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    let cmd = state.llm_cmd(&["polish".into(), id.clone(), "run".into(), "--progress-json".into()], provider.as_deref())?;
    let tag = json!({"job": job, "kind": "polish"}).as_object().unwrap().clone();
    let (busy, key) = (state.busy.clone(), hold(&state.busy, &id));
    cancel_index(&state.index);
    let (slot_busy, slot_key) = (busy.clone(), key.clone());
    let started = crate::procs::spawn_streaming(cmd, tag, move |ev| {
        if ev["event"] == "exit" {
            release(&slot_busy, &slot_key);
        }
        let _ = app.emit("job", ev);
    });
    started.map(|_| ()).map_err(|e| {
        release(&busy, &key);
        e
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(prompt: &str, save_as: Option<&str>, key: Option<&str>) -> CustomSummary {
        CustomSummary { prompt: prompt.into(), save_as: save_as.map(String::from), key: key.map(String::from) }
    }

    #[test]
    fn id_and_key_shapes() {
        for ok in ["meeting", "brief", "u-1a2b3c4d", "c-00ff00ff"] {
            assert!(is_summary_key(ok), "{ok}");
        }
        for bad in ["", "ab", "Brief", "../x", "u-1A2B3C4D", "u-1a2b3c4", "c-1a2b3c4dd", "a/b", "brief ", "toolongtemplates", "-x"] {
            assert!(!is_summary_key(bad), "{bad}");
        }
        assert!(is_template_id("brief") && is_template_id("u-1a2b3c4d") && !is_template_id("c-1a2b3c4d"));
        assert!(is_user_template_id("u-1a2b3c4d") && !is_user_template_id("brief"));
    }

    #[test]
    fn summarize_args_by_template_or_custom() {
        assert_eq!(summarize_args("01ABC", None, false).unwrap(), ["summarize", "01ABC", "--progress-json"]);
        assert_eq!(summarize_args("01ABC", Some("brief"), false).unwrap(), ["summarize", "01ABC", "--progress-json", "--template", "brief"]);
        assert_eq!(summarize_args("01ABC", None, true).unwrap(), ["summarize", "01ABC", "--progress-json", "--custom"]);
        for (id, t, c) in [("../x", None, false), ("", None, false), ("01A", Some("--force"), false), ("01A", Some("../x"), false), ("01A", Some("c-1a2b3c4d"), false), ("01A", Some("brief"), true)] {
            assert!(summarize_args(id, t, c).is_err(), "{id} {t:?} {c}");
        }
    }

    #[test]
    fn custom_input_validates_and_prefers_save_as_over_key() {
        let v: Value = serde_json::from_str(&custom_input(&custom("  한 줄로  ", None, None)).unwrap()).unwrap();
        assert_eq!(v, json!({"prompt": "한 줄로"}));
        let v: Value = serde_json::from_str(&custom_input(&custom("p", Some(" 주간  보고 "), Some("c-1a2b3c4d"))).unwrap()).unwrap();
        assert_eq!(v, json!({"prompt": "p", "save_as": "주간 보고"}));
        let v: Value = serde_json::from_str(&custom_input(&custom("p", Some("  "), Some("c-1a2b3c4d"))).unwrap()).unwrap();
        assert_eq!(v, json!({"prompt": "p", "key": "c-1a2b3c4d"}));
        assert!(custom_input(&custom(" \n", None, None)).is_err());
        assert!(custom_input(&custom(&"가".repeat(4001), None, None)).is_err());
        assert!(custom_input(&custom(&"가".repeat(4000), None, None)).is_ok());
        assert!(custom_input(&custom("p", Some(&"가".repeat(41)), None)).is_err());
        assert!(custom_input(&custom("p", None, Some("brief"))).is_err());
        assert!(custom_input(&custom("p", None, Some("c-../../x"))).is_err());
    }

    #[test]
    fn save_template_args_put_values_after_equals_and_validate() {
        let (args, input) = save_template_args(None, " -박 보고 ", "금주  한 일", " 방법 ").unwrap();
        assert_eq!(args, ["templates", "save", "--name=-박 보고", "--description=금주 한 일"]);
        assert_eq!(serde_json::from_str::<Value>(&input).unwrap(), json!({"prompt": "방법"}));
        let (args, _) = save_template_args(Some("u-1a2b3c4d"), "n", "", "p").unwrap();
        assert_eq!(args[2..], ["--name=n", "--description=", "--id", "u-1a2b3c4d"]);
        assert!(save_template_args(Some("brief"), "n", "", "p").is_err());
        assert!(save_template_args(None, "", "", "p").is_err());
        assert!(save_template_args(None, "n", &"가".repeat(101), "p").is_err());
        assert!(save_template_args(None, "n", "", "").is_err());
    }

    #[test]
    fn parse_templates_is_lenient() {
        let out = "잡음\n{\"templates\": [{\"id\": \"brief\", \"name\": \"핵심 요약\", \"description\": \"d\", \"prompt\": \"p\", \"builtin\": true}, {\"name\": \"id 없음\"}, 3, {\"id\": \"u-1a2b3c4d\", \"name\": \"내 것\", \"extra\": 1}]}\n";
        let t = parse_templates(out).unwrap();
        assert_eq!(t.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["brief", "u-1a2b3c4d"]);
        assert!(t[0].builtin && !t[1].builtin && t[1].prompt.is_empty());
        let one = parse_templates("{\"id\": \"u-1a2b3c4d\", \"name\": \"n\", \"description\": \"\", \"prompt\": \"p\", \"builtin\": false}").unwrap();
        assert_eq!(one.len(), 1);
        assert!(parse_templates("not json").is_err());
    }

    fn temp_note(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tractus-summaries-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("summaries")).unwrap();
        d
    }

    #[test]
    fn read_docs_lists_default_then_summaries_and_skips_bad_files() {
        let d = temp_note("docs");
        assert!(read_docs(&d).is_empty() && !any_summary(&d));
        std::fs::write(d.join("summaries/brief.json"), r#"{"schema_version": 2, "title": "핵심", "overview": "o", "sections": []}"#).unwrap();
        assert!(any_summary(&d));
        std::fs::write(d.join("summaries/broken.json"), "{").unwrap();
        std::fs::write(d.join("summaries/list.json"), "[1]").unwrap();
        std::fs::write(d.join("summaries/Bad Key.json"), "{}").unwrap();
        std::fs::write(d.join("summaries/meeting.json"), "{}").unwrap(); // 기본은 summary.json만
        std::fs::write(d.join("summaries/c-1a2b3c4d.json"), r#"{"title": "직접"}"#).unwrap();
        std::fs::write(d.join("summaries/brief.md"), "# x").unwrap();
        std::fs::write(d.join("summary.json"), r#"{"summary": "옛", "decisions": []}"#).unwrap();
        let docs = read_docs(&d);
        let keys: Vec<_> = docs.iter().map(|v| v["key"].as_str().unwrap()).collect();
        assert_eq!(keys, ["meeting", "brief", "c-1a2b3c4d"]);
        assert_eq!(docs[1]["title"], "핵심");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn read_docs_orders_custom_summaries_by_creation_time_not_by_random_key() {
        let d = temp_note("order");
        for (key, at) in [("c-ffffffff", "2026-10-13T09:00:00+09:00"), ("u-00000001", "2026-10-13T10:00:00+09:00"), ("c-0a0a0a0a", "2026-10-13T11:00:00+09:00"), ("c-5b5b5b5b", "2026-10-13T08:00:00+09:00")] {
            std::fs::write(d.join(format!("summaries/{key}.json")), format!(r#"{{"title": "t", "generated_at": "{at}"}}"#)).unwrap();
        }
        let keys: Vec<String> = read_docs(&d).iter().map(|v| v["key"].as_str().unwrap().to_string()).collect();
        assert_eq!(keys, ["c-5b5b5b5b", "c-ffffffff", "u-00000001", "c-0a0a0a0a"]);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn any_summary_ignores_unrelated_files() {
        let d = temp_note("any");
        std::fs::write(d.join("summaries/notes.txt"), "x").unwrap();
        std::fs::write(d.join("summaries/Bad.json"), "{}").unwrap();
        assert!(!any_summary(&d));
        std::fs::write(d.join("summary.json"), "{}").unwrap();
        assert!(any_summary(&d));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
