//! 노트 정리: 즐겨찾기·태그·폴더·정렬 설정 (docs/desktop.md §2.12).
//! 노트의 `favorite`·`tags`·`folder`는 meetings.rs가 목록에 실어 보내고, 폴더 목록은 여기서 `$TRACTUS_HOME/folders.json`을 직접 읽는다 (깨졌으면 빈 목록).
//! 쓰기는 모두 코어(`tractus note meta`, `tractus folders …`)가 한다. 앱은 인수와 stdin JSON만 만든다.

use crate::i18n::{t, tv};
use super::{blocking, is_meeting_id, run_tractus, stdout_json, AppState, BusyGuard};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use tauri::State;

/// 폴더 작업이 쓰는 표시 대상 (노트 ID가 아니므로 노트 삭제를 막지 않는다. 검색 정보 갱신은 비켜 간다)
const FOLDERS_TARGET: &str = "<folders>";
const MAX_TAGS: usize = 20;
const MAX_TAG: usize = 30;
const MAX_FOLDER_NAME: usize = 40;
const SORTS: &[&str] = &["created", "updated", "title", "duration"];
const ORDERS: &[&str] = &["asc", "desc"];

/// folders.json 폴더 하나
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub order: i64,
    pub created_at: String,
}

fn one_folder(v: &Value) -> Option<Folder> {
    let o = v.as_object()?;
    let id = o.get("id")?.as_str().filter(|s| !s.is_empty())?;
    let name = o.get("name")?.as_str().filter(|s| !s.trim().is_empty())?;
    Some(Folder {
        id: id.to_string(),
        name: name.to_string(),
        parent: o.get("parent").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from),
        order: o.get("order").and_then(Value::as_i64).unwrap_or(0),
        created_at: o.get("created_at").and_then(Value::as_str).unwrap_or_default().to_string(),
    })
}

/// 너그럽게 읽는다 (코어 organize.load_folders와 같다): 읽을 수 없는 항목·겹친 ID는 버리고, 없는 부모는 최상위로, 고리는 끊는다.
/// 부모별로 order·이름 순
fn parse_folders(raw: &str) -> Vec<Folder> {
    let Ok(v) = serde_json::from_str::<Value>(raw) else { return vec![] };
    let Some(items) = v.get("folders").and_then(Value::as_array) else { return vec![] };
    let mut seen = HashSet::new();
    let mut out: Vec<Folder> = items.iter().filter_map(one_folder).filter(|f| seen.insert(f.id.clone())).collect();
    let ids: HashSet<String> = out.iter().map(|f| f.id.clone()).collect();
    for f in out.iter_mut() {
        if f.parent.as_deref().is_some_and(|p| !ids.contains(p) || p == f.id) {
            f.parent = None;
        }
    }
    let at: std::collections::HashMap<String, usize> = out.iter().enumerate().map(|(i, f)| (f.id.clone(), i)).collect();
    for i in 0..out.len() {
        let mut seen = HashSet::from([out[i].id.clone()]);
        let mut cur = i;
        while let Some(p) = out[cur].parent.clone() {
            if !seen.insert(p.clone()) {
                out[cur].parent = None; // 고리는 되돌아온 자리에서 끊는다
                break;
            }
            cur = at[&p]; // 없는 부모는 위에서 이미 비웠다
        }
    }
    out.sort_by(|a, b| (a.parent.as_deref().unwrap_or(""), a.order, a.name.to_lowercase(), &a.id).cmp(&(b.parent.as_deref().unwrap_or(""), b.order, b.name.to_lowercase(), &b.id)));
    out
}

pub fn load_folders(home: &Path) -> Vec<Folder> {
    fs::read_to_string(home.join("folders.json")).map(|raw| parse_folders(&raw)).unwrap_or_default()
}

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>) -> Result<Vec<Folder>, String> {
    let home = state.settings().home();
    blocking(move || Ok(load_folders(&home))).await
}

// ── 노트 정리 정보 ───────────────────────────────────────────────────

/// 준 키만 바뀐다. folder: 없으면 그대로, null이면 폴더 없음, 문자열이면 그 폴더
#[derive(Deserialize, Debug, Default)]
pub struct MetaPatch {
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present")]
    pub folder: Option<Option<String>>,
}

/// 키가 있으면 (null이어도) Some
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}

/// 코어가 저장한 정리 정보
#[derive(Serialize, Debug, PartialEq)]
pub struct NoteMeta {
    pub favorite: bool,
    pub tags: Vec<String>,
    pub folder: Option<String>,
}

fn clean_tag(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ").trim_start_matches('#').trim().to_string()
}

/// `tractus note meta <노트>` 인수와 stdin JSON. 화면이 먼저 거르므로 여기는 마지막 방어선이다 (문장은 코어와 같다)
pub fn note_meta_args(id: &str, p: &MetaPatch) -> Result<(Vec<String>, String), String> {
    if !is_meeting_id(id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    let mut body = serde_json::Map::new();
    if let Some(f) = p.favorite {
        body.insert("favorite".into(), json!(f));
    }
    if let Some(tags) = &p.tags {
        let tags: Vec<String> = tags.iter().map(|t| clean_tag(t)).filter(|t| !t.is_empty()).collect();
        if tags.iter().any(|t| t.contains(',')) {
            return Err(t("태그에 쉼표는 쓸 수 없습니다."));
        }
        if tags.iter().any(|t| t.chars().count() > MAX_TAG) {
            return Err(tv("태그는 {MAX_TAG}자까지 쓸 수 있습니다.", &[("MAX_TAG", MAX_TAG.to_string())]));
        }
        if tags.len() > MAX_TAGS {
            return Err(tv("태그는 {MAX_TAGS}개까지 붙일 수 있습니다.", &[("MAX_TAGS", MAX_TAGS.to_string())]));
        }
        body.insert("tags".into(), json!(tags));
    }
    if let Some(folder) = &p.folder {
        if folder.as_deref().is_some_and(|f| !is_meeting_id(f)) {
            return Err(t("폴더를 찾지 못했습니다. 노트 목록을 다시 불러 주세요."));
        }
        body.insert("folder".into(), json!(folder));
    }
    if body.is_empty() {
        return Err(t("바꿀 내용이 없습니다"));
    }
    Ok((["note", "meta", id].map(String::from).to_vec(), Value::Object(body).to_string()))
}

fn parse_meta(v: &Value) -> NoteMeta {
    NoteMeta {
        favorite: v["favorite"].as_bool().unwrap_or(false),
        tags: v["tags"].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default(),
        folder: v["folder"].as_str().map(String::from),
    }
}

/// 즐겨찾기·태그·폴더를 바꾼다 (수정 시각은 올리지 않는다). 노트를 처리 중으로 표시해 삭제가 기다리게 한다. 코어가 저장한 값을 돌려준다
#[tauri::command]
pub async fn note_meta(state: State<'_, AppState>, id: String, patch: MetaPatch) -> Result<NoteMeta, String> {
    let s = state.settings();
    let (args, input) = note_meta_args(&id, &patch)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let v = stdout_json(&run_tractus(&s, &args, Some(&input), &t("노트 정리를 저장하지 못했습니다"))?)?;
        Ok(parse_meta(&v))
    })
    .await
}

// ── 폴더 ─────────────────────────────────────────────────────────────

/// 이름: 공백·줄바꿈은 한 칸으로 줄인다 (코어 one_line). 1~40자, `/` 불가
fn folder_name(raw: &str) -> Result<String, String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(t("폴더 이름을 입력하세요."));
    }
    if name.contains('/') {
        return Err(t("폴더 이름에 /는 쓸 수 없습니다."));
    }
    if name.eq_ignore_ascii_case("none") {
        return Err(t("‘none’은 폴더 이름으로 쓸 수 없습니다.")); // 인수 `none`은 폴더 없음 (코어)
    }
    if name.chars().count() > MAX_FOLDER_NAME {
        return Err(tv("폴더 이름은 {MAX_FOLDER_NAME}자까지 쓸 수 있습니다.", &[("MAX_FOLDER_NAME", MAX_FOLDER_NAME.to_string())]));
    }
    Ok(name)
}

fn folder_id(id: &str) -> Result<&str, String> {
    if is_meeting_id(id) {
        Ok(id)
    } else {
        Err(t("폴더를 찾지 못했습니다. 노트 목록을 다시 불러 주세요."))
    }
}

/// 이름은 `--name=` 꼴로 붙인다 ("-"로 시작하는 이름을 옵션으로 읽지 않게)
pub fn folders_create_args(name: &str, parent: Option<&str>) -> Result<Vec<String>, String> {
    let mut a = vec!["folders".to_string(), "create".into(), format!("--name={}", folder_name(name)?)];
    if let Some(p) = parent {
        a.push(format!("--parent={}", folder_id(p)?));
    }
    Ok(a)
}

pub fn folders_rename_args(id: &str, name: &str) -> Result<Vec<String>, String> {
    Ok(vec!["folders".into(), "rename".into(), folder_id(id)?.into(), format!("--name={}", folder_name(name)?)])
}

/// parent가 None이면 최상위로 (`--parent=none`)
pub fn folders_move_args(id: &str, parent: Option<&str>) -> Result<Vec<String>, String> {
    let parent = match parent {
        Some(p) => folder_id(p)?,
        None => "none",
    };
    Ok(vec!["folders".into(), "move".into(), folder_id(id)?.into(), format!("--parent={parent}")])
}

pub fn folders_delete_args(id: &str) -> Result<Vec<String>, String> {
    Ok(vec!["folders".into(), "delete".into(), folder_id(id)?.into()])
}

/// 폴더 명령 하나를 돌리고 바뀐 폴더 목록을 돌려준다
async fn folder_op(state: &State<'_, AppState>, args: Vec<String>, what: String) -> Result<Vec<Folder>, String> {
    let s = state.settings();
    let guard = BusyGuard::new(&state.busy, FOLDERS_TARGET);
    blocking(move || {
        let _guard = guard;
        stdout_json(&run_tractus(&s, &args, None, &what)?)?;
        Ok(load_folders(&s.home()))
    })
    .await
}

#[tauri::command]
pub async fn folders_create(state: State<'_, AppState>, name: String, parent: Option<String>) -> Result<Vec<Folder>, String> {
    folder_op(&state, folders_create_args(&name, parent.as_deref())?, t("폴더를 만들지 못했습니다")).await
}

#[tauri::command]
pub async fn folders_rename(state: State<'_, AppState>, id: String, name: String) -> Result<Vec<Folder>, String> {
    folder_op(&state, folders_rename_args(&id, &name)?, t("폴더 이름을 바꾸지 못했습니다")).await
}

#[tauri::command]
pub async fn folders_move(state: State<'_, AppState>, id: String, parent: Option<String>) -> Result<Vec<Folder>, String> {
    folder_op(&state, folders_move_args(&id, parent.as_deref())?, t("폴더를 옮기지 못했습니다")).await
}

/// 폴더를 지운다. 노트는 지우지 않고 상위 폴더로, 하위 폴더는 한 단계 위로 올린다 (코어)
#[tauri::command]
pub async fn folders_delete(state: State<'_, AppState>, id: String) -> Result<Vec<Folder>, String> {
    folder_op(&state, folders_delete_args(&id)?, t("폴더를 삭제하지 못했습니다")).await
}

// ── 목록 정렬 설정 ───────────────────────────────────────────────────

/// 설정 파일의 list_sort·list_order만 바꾼다 (rec_mode와 같은 방식: 다른 키·기본값을 파일에 굳히지 않는다)
pub fn merge_list_prefs(raw: Option<&str>, sort: &str, order: &str) -> Result<String, String> {
    if !SORTS.contains(&sort) || !ORDERS.contains(&order) {
        return Err(tv("알 수 없는 목록 순서: {sort} {order}", &[("sort", sort.to_string()), ("order", order.to_string())]));
    }
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v["list_sort"] = json!(sort);
    v["list_order"] = json!(order);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_list_prefs(state: State<'_, AppState>, sort: String, order: String) -> Result<(), String> {
    crate::patch_settings(&state.config_path, |raw| merge_list_prefs(raw, &sort, &order))?;
    let mut s = state.settings.lock().unwrap();
    s.list_sort = sort;
    s.list_order = order;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meetings;

    fn temp_home(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tractus-organize-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("meetings")).unwrap();
        d
    }

    fn patch(v: Value) -> MetaPatch {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn folders_file_is_read_leniently_like_the_core() {
        assert!(parse_folders("{not json").is_empty());
        assert!(parse_folders(r#"{"folders": "x"}"#).is_empty());
        assert!(parse_folders(r#"[]"#).is_empty());
        let got = parse_folders(
            r#"{"version":1,"folders":[
                {"id":"A","name":"정상","parent":null,"order":2,"created_at":"x"},
                {"id":"B","name":"고아","parent":"NOPE","order":1},
                {"id":"C","name":"고리1","parent":"D"},{"id":"D","name":"고리2","parent":"C"},
                {"id":"A","name":"중복"},{"name":"id 없음"},"문자열",{"id":"E","name":"  "},{"id":"F","name":"자기","parent":"F"}]}"#,
        );
        let ids: Vec<&str> = got.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(got.len(), 5, "{ids:?}");
        let by = |id: &str| got.iter().find(|f| f.id == id).unwrap();
        assert_eq!(by("A").name, "정상");
        assert_eq!((by("B").parent.clone(), by("F").parent.clone()), (None, None));
        assert!(by("C").parent.is_none() || by("D").parent.is_none(), "고리는 끊긴다");
        assert!(by("B").order < by("A").order && ids.iter().position(|i| *i == "B") < ids.iter().position(|i| *i == "A"), "order 순");
    }

    #[test]
    fn load_folders_reads_the_file_and_tolerates_absence() {
        let home = temp_home("folders");
        assert!(load_folders(&home).is_empty());
        fs::write(home.join("folders.json"), r#"{"version":1,"folders":[{"id":"01A","name":"업무","parent":null,"order":1,"created_at":"2026-10-14T09:00:00+09:00"}]}"#).unwrap();
        assert_eq!(load_folders(&home), vec![Folder { id: "01A".into(), name: "업무".into(), parent: None, order: 1, created_at: "2026-10-14T09:00:00+09:00".into() }]);
        fs::write(home.join("folders.json"), "깨짐").unwrap();
        assert!(load_folders(&home).is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn note_meta_args_send_only_given_keys_through_stdin() {
        let (args, input) = note_meta_args("01ABC", &patch(json!({"favorite": true}))).unwrap();
        assert_eq!(args, ["note", "meta", "01ABC"]);
        assert_eq!(serde_json::from_str::<Value>(&input).unwrap(), json!({"favorite": true}));
        // folder: null은 '폴더 없음', 키가 없으면 그대로
        assert_eq!(serde_json::from_str::<Value>(&note_meta_args("01ABC", &patch(json!({"folder": null}))).unwrap().1).unwrap(), json!({"folder": null}));
        assert_eq!(serde_json::from_str::<Value>(&note_meta_args("01ABC", &patch(json!({"folder": "01FOLDER"}))).unwrap().1).unwrap(), json!({"folder": "01FOLDER"}));
        let (_, input) = note_meta_args("01ABC", &patch(json!({"tags": [" #회의  록 ", "", "-x"], "favorite": false}))).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&input).unwrap(), json!({"favorite": false, "tags": ["회의 록", "-x"]}));
    }

    #[test]
    fn note_meta_args_validate_as_the_last_line_of_defence() {
        assert!(note_meta_args("../x", &patch(json!({"favorite": true}))).is_err());
        assert!(note_meta_args("01ABC", &patch(json!({}))).is_err(), "바꿀 것이 없다");
        assert!(note_meta_args("01ABC", &patch(json!({"folder": "a/b"}))).is_err());
        assert_eq!(note_meta_args("01ABC", &patch(json!({"tags": ["a,b"]}))).unwrap_err(), "태그에 쉼표는 쓸 수 없습니다.");
        assert!(note_meta_args("01ABC", &patch(json!({"tags": ["가".repeat(30)]}))).is_ok());
        assert_eq!(note_meta_args("01ABC", &patch(json!({"tags": ["가".repeat(31)]}))).unwrap_err(), "태그는 30자까지 쓸 수 있습니다.");
        let many: Vec<String> = (0..21).map(|i| format!("t{i}")).collect();
        assert_eq!(note_meta_args("01ABC", &patch(json!({ "tags": many }))).unwrap_err(), "태그는 20개까지 붙일 수 있습니다.");
        assert!(note_meta_args("01ABC", &patch(json!({"tags": (0..20).map(|i| format!("t{i}")).collect::<Vec<_>>()}))).is_ok());
    }

    #[test]
    fn note_meta_output_is_read_leniently() {
        assert_eq!(parse_meta(&json!({"favorite": true, "tags": ["a", 3, "b"], "folder": "01F"})), NoteMeta { favorite: true, tags: vec!["a".into(), "b".into()], folder: Some("01F".into()) });
        assert_eq!(parse_meta(&json!({})), NoteMeta { favorite: false, tags: vec![], folder: None });
    }

    #[test]
    fn folder_command_args() {
        assert_eq!(folders_create_args("  업무\n 폴더 ", None).unwrap(), ["folders", "create", "--name=업무 폴더"]);
        assert_eq!(folders_create_args("-x", Some("01P")).unwrap(), ["folders", "create", "--name=-x", "--parent=01P"]);
        assert_eq!(folders_rename_args("01F", "새 이름").unwrap(), ["folders", "rename", "01F", "--name=새 이름"]);
        assert_eq!(folders_move_args("01F", Some("01P")).unwrap(), ["folders", "move", "01F", "--parent=01P"]);
        assert_eq!(folders_move_args("01F", None).unwrap(), ["folders", "move", "01F", "--parent=none"]);
        assert_eq!(folders_delete_args("01F").unwrap(), ["folders", "delete", "01F"]);
        assert_eq!(folders_create_args(" \n ", None).unwrap_err(), "폴더 이름을 입력하세요.");
        assert_eq!(folders_create_args("a/b", None).unwrap_err(), "폴더 이름에 /는 쓸 수 없습니다.");
        assert_eq!(folders_create_args(" None ", None).unwrap_err(), "‘none’은 폴더 이름으로 쓸 수 없습니다.");
        assert!(folders_create_args(&"가".repeat(40), None).is_ok());
        assert_eq!(folders_create_args(&"가".repeat(41), None).unwrap_err(), "폴더 이름은 40자까지 쓸 수 있습니다.");
        assert!(folders_create_args("x", Some("../p")).is_err());
        assert!(folders_rename_args("a b", "x").is_err());
        assert!(folders_move_args("01F", Some("a/b")).is_err());
        assert!(folders_delete_args("").is_err());
    }

    #[test]
    fn list_prefs_merge_touches_only_its_keys() {
        let raw = merge_list_prefs(None, "title", "asc").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), json!({"list_sort": "title", "list_order": "asc"}));
        let raw = merge_list_prefs(Some(r#"{"home": "~/x", "rec_mode": "hybrid"}"#), "created", "desc").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), json!({"home": "~/x", "rec_mode": "hybrid", "list_sort": "created", "list_order": "desc"}));
        assert!(merge_list_prefs(Some("깨짐"), "updated", "desc").is_ok());
        assert!(merge_list_prefs(None, "size", "asc").is_err());
        assert!(merge_list_prefs(None, "title", "up").is_err());
    }

    #[test]
    fn meeting_list_reads_organisation_keys_leniently() {
        let home = temp_home("list");
        let write = |name: &str, extra: &str| {
            let d = home.join("meetings").join(name);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("transcript.json"), format!(r#"{{"meeting_id":"{name}","title":"t","created_at":"2026-10-01T09:00:00+09:00","segments":[]{extra}}}"#)).unwrap();
        };
        write("N1", r#","favorite":true,"tags":["회의","Q3"],"folder":"01F","updated_at":"2026-10-05T10:00:00+09:00""#);
        write("N2", "");
        write("N3", r#","favorite":"yes","tags":"x","folder":5,"updated_at":7"#);
        write("N4", r#","tags":["a",3,null,"b"]"#);
        let list = meetings::list(&home);
        let by = |id: &str| list.iter().find(|m| m.id == id).unwrap();
        assert!(by("N1").favorite && by("N1").tags == ["회의", "Q3"] && by("N1").folder.as_deref() == Some("01F") && by("N1").updated_at == "2026-10-05T10:00:00+09:00");
        assert!(!by("N2").favorite && by("N2").tags.is_empty() && by("N2").folder.is_none() && by("N2").updated_at == "2026-10-01T09:00:00+09:00", "옛 노트: 수정 시각은 만든 시각");
        assert!(!by("N3").favorite && by("N3").tags.is_empty() && by("N3").folder.is_none() && by("N3").updated_at == "2026-10-01T09:00:00+09:00", "이상한 값은 없는 것으로");
        assert_eq!(by("N4").tags, ["a", "b"]);
        let _ = fs::remove_dir_all(&home);
    }

    /// 노트 2,000개 목록 읽기 (사이드바가 처음 뜰 때). 작은 노트 기준이라 느슨한 상한만 둔다
    #[test]
    fn two_thousand_tiny_notes_list_quickly() {
        let home = temp_home("perf");
        for i in 0..2000 {
            let id = format!("01N{i:04}");
            let d = home.join("meetings").join(format!("2026-10-01_노트_{id}"));
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("transcript.json"), format!(r#"{{"meeting_id":"{id}","title":"노트 {i}","created_at":"2026-10-01T09:00:00+09:00","kind":"memo","tags":["a","b"],"favorite":{},"segments":[]}}"#, i % 7 == 0)).unwrap();
        }
        let t0 = std::time::Instant::now();
        let list = meetings::list(&home);
        let ms = t0.elapsed().as_millis();
        eprintln!("2,000개 목록 읽기: {ms} ms");
        assert_eq!(list.len(), 2000);
        assert!(ms < 3000, "{ms} ms");
        let _ = fs::remove_dir_all(&home);
    }
}
