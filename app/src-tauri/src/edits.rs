//! 노트를 고치는 짧은 명령: 메모·제목·대화 내용·참석자·AI 다듬기 제안·녹음 중 메모, 그리고 내보내기.
//! 쓰기는 모두 코어 CLI가 하고(앱은 인수와 stdin JSON만 만든다), 도는 동안 노트를 쓰는 중으로 표시한다(`BusyGuard`).

use crate::i18n::{t, tv};
use super::{blocking, is_meeting_id, is_tagged, meetings, run_tractus, stdout_json, summaries, AppState, BusyGuard};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tauri::State;

/// 녹음 중 남긴 메모·북마크 고치기·지우기 (`tractus marks <노트> save`, stdin {"marks": …}). 남은 목록만 보낸다.
/// 새로 끼워 넣거나 시각·종류를 바꾸는 것은 코어가 거절한다. → {"marks": […]}
#[tauri::command]
pub async fn marks_save(state: State<'_, AppState>, id: String, marks: Value) -> Result<Value, String> {
    if !is_meeting_id(&id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.clone())]));
    }
    let s = state.settings();
    let args: Vec<String> = ["marks", &id, "save"].map(String::from).to_vec();
    let input = json!({ "marks": marks }).to_string();
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        stdout_json(&run_tractus(&s, &args, Some(&input), &t("메모를 저장하지 못했습니다"))?)
    })
    .await
}

/// 화자 편집 (docs/desktop.md §2.1). 프론트엔드가 {"op":"rename","label":"S1","name":"김민수"} 꼴로 보낸다.
/// dismiss: 목소리 제안 거절 (Phase 7.1, §2.7). 제안 확정은 그 이름으로 rename
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum SpeakerEdit {
    Rename { label: String, name: String },
    Set { segment: String, label: String },
    Merge { from: String, into: String },
    Dismiss { label: String },
}

/// `tractus speakers <회의> <명령> -- <인자…>`. 인자는 `--` 뒤에 둔다("-박" 같은 이름을 옵션으로 읽지 않게)
fn speakers_args(id: &str, edit: &SpeakerEdit) -> Result<Vec<String>, String> {
    let bad = || t("잘못된 참석자 편집입니다");
    if !is_meeting_id(id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    let (op, rest) = match edit {
        SpeakerEdit::Rename { label, name } if is_tagged(label, 'S') && !name.contains(['\n', '\r']) => ("rename", vec![label.as_str(), name.trim()]),
        SpeakerEdit::Set { segment, label } if is_tagged(segment, 's') && (is_tagged(label, 'S') || label == "new") => ("set", vec![segment.as_str(), label]),
        SpeakerEdit::Merge { from, into } if is_tagged(from, 'S') && is_tagged(into, 'S') && from != into => ("merge", vec![from.as_str(), into]),
        SpeakerEdit::Dismiss { label } if is_tagged(label, 'S') => ("dismiss", vec![label.as_str()]),
        _ => return Err(bad()),
    };
    Ok(["speakers", id, op, "--"].into_iter().chain(rest).map(String::from).collect())
}

/// 화자 편집을 코어에 맡기고(transcript.json·md·vtt·검색 색인을 코어가 고친다) 고친 회의를 다시 읽어 돌려준다.
#[tauri::command]
pub async fn edit_speakers(state: State<'_, AppState>, id: String, edit: SpeakerEdit) -> Result<meetings::MeetingDetail, String> {
    let s = state.settings();
    let args = speakers_args(&id, &edit)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        run_tractus(&s, &args, None, &t("참석자를 고치지 못했습니다"))?;
        meetings::load(&s.home(), &id)
    })
    .await
}

/// 문장 편집 한 건 (Phase 5.3). text가 원문과 같으면 코어가 corrected_text를 해제한다
#[derive(Deserialize, Serialize, Debug)]
pub struct TextEdit {
    id: String,
    text: String,
}

/// `tractus segments <회의> edit` 인수와 stdin JSON. 문장은 인수가 아니라 stdin으로 넘긴다(길이·특수 문자 걱정 없이)
fn segments_edit(id: &str, edits: &[TextEdit]) -> Result<(Vec<String>, String), String> {
    if !is_meeting_id(id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    if edits.is_empty() || edits.iter().any(|e| !is_tagged(&e.id, 's') || e.text.trim().is_empty()) {
        return Err(t("빈 내용은 저장할 수 없습니다"));
    }
    Ok((["segments", id, "edit"].map(String::from).to_vec(), json!({ "edits": edits }).to_string()))
}

/// 문장 편집 결과: 코어가 실제로 바꾼 세그먼트 수({"changed": N})와 고친 회의
#[derive(Serialize)]
pub struct EditResult {
    changed: u64,
    meeting: meetings::MeetingDetail,
}

/// 문장 편집 묶음을 한 번에 저장하고 고친 회의를 돌려준다. 바꾸기 200건도 호출 1회다
#[tauri::command]
pub async fn edit_segments(state: State<'_, AppState>, id: String, edits: Vec<TextEdit>) -> Result<EditResult, String> {
    let s = state.settings();
    let (args, input) = segments_edit(&id, &edits)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let changed = stdout_json(&run_tractus(&s, &args, Some(&input), &t("대화 내용을 수정하지 못했습니다"))?)?["changed"].as_u64().unwrap_or(0);
        Ok(EditResult { changed, meeting: meetings::load(&s.home(), &id)? })
    })
    .await
}

/// `tractus polish <노트> accept|reject` + stdin {"ids": [...]}. 받으면 고친 문장으로 바꾸고(원문은 남는다) 제안에서 뺀다
fn polish_resolve_args(id: &str, ids: &[String], accept: bool) -> Result<(Vec<String>, String), String> {
    if !is_meeting_id(id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    if ids.is_empty() || ids.iter().any(|i| !is_tagged(i, 's')) {
        return Err(t("고를 제안이 없습니다"));
    }
    let verb = if accept { "accept" } else { "reject" };
    Ok((["polish", id, verb].map(String::from).to_vec(), json!({ "ids": ids }).to_string()))
}

/// AI 다듬기 제안 받기·버리기. 고친 회의(남은 제안 포함)를 돌려준다
#[tauri::command]
pub async fn polish_resolve(state: State<'_, AppState>, id: String, ids: Vec<String>, accept: bool) -> Result<EditResult, String> {
    let s = state.settings();
    let (args, input) = polish_resolve_args(&id, &ids, accept)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let fail = if accept { t("제안을 수락하지 못했습니다") } else { t("제안을 거절하지 못했습니다") };
        let changed = stdout_json(&run_tractus(&s, &args, Some(&input), &fail)?)?["changed"].as_u64().unwrap_or(0);
        Ok(EditResult { changed, meeting: meetings::load(&s.home(), &id)? })
    })
    .await
}

/// 메모 본문 상한 (글자 수). 코어 `note save`와 같다
const MEMO_BODY_MAX: usize = 200_000;
/// 제목 길이 상한 (글자 수). 코어 `note title`과 같다
const TITLE_MAX: usize = 120;

/// 제목: 공백·줄바꿈은 한 칸으로 줄이고 앞뒤를 자른다 (코어 store.one_line). 1~120자. 화면이 먼저 거르므로 여기는 마지막 방어선이다
pub(crate) fn clean_title(raw: &str) -> Result<String, String> {
    let title = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    match title.chars().count() {
        0 => Err(t("제목을 입력하세요.")),
        n if n > TITLE_MAX => Err(tv("제목은 {TITLE_MAX}자까지 쓸 수 있습니다.", &[("TITLE_MAX", TITLE_MAX.to_string())])),
        _ => Ok(title),
    }
}

/// `tractus note new`. 제목이 없으면 코어가 `메모 HH:MM`으로 정한다. 있으면 stdin JSON으로 넘긴다
fn note_new_args(title: Option<&str>) -> Result<(Vec<String>, Option<String>), String> {
    let input = match title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => Some(json!({ "title": clean_title(t)? }).to_string()),
        None => None,
    };
    Ok((["note", "new"].map(String::from).to_vec(), input))
}

/// `tractus note save <노트>` 인수와 stdin JSON. 본문은 인수가 아니라 stdin으로 넘긴다 (길이·특수 문자 걱정 없이)
fn note_save_args(id: &str, body: &str) -> Result<(Vec<String>, String), String> {
    if !is_meeting_id(id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    if body.chars().count() > MEMO_BODY_MAX {
        return Err(t("메모는 200,000자까지 쓸 수 있습니다."));
    }
    Ok((["note", "save", id].map(String::from).to_vec(), json!({ "body": body }).to_string()))
}

/// `tractus note title <노트>` 인수와 stdin JSON
fn note_title_args(id: &str, title: &str) -> Result<(Vec<String>, String, String), String> {
    if !is_meeting_id(id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    let title = clean_title(title)?;
    Ok((["note", "title", id].map(String::from).to_vec(), json!({ "title": title }).to_string(), title))
}

/// 새 메모 노트. 코어가 폴더·transcript.json·검색 정보(단어 일치)까지 만든다
#[derive(Serialize)]
pub struct NoteNew {
    meeting_id: String,
}

#[tauri::command]
pub async fn note_new(state: State<'_, AppState>, title: Option<String>) -> Result<NoteNew, String> {
    let s = state.settings();
    let (args, input) = note_new_args(title.as_deref())?;
    blocking(move || {
        let v = stdout_json(&run_tractus(&s, &args, input.as_deref(), &t("메모를 만들지 못했습니다"))?)?;
        let meeting_id = v["meeting_id"].as_str().filter(|id| is_meeting_id(id)).ok_or_else(|| t("만든 메모를 찾지 못했습니다"))?.to_string();
        Ok(NoteNew { meeting_id })
    })
    .await
}

/// 메모 저장 결과: 코어가 만든 줄(대화) 수와 고친 노트
#[derive(Serialize)]
pub struct NoteSaved {
    segments: u64,
    meeting: meetings::MeetingDetail,
}

/// 메모 본문을 저장하고(코어가 대화·md·검색 정보를 고친다) 고친 노트를 돌려준다. 메모 노트는 본문을, 녹음 노트는 오른쪽 패널 메모 탭의 글을 저장한다 (코어가 노트 종류로 가른다).
/// 노트를 처리 중으로 표시해 삭제가 기다리게 한다
#[tauri::command]
pub async fn note_save(state: State<'_, AppState>, id: String, body: String) -> Result<NoteSaved, String> {
    let s = state.settings();
    let (args, input) = note_save_args(&id, &body)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let segments = stdout_json(&run_tractus(&s, &args, Some(&input), &t("메모를 저장하지 못했습니다"))?)?["segments"].as_u64().unwrap_or(0);
        Ok(NoteSaved { segments, meeting: meetings::load(&s.home(), &id)? })
    })
    .await
}

/// 예시 노트(온보딩)를 만들고 그 ID를 돌려준다. 이미 있으면 그것 (`tractus note sample`, 모델·AI 키 없이 돈다)
#[tauri::command]
pub async fn note_sample(state: State<'_, AppState>) -> Result<String, String> {
    let s = state.settings();
    blocking(move || {
        let v = stdout_json(&run_tractus(&s, &["note".into(), "sample".into()], None, &t("예시 노트를 만들지 못했습니다"))?)?;
        v["meeting_id"].as_str().filter(|id| is_meeting_id(id)).map(String::from).ok_or_else(|| t("예시 노트를 만들지 못했습니다"))
    })
    .await
}

/// 노트 제목을 바꾼다 (녹음·메모 모두). 폴더 이름은 그대로다. 코어가 돌려준 제목(없으면 보낸 제목)
#[tauri::command]
pub async fn note_title(state: State<'_, AppState>, id: String, title: String) -> Result<String, String> {
    let s = state.settings();
    let (args, input, sent) = note_title_args(&id, &title)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let v = stdout_json(&run_tractus(&s, &args, Some(&input), &t("제목을 바꾸지 못했습니다"))?)?;
        Ok(v["title"].as_str().map_or(sent, String::from))
    })
    .await
}

const EXPORT_FORMATS: &[&str] = &["txt", "md", "srt", "vtt", "csv", "docx", "bundle"];

/// 내보내기 창에서 고를 수 있는 부분 (코어 export.PARTS): 대화 내용(메모는 메모 내용) · 메모 탭의 메모 · 녹음 중 메모
const EXPORT_PARTS: &[&str] = &["transcript", "memo", "marks"];

/// `tractus export`. 경로는 저장 대화상자가 고른 절대 경로이고, 덮어쓰기는 대화상자가 이미 물었으므로 --force
/// parts: md·docx 내보내기 창에서 고른 부분(`--parts`). 주면 summaries(고른 요약 key, 그 순서)만 넣고, 비면 요약 없음.
/// 다른 형식은 parts·summaries 없이 부른다
fn export_args(id: &str, format: &str, out: &Path, summaries: &[String], parts: Option<&[String]>) -> Result<Vec<String>, String> {
    let picks_ok = match parts {
        Some(p) => ["md", "docx"].contains(&format) && p.iter().all(|x| EXPORT_PARTS.contains(&x.as_str())) && summaries.iter().all(|k| summaries::is_summary_key(k)),
        None => summaries.is_empty(),
    };
    if !is_meeting_id(id) || !EXPORT_FORMATS.contains(&format) || !out.is_absolute() || out.file_name().is_none() || !picks_ok {
        return Err(tv("잘못된 내보내기: {id} {format} {path}", &[("id", id.to_string()), ("format", format.to_string()), ("path", out.display().to_string())]));
    }
    let out = out.to_string_lossy();
    let mut args: Vec<String> = ["export", id, "--format", format, "--out", &out, "--force"].map(String::from).to_vec();
    args.extend(summaries.iter().map(|k| format!("--summary={k}")));
    if let Some(p) = parts {
        args.push(format!("--parts={}", p.join(",")));
    }
    Ok(args)
}

/// 내보내고 Finder에서 그 파일을 보여 준다. 반환값은 코어가 쓴 절대 경로
#[tauri::command]
pub async fn export_meeting(state: State<'_, AppState>, id: String, format: String, out: String, summaries: Vec<String>, parts: Option<Vec<String>>) -> Result<String, String> {
    let s = state.settings();
    let args = export_args(&id, &format, Path::new(&out), &summaries, parts.as_deref())?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let v = stdout_json(&run_tractus(&s, &args, None, &t("내보내지 못했습니다"))?)?;
        let path = v["path"].as_str().ok_or_else(|| t("내보낸 파일 위치를 알 수 없습니다"))?.to_string();
        // Finder 보여 주기가 실패해도 파일은 이미 저장됐다
        if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&path) {
            eprintln!("Finder에서 보여 주지 못했습니다: {e}");
        }
        Ok(path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speakers_command_args() {
        let edit = |v: Value| serde_json::from_value::<SpeakerEdit>(v).unwrap();
        let args = |v: Value| speakers_args("01ABC", &edit(v));
        // 인자는 `--` 뒤에 둔다: "-박" 같은 이름을 옵션으로 읽지 않게
        assert_eq!(
            args(json!({"op":"rename","label":"S1","name":" 김민수 "})).unwrap(),
            ["speakers", "01ABC", "rename", "--", "S1", "김민수"]
        );
        assert_eq!(args(json!({"op":"rename","label":"S2","name":""})).unwrap()[5], ""); // 이름 지우기
        assert_eq!(args(json!({"op":"set","segment":"s0012","label":"new"})).unwrap(), ["speakers", "01ABC", "set", "--", "s0012", "new"]);
        assert_eq!(args(json!({"op":"set","segment":"s0012","label":"S2"})).unwrap()[5], "S2");
        assert_eq!(args(json!({"op":"merge","from":"S3","into":"S1"})).unwrap(), ["speakers", "01ABC", "merge", "--", "S3", "S1"]);
        assert_eq!(args(json!({"op":"dismiss","label":"S2"})).unwrap(), ["speakers", "01ABC", "dismiss", "--", "S2"]);

        for bad in [
            json!({"op":"rename","label":"S1; rm","name":"x"}),
            json!({"op":"rename","label":"S1","name":"a\nb"}),
            json!({"op":"set","segment":"../x","label":"S1"}),
            json!({"op":"set","segment":"s0001","label":"S"}),
            json!({"op":"merge","from":"S1","into":"S1"}),
            json!({"op":"merge","from":"new","into":"S1"}),
            json!({"op":"dismiss","label":"new"}),
        ] {
            assert!(args(bad.clone()).is_err(), "{bad}");
        }
        assert!(speakers_args("../01ABC", &edit(json!({"op":"merge","from":"S2","into":"S1"}))).is_err());
        assert!(serde_json::from_value::<SpeakerEdit>(json!({"op":"list"})).is_err()); // 편집만 받는다
    }

    #[test]
    fn polish_resolve_args_and_stdin() {
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (args, input) = polish_resolve_args("01ABC", &ids(&["s0012", "s0013"]), true).unwrap();
        assert_eq!(args, ["polish", "01ABC", "accept"]);
        assert_eq!(serde_json::from_str::<Value>(&input).unwrap(), json!({"ids": ["s0012", "s0013"]}));
        assert_eq!(polish_resolve_args("01ABC", &ids(&["s0001"]), false).unwrap().0, ["polish", "01ABC", "reject"]);
        assert!(polish_resolve_args("../x", &ids(&["s0001"]), true).is_err());
        assert!(polish_resolve_args("01ABC", &[], true).is_err());
        assert!(polish_resolve_args("01ABC", &ids(&["m0001"]), true).is_err());
    }

    #[test]
    fn segments_edit_args_and_stdin() {
        let e = |id: &str, text: &str| TextEdit { id: id.into(), text: text.into() };
        let (args, input) = segments_edit("01ABC", &[e("s0012", "새 문장"), e("s0013", "-- $(rm) \"따옴표\"")]).unwrap();
        assert_eq!(args, ["segments", "01ABC", "edit"]); // 문장은 인수가 아니라 stdin JSON으로
        let v: Value = serde_json::from_str(&input).unwrap();
        assert_eq!(v, json!({"edits": [{"id": "s0012", "text": "새 문장"}, {"id": "s0013", "text": "-- $(rm) \"따옴표\""}]}));
        assert!(segments_edit("../x", &[e("s0001", "a")]).is_err());
        assert!(segments_edit("01ABC", &[]).is_err());
        assert!(segments_edit("01ABC", &[e("S1", "a")]).is_err());
        assert!(segments_edit("01ABC", &[e("s0001", "  ")]).is_err()); // 빈 문장은 코어도 거부한다
    }

    #[test]
    fn note_command_args() {
        // 새 메모: 제목이 없으면 stdin 없이 (코어가 `메모 HH:MM`), 있으면 한 줄로 줄여 JSON으로
        assert_eq!(note_new_args(None).unwrap(), (vec!["note".to_string(), "new".into()], None));
        assert_eq!(note_new_args(Some("  \n ")).unwrap().1, None);
        let (_, input) = note_new_args(Some("  주간\n 아이디어 ")).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&input.unwrap()).unwrap(), json!({"title": "주간 아이디어"}));
        assert!(note_new_args(Some(&"가".repeat(121))).is_err());

        // 저장: 본문은 stdin JSON으로 그대로 (줄바꿈·따옴표·-- 포함)
        let body = "첫 줄\n\n-- $(rm) \"따옴표\" 😀";
        let (args, input) = note_save_args("01ABC", body).unwrap();
        assert_eq!(args, ["note", "save", "01ABC"]);
        assert_eq!(serde_json::from_str::<Value>(&input).unwrap(), json!({ "body": body }));
        assert!(note_save_args("01ABC", "").is_ok(), "빈 메모도 저장한다");
        assert!(note_save_args("../x", "a").is_err());
        assert!(note_save_args("01ABC", &"가".repeat(200_000)).is_ok());
        assert_eq!(note_save_args("01ABC", &"가".repeat(200_001)).unwrap_err(), "메모는 200,000자까지 쓸 수 있습니다.");

        // 제목: 한국어·이모지는 글자 수로 센다 (코어 len과 같다), 빈 제목·너무 긴 제목은 문장으로 거절
        let (args, input, title) = note_title_args("01ABC", " 회의 😀\t정리\n").unwrap();
        assert_eq!((args, title.as_str()), (vec!["note".to_string(), "title".into(), "01ABC".into()], "회의 😀 정리"));
        assert_eq!(serde_json::from_str::<Value>(&input).unwrap(), json!({"title": "회의 😀 정리"}));
        assert!(note_title_args("01ABC", &"😀".repeat(120)).is_ok());
        assert_eq!(note_title_args("01ABC", &"😀".repeat(121)).unwrap_err(), "제목은 120자까지 쓸 수 있습니다.");
        assert_eq!(note_title_args("01ABC", " \n ").unwrap_err(), "제목을 입력하세요.");
        assert!(note_title_args("a b", "x").is_err());
    }

    #[test]
    fn export_command_args() {
        let out = Path::new("/Users/me/Desktop/2026-10-02_주간회의.docx");
        assert_eq!(
            export_args("01ABC", "docx", out, &[], None).unwrap(),
            ["export", "01ABC", "--format", "docx", "--out", out.to_str().unwrap(), "--force"] // 덮어쓰기는 저장 대화상자가 이미 물었다
        );
        assert!(export_args("01ABC", "pdf", out, &[], None).is_err());
        assert!(export_args("01ABC", "--force", out, &[], None).is_err());
        assert!(export_args("01ABC", "txt", Path::new("rel.txt"), &[], None).is_err());
        assert!(export_args("../x", "txt", out, &[], None).is_err());
    }

    #[test]
    fn export_picks_summaries_and_parts() {
        let out = Path::new("/Users/me/Desktop/a.md");
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let args = export_args("01ABC", "md", out, &s(&["minutes", "brief"]), Some(&s(&["transcript", "marks"]))).unwrap();
        assert_eq!(args[7..], ["--summary=minutes", "--summary=brief", "--parts=transcript,marks"]);
        assert_eq!(export_args("01ABC", "docx", out, &s(&["meeting"]), Some(&[])).unwrap().last().unwrap(), "--parts="); // 요약만
        assert_eq!(export_args("01ABC", "md", out, &[], Some(&s(&["memo"]))).unwrap()[7..], ["--parts=memo"]); // 요약 없음
        assert!(export_args("01ABC", "md", out, &s(&["../x"]), Some(&[])).is_err());
        assert!(export_args("01ABC", "md", out, &s(&["--force"]), Some(&[])).is_err());
        assert!(export_args("01ABC", "md", out, &[], Some(&s(&["audio"]))).is_err());
        assert!(export_args("01ABC", "md", out, &[], Some(&s(&["transcript,memo"]))).is_err()); // 쉼표를 끼워 넣지 못한다
        assert!(export_args("01ABC", "txt", out, &[], Some(&s(&["transcript"]))).is_err()); // 고르기는 md·docx만
        assert!(export_args("01ABC", "md", out, &s(&["brief"]), None).is_err()); // 요약은 parts와 함께만
    }
}
