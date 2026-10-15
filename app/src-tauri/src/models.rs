//! 모델·점검 (docs/desktop.md §2.15). 목록·지우기·점검은 코어 `tractus models list|remove`, `tractus doctor`를 인수 배열로 실행하고,
//! 받기는 `tractus models download --progress-json`을 하위 프로세스로 띄워 JSON 줄을 `job` 이벤트(kind "models")로 그대로 보낸다.
//! 앱은 코어가 주는 키를 느슨하게 읽는다: 모르는 키·이상한 항목은 건너뛰고, 점검을 못 읽으면 doctor는 `doctor: null`로 답해 화면이 모든 기능을 쓸 수 있다고 본다.

use super::{blocking, expand, procs, run_tractus, AppState, Settings};
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const ID_MAX: usize = 40;
const IDS_MAX: usize = 16;
const PRESETS: &[&str] = &["required", "standard", "lite", "all"];
/// 멈추기(SIGTERM) 뒤에도 안 끝나면 강제로 끝내기까지 기다리는 시간
const KILL_AFTER: Duration = Duration::from_secs(10);
const BUSY: &str = "다른 모델을 받는 중입니다. 끝난 뒤에 다시 시도하세요.";

/// 모델 ID: 소문자·숫자·`-`만, 처음은 `-`가 아니다 (코어 레지스트리 ID, 옵션처럼 읽히지 않게)
pub fn valid_id(id: &str) -> bool {
    (1..=ID_MAX).contains(&id.len()) && !id.starts_with('-') && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn to_args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

fn list_args() -> Vec<String> {
    to_args(&["models", "list", "--json"])
}

fn doctor_args() -> Vec<String> {
    to_args(&["doctor", "--json"])
}

fn remove_args(id: &str) -> Result<Vec<String>, String> {
    if !valid_id(id) {
        return Err(format!("잘못된 모델 ID입니다: {id}"));
    }
    Ok(to_args(&["models", "remove", id, "--yes"]))
}

/// `tractus models move <dest> --yes`. 목적지는 절대 경로(`~/`는 펼친다)만: 옵션처럼 읽히지 않게
fn move_args(dest: &str) -> Result<Vec<String>, String> {
    let dest = expand(dest);
    if !dest.is_absolute() || dest.to_string_lossy().contains('\0') {
        return Err(format!("폴더는 전체 경로로 지정하세요: {}", dest.display()));
    }
    Ok(vec!["models".into(), "move".into(), "--yes".into(), dest.to_string_lossy().into_owned()])
}

/// `tractus models download <id>... [--preset P] --progress-json`. ID는 중복을 빼고, 하나도 없으면 구성(preset)이 있어야 한다
fn download_args(ids: &[String], preset: Option<&str>) -> Result<Vec<String>, String> {
    let mut uniq: Vec<&str> = vec![];
    for id in ids {
        if !valid_id(id) {
            return Err(format!("잘못된 모델 ID입니다: {id}"));
        }
        if !uniq.contains(&id.as_str()) {
            uniq.push(id);
        }
    }
    if uniq.len() > IDS_MAX {
        return Err("한 번에 받을 수 있는 모델 수를 넘었습니다".into());
    }
    if let Some(p) = preset {
        if !PRESETS.contains(&p) {
            return Err(format!("알 수 없는 구성입니다: {p}"));
        }
    }
    if uniq.is_empty() && preset.is_none() {
        return Err("받을 모델이 없습니다".into());
    }
    let mut args = to_args(&["models", "download"]);
    args.extend(uniq.iter().map(|s| s.to_string()));
    if let Some(p) = preset {
        args.extend(["--preset".to_string(), p.to_string()]);
    }
    args.push("--progress-json".into());
    Ok(args)
}

// ── 읽기 (느슨하게) ──

/// stdout 전체가 JSON이면 그것을, 아니면 마지막 줄을 읽는다 (코어가 한 줄로 찍든 들여써서 찍든)
fn parse_object(out: &str) -> Option<Value> {
    let whole = serde_json::from_str::<Value>(out.trim()).ok().filter(Value::is_object);
    whole.or_else(|| out.lines().rev().find(|l| !l.trim().is_empty()).and_then(|l| serde_json::from_str::<Value>(l).ok()).filter(Value::is_object))
}

fn s_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

fn bool_of(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(Value::as_bool)
}

/// 정수·실수 모두 받는 바이트 수 (음수·NaN은 없는 값)
fn bytes_of(v: &Value, key: &str) -> Option<u64> {
    let n = v.get(key)?;
    n.as_u64().or_else(|| n.as_f64().filter(|f| f.is_finite() && *f >= 0.0).map(|f| f as u64))
}

fn strings_of(v: &Value, key: &str) -> Vec<String> {
    v.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ModelRow {
    pub id: String,
    pub name: String,
    pub purpose: String,
    /// required | recommended | optional
    pub level: String,
    pub size_bytes: u64,
    pub installed: bool,
    pub installed_bytes: u64,
    /// installed | missing | partial | corrupt
    pub state: String,
    pub needed_by: Vec<String>,
    pub group: String,
    /// "one_of": 필수 모델 여럿 중 하나만 있으면 된다 (변환 엔진). 옛 코어에는 없으니 None
    pub level_note: Option<String>,
    // 모델 소개 (코어 `models list --json`의 추가 키. 옛 코어에는 없으니 None)
    pub model_name: Option<String>,
    pub publisher: Option<String>,
    pub converted_by: Option<String>,
    pub source: Option<String>,
    pub revision: Option<String>,
    pub license: Option<String>,
    pub languages: Option<String>,
    pub params: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ModelsList {
    pub models_dir: String,
    pub disk_free_bytes: Option<u64>,
    /// 다른 곳(터미널의 `tractus models download` 등)이 받는 중이다
    pub download_active: bool,
    pub models: Vec<ModelRow>,
    /// 모델 폴더 안의 등록되지 않은 폴더 (옛 모델 등). 옛 코어에는 없으니 비어 있다 (화면은 정리 줄을 숨긴다)
    pub unregistered: Vec<Unregistered>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Unregistered {
    pub name: String,
    pub bytes: u64,
}

const STATES: &[&str] = &["installed", "missing", "partial", "corrupt"];
const LEVELS: &[&str] = &["required", "recommended", "optional"];

fn state_of(v: &Value, installed: bool) -> String {
    s_of(v, "state").filter(|s| STATES.contains(&s.as_str())).unwrap_or_else(|| (if installed { "installed" } else { "missing" }).into())
}

fn model_row(v: &Value) -> Option<ModelRow> {
    let id = s_of(v, "id").filter(|id| valid_id(id))?;
    let state = state_of(v, bool_of(v, "installed").unwrap_or(false));
    Some(ModelRow {
        name: s_of(v, "name").unwrap_or_else(|| id.clone()),
        purpose: s_of(v, "purpose").unwrap_or_default(),
        level: s_of(v, "level").filter(|l| LEVELS.contains(&l.as_str())).unwrap_or_else(|| "optional".into()),
        size_bytes: bytes_of(v, "size_bytes").unwrap_or(0),
        // 상태가 기준이다: `installed`가 없거나 상태와 어긋나도 화면은 하나만 본다
        installed: state == "installed",
        installed_bytes: bytes_of(v, "installed_bytes").unwrap_or(0),
        state,
        needed_by: strings_of(v, "needed_by"),
        group: s_of(v, "group").unwrap_or_default(),
        level_note: s_of(v, "level_note"),
        model_name: s_of(v, "model_name"),
        publisher: s_of(v, "publisher"),
        converted_by: s_of(v, "converted_by"),
        source: s_of(v, "source"),
        revision: s_of(v, "revision"),
        license: s_of(v, "license"),
        languages: s_of(v, "languages"),
        params: s_of(v, "params"),
        id,
    })
}

const LIST_FAILED: &str = "모델 목록을 읽지 못했습니다";

/// `tractus models list --json` (docs/desktop.md §2.15). 읽지 못하는 항목은 건너뛴다
fn parse_models_list(out: &str) -> Result<ModelsList, String> {
    let v = parse_object(out).ok_or(LIST_FAILED)?;
    let models = v.get("models").and_then(Value::as_array).ok_or(LIST_FAILED)?.iter().filter_map(model_row).collect();
    let unregistered = v.get("unregistered").and_then(Value::as_array).map(|a| a.iter().filter_map(|u| Some(Unregistered { name: s_of(u, "name")?, bytes: bytes_of(u, "bytes").unwrap_or(0) })).collect()).unwrap_or_default();
    Ok(ModelsList { models_dir: s_of(&v, "models_dir").unwrap_or_default(), disk_free_bytes: bytes_of(&v, "disk_free_bytes"), download_active: bool_of(&v, "download_active").unwrap_or(false), models, unregistered })
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Tool {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

fn tool_of(v: Option<&Value>) -> Tool {
    let Some(v) = v else { return Tool::default() };
    Tool { found: bool_of(v, "found").unwrap_or(false), path: s_of(v, "path"), version: s_of(v, "version") }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Tools {
    pub ffmpeg: Tool,
    pub recorder: Tool,
    pub diar_helper: Tool,
    /// Homebrew: 코어가 알릴 때만 (없으면 null)
    pub brew: Option<Tool>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct System {
    pub arch: Option<String>,
    pub macos_version: Option<String>,
    pub memory_gb: Option<f64>,
    pub meets_min: Option<bool>,
    pub disk_free_bytes: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ModelSummary {
    pub id: String,
    pub state: String,
    pub installed: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Capability {
    pub id: String,
    pub name: String,
    pub ready: bool,
    pub missing: Vec<String>,
    pub hint: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Doctor {
    pub system: System,
    pub tools: Tools,
    pub models: Vec<ModelSummary>,
    pub capabilities: Vec<Capability>,
    pub recommended_track: Option<String>,
}

fn version_of(v: &Value) -> Option<String> {
    match v.get("macos_version")? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 모델 요약: 객체 목록(`[{id, state}]`)이든 `{id: state}` 지도이든 읽는다
fn model_summaries(v: Option<&Value>) -> Vec<ModelSummary> {
    let summary = |id: &str, state: Option<String>, installed: Option<bool>| {
        let state = state.filter(|s| STATES.contains(&s.as_str())).unwrap_or_else(|| (if installed == Some(true) { "installed" } else { "missing" }).into());
        valid_id(id).then(|| ModelSummary { id: id.to_string(), installed: state == "installed", state })
    };
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|m| summary(&s_of(m, "id")?, s_of(m, "state"), bool_of(m, "installed"))).collect(),
        Some(Value::Object(o)) => o.iter().filter_map(|(id, st)| summary(id, st.as_str().map(String::from).or_else(|| s_of(st, "state")), st.get("installed").and_then(Value::as_bool))).collect(),
        _ => vec![],
    }
}

fn track_of(v: &Value) -> Option<String> {
    match v.get("recommended_track")? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        o @ Value::Object(_) => s_of(o, "id").or_else(|| s_of(o, "track")).or_else(|| s_of(o, "name")),
        _ => None,
    }
}

const DOCTOR_FAILED: &str = "점검 정보를 읽지 못했습니다";

/// `tractus doctor --json`. 빠진 키는 비어 있는 값으로 본다 (점검이 일부만 와도 쓸 수 있게)
fn parse_doctor(out: &str) -> Result<Doctor, String> {
    let v = parse_object(out).ok_or(DOCTOR_FAILED)?;
    let empty = json!({});
    let sys = v.get("system").unwrap_or(&empty);
    let tools = v.get("tools").unwrap_or(&empty);
    let capabilities = v
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    let id = s_of(c, "id")?;
                    Some(Capability { name: s_of(c, "name").unwrap_or_else(|| id.clone()), ready: bool_of(c, "ready").unwrap_or(false), missing: strings_of(c, "missing"), hint: s_of(c, "hint").unwrap_or_default(), id })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Doctor {
        system: System {
            arch: s_of(sys, "arch"),
            macos_version: version_of(sys),
            memory_gb: sys.get("memory_gb").and_then(Value::as_f64).filter(|f| f.is_finite() && *f >= 0.0),
            meets_min: bool_of(sys, "meets_min"),
            disk_free_bytes: bytes_of(sys, "disk_free_bytes"),
        },
        tools: Tools {
            ffmpeg: tool_of(tools.get("ffmpeg")),
            recorder: tool_of(tools.get("recorder")),
            diar_helper: tool_of(tools.get("diar_helper").or_else(|| tools.get("diar-helper"))),
            brew: tools.get("brew").map(|b| tool_of(Some(b))),
        },
        models: model_summaries(v.get("models")),
        capabilities,
        recommended_track: track_of(&v),
    })
}

/// `doctor` 명령의 결과. 코어를 못 불러도 앱이 쓰는 실행 파일 경로가 있는지는 늘 알려 준다 (시작 점검의 도구 행).
/// `*_source`는 경로가 어디서 왔는지(`custom` 직접 지정 | `env` | `bundle` | `repo` | `known` | `none` 못 찾음), `stale_saved`는 이번 실행에서 없어서 자동으로 되돌린 저장 경로
#[derive(Serialize, Debug)]
pub struct DoctorReport {
    pub doctor: Option<Doctor>,
    pub core_error: Option<String>,
    pub tractus_bin: String,
    pub tractus_bin_exists: bool,
    pub tractus_source: &'static str,
    pub rec_bin: String,
    pub rec_bin_exists: bool,
    pub rec_source: &'static str,
    pub stale_saved: Vec<String>,
    /// 데이터 폴더(펼친 경로)와, 동기화 폴더·Obsidian 볼트 안이면 그 이름 (paths::sync_risk)
    pub home: String,
    pub home_risk: Option<&'static str>,
}

fn doctor_report(s: &Settings) -> DoctorReport {
    let (core, rec) = (s.tractus_resolved(), s.rec_resolved());
    let (tractus_bin_exists, rec_bin_exists) = (core.source != "none", rec.source != "none");
    let (doctor, core_error) = if !tractus_bin_exists {
        (None, Some(procs::cannot_run(&core.path, "No such file or directory")))
    } else {
        match run_tractus(s, &doctor_args(), None, DOCTOR_FAILED).and_then(|out| parse_doctor(&out)) {
            Ok(d) => (Some(d), None),
            Err(e) => (None, Some(e)),
        }
    };
    let home = s.home();
    DoctorReport {
        doctor,
        core_error,
        tractus_bin: core.path,
        tractus_bin_exists,
        tractus_source: core.source,
        rec_bin: rec.path,
        rec_bin_exists,
        rec_source: rec.source,
        stale_saved: s.stale.clone(),
        home_risk: crate::paths::sync_risk(&home),
        home: home.to_string_lossy().into_owned(),
    }
}

// ── 받기 (한 번에 하나) ──

struct Held {
    job: String,
    pid: Option<u32>,
}

type Slot = Arc<Mutex<Option<Held>>>;

fn slot() -> &'static Slot {
    static SLOT: OnceLock<Slot> = OnceLock::new();
    SLOT.get_or_init(Slot::default)
}

/// 받기 프로세스를 띄운다. 이미 받는 중이면 거절한다. 끝나면(exit 이벤트) 칸을 비운 뒤 이벤트를 내보낸다:
/// 화면이 exit를 받고 바로 다시 시작해도 거절당하지 않게. 칸을 잠근 채 띄우므로 바로 끝나는 프로세스의 exit도 칸이 채워진 뒤에 처리된다
fn start(slot: &Slot, cmd: Command, job: &str, emit: impl Fn(Value) + Send + Sync + 'static) -> Result<(), String> {
    let mut held = slot.lock().unwrap();
    if held.is_some() {
        return Err(BUSY.into());
    }
    let tag = json!({"job": job, "kind": "models"}).as_object().unwrap().clone();
    let (done_slot, done_job) = (slot.clone(), job.to_string());
    let (_stdin, child) = procs::spawn_streaming(cmd, tag, move |ev| {
        if ev["event"] == "exit" {
            let mut h = done_slot.lock().unwrap();
            if h.as_ref().is_some_and(|x| x.job == done_job) {
                *h = None;
            }
        }
        emit(ev);
    })?;
    let pid = child.try_lock().ok().map(|c| c.id());
    *held = Some(Held { job: job.to_string(), pid });
    Ok(())
}

fn signal(pid: u32, sig: &str) {
    let _ = Command::new("/bin/kill").arg(format!("-{sig}")).arg(pid.to_string()).status();
}

/// 받기를 멈춘다: SIGTERM(코어가 깨끗이 멈추고 받은 부분은 남긴다), `kill_after` 뒤에도 남아 있으면 SIGKILL. 받는 중이 아니면 false
fn stop(slot: &Slot, kill_after: Duration) -> bool {
    let Some((job, pid)) = slot.lock().unwrap().as_ref().and_then(|h| h.pid.map(|p| (h.job.clone(), p))) else { return false };
    signal(pid, "TERM");
    let slot = slot.clone();
    std::thread::spawn(move || {
        std::thread::sleep(kill_after);
        if slot.lock().unwrap().as_ref().is_some_and(|h| h.job == job) {
            signal(pid, "KILL");
        }
    });
    true
}

/// 앱을 끌 때: 받기가 돌고 있으면 멈추게 한다 (받은 부분은 남고 다시 받으면 이어진다)
pub fn stop_download() {
    stop(slot(), KILL_AFTER);
}

fn downloading() -> bool {
    slot().lock().unwrap().is_some()
}

// ── 명령 ──

#[tauri::command]
pub async fn models_list(state: State<'_, AppState>) -> Result<ModelsList, String> {
    let s = state.settings();
    blocking(move || parse_models_list(&run_tractus(&s, &list_args(), None, LIST_FAILED)?)).await
}

/// 점검. 실패하지 않는다: 코어를 못 불러도 `doctor: null` + 이유로 답한다
#[tauri::command]
pub async fn doctor(state: State<'_, AppState>) -> Result<DoctorReport, String> {
    let s = state.settings();
    blocking(move || Ok(doctor_report(&s))).await
}

/// 받기 시작. 이벤트는 "job"으로 {job, kind: "models"}를 덧붙여 보낸다. ids 또는 preset이 있어야 하고, 이미 받는 중이면 거절한다
#[tauri::command]
pub fn models_download(app: AppHandle, state: State<'_, AppState>, job: String, ids: Vec<String>, preset: Option<String>) -> Result<(), String> {
    let s = state.settings();
    let args = download_args(&ids, preset.as_deref())?;
    start(slot(), s.tractus(&args), &job, move |ev| {
        let _ = app.emit("job", ev);
    })
}

/// 받기 멈추기. 받는 중이 아니면 아무 일도 없다
#[tauri::command]
pub fn models_cancel() {
    stop(slot(), KILL_AFTER);
}

#[tauri::command]
pub async fn models_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let s = state.settings();
    let args = remove_args(&id)?;
    if downloading() {
        return Err("모델을 받는 중에는 삭제할 수 없습니다".into());
    }
    blocking(move || run_tractus(&s, &args, None, "모델을 삭제하지 못했습니다").map(|_| ())).await
}

/// 모델 폴더 옮기기 (지금 모델 폴더 → dest, 등록된 모델만). 설정은 건드리지 않는다: 화면이 성공한 뒤에 `models_dir`을 저장한다.
/// → {"moved": [ID], "freed_bytes"}
#[tauri::command]
pub async fn models_move(state: State<'_, AppState>, dest: String) -> Result<Value, String> {
    let s = state.settings();
    let args = move_args(&dest)?;
    if downloading() {
        return Err("모델을 받는 중에는 옮길 수 없습니다".into());
    }
    blocking(move || parse_object(&run_tractus(&s, &args, None, "모델을 옮기지 못했습니다")?).ok_or_else(|| "모델을 옮긴 결과를 읽지 못했습니다".to_string())).await
}

/// 등록되지 않은 폴더 정리 (`tractus models prune --yes --json`). → {"removed": [{"name","bytes"}], "freed_bytes"}
#[tauri::command]
pub async fn models_prune(state: State<'_, AppState>) -> Result<Value, String> {
    let s = state.settings();
    if downloading() {
        return Err("모델을 받는 중에는 정리할 수 없습니다".into());
    }
    blocking(move || parse_object(&run_tractus(&s, &to_args(&["models", "prune", "--yes", "--json"]), None, "폴더를 정리하지 못했습니다")?).ok_or_else(|| "정리한 결과를 읽지 못했습니다".to_string())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::mpsc::channel;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ids_are_lowercase_kebab_only() {
        for ok in ["vad", "asr-std", "qwen3-embedding", "a1"] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", "-x", "--preset", "VAD", "a b", "a/b", "../x", "a;b", "한글", &"a".repeat(41)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn download_args_are_argv_only_and_validated() {
        assert_eq!(download_args(&ids(&["vad", "asr-std", "vad"]), None).unwrap(), ["models", "download", "vad", "asr-std", "--progress-json"]);
        assert_eq!(download_args(&[], Some("standard")).unwrap(), ["models", "download", "--preset", "standard", "--progress-json"]);
        assert_eq!(download_args(&ids(&["vad"]), Some("lite")).unwrap(), ["models", "download", "vad", "--preset", "lite", "--progress-json"]);
        // 옵션처럼 읽히거나 경로가 섞인 ID, 알 수 없는 구성, 빈 요청은 거절한다
        for bad in [ids(&["--force"]), ids(&["vad", "../x"]), ids(&["VAD"])] {
            assert!(download_args(&bad, None).is_err());
        }
        assert!(download_args(&[], Some("everything")).is_err());
        assert!(download_args(&[], None).is_err());
        assert!(download_args(&(0..17).map(|i| format!("m{i}")).collect::<Vec<_>>(), None).is_err());
    }

    #[test]
    fn move_args_take_an_absolute_destination_only() {
        assert_eq!(move_args("/Volumes/ext/models").unwrap(), ["models", "move", "--yes", "/Volumes/ext/models"]);
        assert!(move_args("~/m").unwrap()[3].ends_with("/m") && !move_args("~/m").unwrap()[3].starts_with('~'));
        for bad in ["", "models", "--yes", "../x"] {
            assert!(move_args(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn list_reads_unregistered_leniently() {
        let l = parse_models_list(r#"{"models":[],"unregistered":[{"name":"old-vad","bytes":123},{"bytes":5},{"name":"x"},"junk"]}"#).unwrap();
        assert_eq!(l.unregistered, [Unregistered { name: "old-vad".into(), bytes: 123 }, Unregistered { name: "x".into(), bytes: 0 }]);
        assert!(parse_models_list(r#"{"models":[]}"#).unwrap().unregistered.is_empty()); // 옛 코어
    }

    #[test]
    fn remove_and_list_args() {
        assert_eq!(remove_args("aligner").unwrap(), ["models", "remove", "aligner", "--yes"]);
        assert!(remove_args("-rf").is_err());
        assert!(remove_args("a b").is_err());
        assert_eq!(list_args(), ["models", "list", "--json"]);
        assert_eq!(doctor_args(), ["doctor", "--json"]);
    }

    #[test]
    fn models_list_parses_full_shape() {
        let out = r#"{"models_dir":"/m","disk_free_bytes":123456789,"download_active":true,"models":[
            {"id":"vad","name":"음성 구간 분석","purpose":"p","level":"required","size_bytes":1300000,"installed":true,"installed_bytes":1300000,"state":"installed","needed_by":["convert","live"],"group":"asr"},
            {"id":"asr-std","name":"x","level":"required","size_bytes":2300000000.0,"installed":false,"installed_bytes":400,"state":"partial","needed_by":["convert"],"level_note":"one_of"}]}"#;
        let l = parse_models_list(out).unwrap();
        assert_eq!((l.models_dir.as_str(), l.disk_free_bytes, l.download_active), ("/m", Some(123_456_789), true));
        assert_eq!(l.models.len(), 2);
        assert_eq!(l.models[1].level_note.as_deref(), Some("one_of")); // 변환 엔진은 `필수 (둘 중 하나)`: 새 키를 그대로 넘긴다
        assert_eq!(l.models[0], ModelRow { id: "vad".into(), name: "음성 구간 분석".into(), purpose: "p".into(), level: "required".into(), size_bytes: 1_300_000, installed: true, installed_bytes: 1_300_000, state: "installed".into(), needed_by: vec!["convert".into(), "live".into()], group: "asr".into(), level_note: None, model_name: None, publisher: None, converted_by: None, source: None, revision: None, license: None, languages: None, params: None });
        assert_eq!((l.models[1].size_bytes, l.models[1].state.as_str(), l.models[1].installed), (2_300_000_000, "partial", false));
    }

    #[test]
    fn models_list_is_lenient() {
        // 들여쓴 JSON, 알 수 없는 상태·구분, 빠진 키, 잘못된 ID, 이상한 항목, 앞에 붙은 일반 글
        let out = "downloading metadata…\n{\n \"models\": [\n {\"id\":\"vad\",\"state\":\"weird\",\"installed\":true,\"level\":\"???\"},\n {\"id\":\"BAD ID\"}, 5, {\"name\":\"no id\"}, {\"id\":\"b\",\"installed\":false,\"size_bytes\":-5} ]\n}";
        // 앞에 일반 글이 있고 JSON이 여러 줄이면 읽을 수 없다 (코어는 --json이면 JSON만 낸다)
        assert!(parse_models_list(out).is_err());
        let pretty = "{\n \"models\": [\n {\"id\":\"vad\",\"state\":\"weird\",\"installed\":true,\"level\":\"???\"},\n {\"id\":\"BAD ID\"}, 5, {\"name\":\"no id\"}, {\"id\":\"b\",\"installed\":false,\"size_bytes\":-5} ]\n}";
        let l = parse_models_list(pretty).unwrap();
        assert_eq!(l.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["vad", "b"]);
        assert_eq!((l.models[0].state.as_str(), l.models[0].level.as_str(), l.models[0].installed), ("installed", "optional", true)); // 모르는 상태는 installed 플래그로
        assert_eq!((l.models[1].state.as_str(), l.models[1].size_bytes, l.models[1].name.as_str()), ("missing", 0, "b"));
        assert_eq!((l.models_dir.as_str(), l.disk_free_bytes, l.download_active), ("", None, false));
        // 한 줄 앞에 일반 글이 붙은 경우: 마지막 줄을 읽는다
        let last = "note\n{\"models\":[{\"id\":\"vad\",\"installed\":true}]}\n";
        assert_eq!(parse_models_list(last).unwrap().models.len(), 1);
    }

    #[test]
    fn models_list_reads_model_details_and_ignores_bad_ones() {
        // 새 키: 문자열만 받는다. null·빈 문자열·숫자는 없는 것으로 본다 (옛 코어는 키가 아예 없다)
        let out = r#"{"models":[
            {"id":"asr-std","model_name":"Qwen3-ASR 1.7B (8bit 양자화)","publisher":"Alibaba Qwen 팀","converted_by":"mlx-community (MLX 변환본)","source":"mlx-community/Qwen3-ASR-1.7B-8bit","revision":"a8379a2e2f9e313c9292cdf1af4055ab56d50d55","license":"Apache-2.0","languages":"한국어·영어 등","params":"1.7B"},
            {"id":"embedding","model_name":"Qwen3-Embedding 0.6B","converted_by":null,"license":"","languages":5,"params":null},
            {"id":"old"}]}"#;
        let l = parse_models_list(out).unwrap();
        let m = &l.models[0];
        assert_eq!((m.model_name.as_deref(), m.publisher.as_deref(), m.converted_by.as_deref()), (Some("Qwen3-ASR 1.7B (8bit 양자화)"), Some("Alibaba Qwen 팀"), Some("mlx-community (MLX 변환본)")));
        assert_eq!((m.source.as_deref(), m.revision.as_deref(), m.license.as_deref(), m.languages.as_deref(), m.params.as_deref()), (Some("mlx-community/Qwen3-ASR-1.7B-8bit"), Some("a8379a2e2f9e313c9292cdf1af4055ab56d50d55"), Some("Apache-2.0"), Some("한국어·영어 등"), Some("1.7B")));
        let e = &l.models[1];
        assert_eq!((e.model_name.as_deref(), e.converted_by.as_deref(), e.license.as_deref(), e.languages.as_deref(), e.params.as_deref(), e.publisher.as_deref()), (Some("Qwen3-Embedding 0.6B"), None, None, None, None, None));
        let old = &l.models[2];
        assert!(old.model_name.is_none() && old.source.is_none() && old.revision.is_none());
    }

    #[test]
    fn models_list_rejects_garbage() {
        for bad in ["", "not json", "[]", "{}", r#"{"models": "x"}"#, "null"] {
            assert_eq!(parse_models_list(bad).unwrap_err(), LIST_FAILED, "{bad}");
        }
    }

    #[test]
    fn state_wins_over_installed_flag() {
        // 일부만 받은 모델이 installed: true로 와도 설치됨으로 보지 않는다
        let l = parse_models_list(r#"{"models":[{"id":"a","state":"corrupt","installed":true}]}"#).unwrap();
        assert_eq!((l.models[0].state.as_str(), l.models[0].installed), ("corrupt", false));
    }

    #[test]
    fn doctor_parses_full_shape() {
        let out = r#"{"system":{"arch":"arm64","macos_version":"15.1","memory_gb":36,"meets_min":true,"disk_free_bytes":5e10},
          "tools":{"ffmpeg":{"found":true,"path":"/opt/homebrew/bin/ffmpeg","version":"7.1"},"recorder":{"found":false},"diar_helper":{"found":false},"brew":{"found":true,"path":"/opt/homebrew/bin/brew"}},
          "models":[{"id":"vad","state":"installed"},{"id":"asr-std","state":"missing"}],
          "capabilities":[{"id":"convert","name":"텍스트 변환","ready":false,"missing":["asr-std","ffmpeg"],"hint":"h"},{"id":"align","ready":true}],
          "recommended_track":"asr-std"}"#;
        let d = parse_doctor(out).unwrap();
        assert_eq!((d.system.arch.as_deref(), d.system.macos_version.as_deref(), d.system.memory_gb, d.system.meets_min), (Some("arm64"), Some("15.1"), Some(36.0), Some(true)));
        assert_eq!(d.system.disk_free_bytes, Some(50_000_000_000));
        assert!(d.tools.ffmpeg.found && !d.tools.recorder.found && !d.tools.diar_helper.found);
        assert_eq!(d.tools.ffmpeg.version.as_deref(), Some("7.1"));
        assert_eq!(d.tools.brew.as_ref().map(|b| b.found), Some(true));
        assert_eq!(d.models, vec![ModelSummary { id: "vad".into(), state: "installed".into(), installed: true }, ModelSummary { id: "asr-std".into(), state: "missing".into(), installed: false }]);
        assert_eq!(d.capabilities[0], Capability { id: "convert".into(), name: "텍스트 변환".into(), ready: false, missing: vec!["asr-std".into(), "ffmpeg".into()], hint: "h".into() });
        assert_eq!((d.capabilities[1].name.as_str(), d.capabilities[1].ready), ("align", true));
        assert_eq!(d.recommended_track.as_deref(), Some("asr-std"));
    }

    #[test]
    fn doctor_is_lenient() {
        // 빈 객체도 받는다: 도구는 없는 것으로, 기능 목록은 비어 있다 (화면은 막지 않는다)
        let d = parse_doctor("{}").unwrap();
        assert!(!d.tools.ffmpeg.found && d.tools.brew.is_none() && d.capabilities.is_empty() && d.models.is_empty());
        assert_eq!((d.system.arch, d.system.memory_gb, d.recommended_track), (None, None, None));
        // macOS 버전이 숫자·모델 요약이 지도·추천 엔진이 객체여도 읽는다. 이상한 값은 버린다
        let d = parse_doctor(r#"{"system":{"macos_version":15,"memory_gb":-1},"models":{"vad":"installed","asr-lite":{"state":"partial"},"BAD ID":"installed"},"recommended_track":{"id":"asr-lite"},"capabilities":[{"name":"no id"},"x"]}"#).unwrap();
        assert_eq!((d.system.macos_version.as_deref(), d.system.memory_gb), (Some("15"), None));
        let mut m: Vec<_> = d.models.iter().map(|m| (m.id.as_str(), m.state.as_str())).collect();
        m.sort();
        assert_eq!(m, [("asr-lite", "partial"), ("vad", "installed")]);
        assert_eq!(d.recommended_track.as_deref(), Some("asr-lite"));
        assert!(d.capabilities.is_empty());
        for bad in ["", "nope", "[]"] {
            assert_eq!(parse_doctor(bad).unwrap_err(), DOCTOR_FAILED, "{bad}");
        }
    }

    /// 코어(2026-10-14)가 실제로 낸 출력의 모양 그대로 (한 줄 JSON, 모르는 키 `path`·`problems`·`effective_track` 포함)
    #[test]
    fn parses_real_core_outputs() {
        let list = r#"{"models_dir": "/m", "disk_free_bytes": 199154298880, "download_active": false, "models": [{"id": "vad", "name": "목소리 구간 감지", "purpose": "녹음에서 사람이 말하는 구간을 찾습니다.", "level": "required", "size_bytes": 1238323, "installed": false, "installed_bytes": 0, "state": "missing", "needed_by": ["convert", "live"], "group": "convert", "path": "/m/silero-vad-v6"}]}"#;
        let l = parse_models_list(list).unwrap();
        assert_eq!((l.models[0].id.as_str(), l.models[0].size_bytes, l.models[0].needed_by.len(), l.download_active), ("vad", 1_238_323, 2, false));
        let doctor = r#"{"system": {"arch": "arm64", "macos_version": "26.6", "memory_gb": 16.0, "meets_min": true, "problems": [], "standard_recommended": true, "disk_free_bytes": 199154462720, "models_dir": "/m"}, "tools": {"ffmpeg": {"found": true, "path": "/opt/homebrew/bin/ffmpeg", "version": "8.1.1"}, "recorder": {"found": true, "path": "/r/tractus-rec"}, "diar_helper": {"found": false, "path": "/r/tractus-diar"}}, "models": [{"id": "vad", "level": "required", "state": "missing"}], "capabilities": [{"id": "record", "name": "녹음", "ready": true, "missing": [], "hint": ""}, {"id": "convert", "name": "텍스트로 변환", "ready": false, "missing": ["vad", "asr-std"], "hint": "tractus models download vad"}], "recommended_track": "standard", "effective_track": null}"#;
        let d = parse_doctor(doctor).unwrap();
        assert_eq!((d.system.memory_gb, d.recommended_track.as_deref(), d.tools.diar_helper.found), (Some(16.0), Some("standard"), false));
        assert_eq!(d.models[0], ModelSummary { id: "vad".into(), state: "missing".into(), installed: false });
        assert_eq!((d.capabilities[1].ready, d.capabilities[1].missing.len()), (false, 2));
    }

    /// 실제 코어(.venv)를 앱 명령 그대로 띄운다. 모델 폴더·노트 폴더는 임시 폴더라 실제 데이터를 건드리지 않는다: `cargo test -- --ignored real_core`
    #[test]
    #[ignore = "실제 코어(.venv)가 필요하다"]
    fn real_core_models_list_and_doctor() {
        let d = tmp("realcore");
        let s = Settings { home: d.join("home").to_string_lossy().into_owned(), models_dir: d.join("models").to_string_lossy().into_owned(), ..Default::default() };
        eprintln!("TRACTUS_HOME={} TRACTUS_MODELS_DIR={}", s.home, s.models_dir);
        let l = parse_models_list(&run_tractus(&s, &list_args(), None, LIST_FAILED).unwrap()).unwrap();
        assert_eq!(l.models.len(), 8);
        assert!(l.models.iter().all(|m| m.state == "missing" && m.size_bytes > 0));
        let r = doctor_report(&s);
        let doctor = r.doctor.expect("점검을 읽어야 한다");
        let convert = doctor.capabilities.iter().find(|c| c.id == "convert").unwrap();
        assert!(!convert.ready && convert.missing.contains(&"vad".to_string()));
    }

    /// 실제 받기 하나: 가장 작은 모델(VAD 1.3 MB)만 임시 모델 폴더에 받아 앱의 `start`가 내는 이벤트와 목록 결과를 본다. 네트워크가 필요하다:
    /// `cargo test -- --ignored real_core_download`
    #[test]
    #[ignore = "네트워크와 실제 코어(.venv)가 필요하다"]
    fn real_core_download_vad_events_and_list() {
        let d = tmp("realdl");
        let s = Settings { home: d.join("home").to_string_lossy().into_owned(), models_dir: d.join("models").to_string_lossy().into_owned(), ..Default::default() };
        eprintln!("TRACTUS_HOME={} TRACTUS_MODELS_DIR={}", s.home, s.models_dir);
        let (tx, rx) = channel();
        start(&Slot::default(), s.tractus(&download_args(&ids(&["vad"]), None).unwrap()), "REAL", move |v| tx.send(v).unwrap()).unwrap();
        let mut events = vec![];
        loop {
            let ev = rx.recv_timeout(Duration::from_secs(120)).expect("받기가 끝나야 한다");
            let exit = ev["event"] == "exit";
            events.push(ev);
            if exit {
                break;
            }
        }
        let kinds: Vec<&str> = events.iter().filter_map(|e| e["event"].as_str()).collect();
        eprintln!("{kinds:?}");
        assert!(kinds.contains(&"stage") && kinds.contains(&"progress") && kinds.contains(&"model_done") && kinds.contains(&"done"), "{kinds:?}");
        assert_eq!(events.last().unwrap()["code"], 0);
        assert!(events.iter().all(|e| e["job"] == "REAL" && e["kind"] == "models"));
        let l = parse_models_list(&run_tractus(&s, &list_args(), None, LIST_FAILED).unwrap()).unwrap();
        let vad = l.models.iter().find(|m| m.id == "vad").unwrap();
        assert_eq!((vad.state.as_str(), vad.installed), ("installed", true));
        assert!(l.models.iter().filter(|m| m.id != "vad").all(|m| !m.installed));
        // 지우기도 앱 명령 그대로
        run_tractus(&s, &remove_args("vad").unwrap(), None, "x").unwrap();
        let l = parse_models_list(&run_tractus(&s, &list_args(), None, LIST_FAILED).unwrap()).unwrap();
        assert_eq!(l.models.iter().find(|m| m.id == "vad").unwrap().state, "missing");
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tractus-models-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn script(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn settings(dir: &Path, bin: &Path, rec: &Path) -> Settings {
        Settings { tractus_bin: bin.to_string_lossy().into_owned(), rec_bin: rec.to_string_lossy().into_owned(), home: dir.to_string_lossy().into_owned(), ..Default::default() }
    }

    #[test]
    fn doctor_report_without_core_still_reports_paths() {
        let d = tmp("nocore");
        crate::paths::NO_AUTO.set(true); // 이 Mac의 저장소·설치 위치에 있는 실제 코어가 끼지 않게
        let s = settings(&d, &d.join("missing-tractus"), &d.join("missing-rec"));
        let r = doctor_report(&s);
        crate::paths::NO_AUTO.set(false);
        assert!(r.doctor.is_none() && !r.tractus_bin_exists && !r.rec_bin_exists);
        assert_eq!((r.tractus_source, r.rec_source), ("none", "none"));
        assert!(r.core_error.unwrap().contains("Tractus 엔진을 실행할 수 없습니다"));
    }

    #[test]
    fn doctor_report_with_old_core_has_no_doctor_but_keeps_reason() {
        // `doctor` 명령이 없는 옛 코어: 종료 코드 2 + stderr 마지막 줄
        let d = tmp("oldcore");
        let rec = script(&d, "tractus-rec", "exit 0");
        let bin = script(&d, "tractus", "echo \"Error: No such command 'doctor'.\" >&2; exit 2");
        let r = doctor_report(&settings(&d, &bin, &rec));
        assert!(r.doctor.is_none() && r.tractus_bin_exists && r.rec_bin_exists);
        assert_eq!(r.core_error.as_deref(), Some("No such command 'doctor'."));
    }

    #[test]
    fn doctor_report_runs_the_core_with_argv() {
        let d = tmp("core");
        let rec = script(&d, "tractus-rec", "exit 0");
        // 받은 인수를 그대로 돌려주는 가짜 코어: 인수가 `doctor --json`일 때만 점검 결과를 낸다
        let bin = script(&d, "tractus", r#"if [ "$1 $2" = "doctor --json" ]; then echo '{"capabilities":[{"id":"align","ready":false,"missing":["aligner"]}]}'; else exit 3; fi"#);
        let r = doctor_report(&settings(&d, &bin, &rec));
        assert!(r.core_error.is_none());
        assert_eq!(r.doctor.unwrap().capabilities[0].missing, ["aligner"]);
    }

    #[test]
    fn start_runs_one_download_at_a_time_and_clears_on_exit() {
        let d = tmp("start");
        let bin = script(&d, "dl", r#"echo '{"event":"progress","model":"vad","done":1,"total":2}'; sleep 0.4; echo '{"event":"done"}'"#);
        let slot = Slot::default();
        let (tx, rx) = channel();
        start(&slot, Command::new(&bin), "J1", move |v| tx.send(v).unwrap()).unwrap();
        // 받는 중에 또 시작하면 거절한다
        let (tx2, _rx2) = channel::<Value>();
        assert_eq!(start(&slot, Command::new(&bin), "J2", move |v| tx2.send(v).unwrap()).unwrap_err(), BUSY);
        let got: Vec<Value> = (0..3).map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap()).collect();
        assert_eq!(got[0], json!({"event": "progress", "model": "vad", "done": 1, "total": 2, "job": "J1", "kind": "models"}));
        assert_eq!(got[1]["event"], "done");
        assert_eq!((got[2]["event"].as_str(), got[2]["code"].as_i64()), (Some("exit"), Some(0)));
        // exit 이벤트가 화면에 간 시점에는 이미 칸이 비어 있다: 바로 다시 시작해도 된다
        assert!(slot.lock().unwrap().is_none());
        let (tx3, rx3) = channel();
        start(&slot, Command::new(&bin), "J3", move |v| tx3.send(v).unwrap()).unwrap();
        assert_eq!(rx3.recv_timeout(Duration::from_secs(5)).unwrap()["job"], "J3");
    }

    #[test]
    fn start_failure_leaves_the_slot_free() {
        let slot = Slot::default();
        assert!(start(&slot, Command::new("/nonexistent/tractus"), "J", |_| {}).is_err());
        assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn instant_exit_does_not_leave_a_stale_slot() {
        let d = tmp("instant");
        let bin = script(&d, "dl", "exit 1");
        let slot = Slot::default();
        let (tx, rx) = channel();
        start(&slot, Command::new(&bin), "J", move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["code"], 1);
        assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn stop_sends_sigterm_and_lets_the_core_finish_cleanly() {
        let d = tmp("stop");
        // SIGTERM을 받으면 깨끗이 끝났다고 알리고 종료 (코어의 동작)
        let bin = script(&d, "dl", r#"trap 'echo "{\"event\":\"done\"}"; exit 0' TERM; echo '{"event":"stage","stage":"download"}'; while :; do sleep 0.1; done"#);
        let slot = Slot::default();
        let (tx, rx) = channel();
        start(&slot, Command::new(&bin), "J", move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["stage"], "download");
        assert!(stop(&slot, Duration::from_secs(30)));
        let rest: Vec<Value> = (0..2).map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap()).collect();
        assert_eq!((rest[0]["event"].as_str(), rest[1]["event"].as_str(), rest[1]["code"].as_i64()), (Some("done"), Some("exit"), Some(0)));
        assert!(slot.lock().unwrap().is_none());
        assert!(!stop(&slot, Duration::from_secs(30))); // 받는 중이 아니면 아무 일도 없다
    }

    #[test]
    fn stop_kills_a_process_that_ignores_sigterm() {
        let d = tmp("kill");
        let bin = script(&d, "dl", r#"trap '' TERM; echo '{"event":"stage"}'; while :; do sleep 0.1; done"#);
        let slot = Slot::default();
        let (tx, rx) = channel();
        start(&slot, Command::new(&bin), "J", move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["event"], "stage");
        assert!(stop(&slot, Duration::from_millis(300)));
        let exit = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(exit["event"], "exit");
        assert!(slot.lock().unwrap().is_none());
    }
}
