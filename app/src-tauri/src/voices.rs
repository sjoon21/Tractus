//! 목소리 프로필 (Phase 7.1, docs/desktop.md §2.7). 등록·삭제·제안 거절은 코어 `tractus voices`·`speakers dismiss`가 하고
//! 앱은 인수만 만든다. 벡터는 코어가 $TRACTUS_HOME/voices.json(0600)에만 두고, 앱은 이름·개수·날짜만 받는다.

use super::{blocking, is_meeting_id, is_tagged, meetings, run_tractus, stdout_json, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

/// 등록된 사람 한 명. samples는 저장된 목소리 표본 수(최대 5)
#[derive(Serialize, Debug, PartialEq)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub samples: u64,
    pub created_at: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct VoiceList {
    pub people: Vec<Person>,
    /// voices.json의 임베딩 모델이 지금 모델과 달라 맞춰 보지 않는다 → 다시 등록해야 한다
    pub needs_reenroll: bool,
    /// 목소리 인식 모델 파일을 지금 쓸 수 있는지 (`tractus voices list --json`의 `model_present`). 코어가 이 키를 주지 않으면 true로 본다
    pub model_present: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawPerson {
    id: String,
    name: String,
    samples: Value,
    created_at: String,
}

const READ_FAILED: &str = "참석자 목소리 프로필을 읽지 못했습니다";

/// `tractus voices list --json` 마지막 줄: {"people": [...], "reenroll": bool} (docs/desktop.md §2.7). 목록 그대로도 받는다.
/// samples는 개수 또는 목록(길이만 센다), 읽지 못하는 항목은 건너뛴다
fn parse_list(out: &str) -> Result<VoiceList, String> {
    let v: Value = out
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or(READ_FAILED)?;
    let needs_reenroll = v.get("reenroll").and_then(Value::as_bool).unwrap_or(false);
    let model_present = v.get("model_present").and_then(Value::as_bool).unwrap_or(true);
    let items = match &v {
        Value::Array(a) => a.clone(),
        Value::Object(o) => o.get("people").and_then(Value::as_array).cloned().unwrap_or_default(),
        _ => return Err(READ_FAILED.into()),
    };
    let people = items
        .into_iter()
        .filter_map(|p| serde_json::from_value::<RawPerson>(p).ok())
        .filter(|p| !p.id.is_empty())
        .map(|p| Person {
            samples: p.samples.as_u64().or_else(|| p.samples.as_array().map(|a| a.len() as u64)).unwrap_or(0),
            id: p.id,
            name: p.name,
            created_at: p.created_at,
        })
        .collect();
    Ok(VoiceList { people, needs_reenroll, model_present })
}

/// `tractus voices enroll <회의> <라벨> --name=<이름> --consent`. 동의 확인 없이는 인수를 만들지 않는다(코어도 exit 2).
/// `--name=` 꼴로 붙인다: "-박" 같은 이름을 옵션으로 읽지 않게
fn enroll_args(id: &str, label: &str, name: &str, consent: bool) -> Result<Vec<String>, String> {
    if !consent {
        return Err("목소리를 등록하려면 본인이거나 녹음·등록에 동의를 받은 사람이어야 합니다".into());
    }
    let name = name.trim();
    if !is_meeting_id(id) || !is_tagged(label, 'S') || name.is_empty() || name.contains(['\n', '\r']) {
        return Err("목소리를 등록할 수 없습니다 (잘못된 요청)".into());
    }
    Ok(vec!["voices".into(), "enroll".into(), id.into(), label.into(), format!("--name={name}"), "--consent".into()])
}

/// `tractus voices forget -- <id>`. 앱은 이름이 아니라 ID(ULID)로만 지운다 (같은 이름을 잘못 지우지 않게)
fn forget_args(person: &str) -> Result<Vec<String>, String> {
    if !is_meeting_id(person) {
        return Err(format!("잘못된 사람 ID: {person}"));
    }
    Ok(["voices", "forget", "--", person].map(String::from).to_vec())
}

#[tauri::command]
pub async fn voices_list(state: State<'_, AppState>) -> Result<VoiceList, String> {
    let s = state.settings();
    blocking(move || parse_list(&run_tractus(&s, &["voices".into(), "list".into(), "--json".into()], None, READ_FAILED)?)).await
}

#[derive(Serialize)]
pub struct EnrollResult {
    samples: u64,
    meeting: meetings::MeetingDetail,
}

/// 이름 바꾸기 + 목소리 기억하기 한 번에 (코어가 rename까지 한다). 고친 회의와 그 사람의 표본 수를 돌려준다
#[tauri::command]
pub async fn voices_enroll(state: State<'_, AppState>, meeting: String, label: String, name: String, consent: bool) -> Result<EnrollResult, String> {
    let s = state.settings();
    let args = enroll_args(&meeting, &label, &name, consent)?;
    let guard = super::BusyGuard::new(&state.busy, &meeting);
    blocking(move || {
        let _guard = guard;
        let samples = stdout_json(&run_tractus(&s, &args, None, "목소리를 등록하지 못했습니다")?)?["samples"].as_u64().unwrap_or(0);
        Ok(EnrollResult { samples, meeting: meetings::load(&s.home(), &meeting)? })
    })
    .await
}

/// 지운 사람 수 ({"forgotten": N})
#[tauri::command]
pub async fn voices_forget(state: State<'_, AppState>, id: String) -> Result<u64, String> {
    let s = state.settings();
    let args = forget_args(&id)?;
    blocking(move || Ok(stdout_json(&run_tractus(&s, &args, None, "목소리를 지우지 못했습니다")?)?["forgotten"].as_u64().unwrap_or(0))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enroll_requires_consent_and_valid_ids() {
        assert_eq!(
            enroll_args("01ABC", "S2", " -홍길동 ", true).unwrap(),
            ["voices", "enroll", "01ABC", "S2", "--name=-홍길동", "--consent"] // 이름이 '-'로 시작해도 옵션이 아니다
        );
        assert!(enroll_args("01ABC", "S2", "홍길동", false).unwrap_err().contains("동의"));
        for (id, label, name) in [("../x", "S1", "a"), ("01ABC", "S1; rm", "a"), ("01ABC", "new", "a"), ("01ABC", "S1", "  "), ("01ABC", "S1", "a\nb")] {
            assert!(enroll_args(id, label, name, true).is_err(), "{id} {label} {name:?}");
        }
    }

    #[test]
    fn forget_by_id_only() {
        assert_eq!(forget_args("01K6PERSON").unwrap(), ["voices", "forget", "--", "01K6PERSON"]);
        for bad in ["", "홍길동", "--all", "../x"] {
            assert!(forget_args(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parses_voice_list_without_vectors() {
        let out = "로그\n{\"model\":\"m\",\"reenroll\":false,\"people\":[\
            {\"id\":\"01P1\",\"name\":\"홍길동\",\"samples\":3,\"created_at\":\"2026-10-07T10:00:00+09:00\"},\
            {\"id\":\"01P2\",\"name\":\"김\",\"samples\":[{\"meeting_id\":\"x\"},{}]},\
            {\"name\":\"ID 없음\"}, 3]}\n";
        let l = parse_list(out).unwrap();
        assert!(!l.needs_reenroll);
        assert!(l.model_present, "코어가 model_present를 주지 않으면 쓸 수 있다고 본다");
        assert_eq!(l.people.iter().map(|p| (p.id.as_str(), p.samples)).collect::<Vec<_>>(), vec![("01P1", 3), ("01P2", 2)]);
        assert_eq!(l.people[0].created_at, "2026-10-07T10:00:00+09:00");
        // 앱으로 넘기는 값에 벡터가 없다
        assert!(!serde_json::to_string(&l).unwrap().contains("embedding"));

        let missing = parse_list(r#"{"model_present":false,"reenroll":false,"people":[]}"#).unwrap();
        assert!(!missing.model_present);
        assert!(parse_list(r#"{"model_present":true,"people":[]}"#).unwrap().model_present);
        assert!(parse_list(r#"[{"id":"01P","name":"a","samples":1}]"#).unwrap().model_present);
        let stale = parse_list(r#"{"reenroll":true,"people":[]}"#).unwrap();
        assert!(stale.needs_reenroll && stale.people.is_empty());
        assert_eq!(parse_list(r#"[{"id":"01P","name":"a","samples":1}]"#).unwrap().people.len(), 1);
        assert!(parse_list("").is_err());
        assert!(parse_list("done").is_err());
    }

    /// 실제 코어 출력(가상 회의 통합 실행에서 받은 그대로)
    #[test]
    fn parses_real_core_outputs() {
        let l = parse_list(r#"{"people": [{"id": "01M4ABVBAA6N46V7MCV8M7DC17", "name": "유나", "samples": 1, "created_at": "2026-10-07T14:02:17+09:00"}], "reenroll": false}"#).unwrap();
        assert_eq!(
            l,
            VoiceList {
                people: vec![Person { id: "01M4ABVBAA6N46V7MCV8M7DC17".into(), name: "유나".into(), samples: 1, created_at: "2026-10-07T14:02:17+09:00".into() }],
                needs_reenroll: false,
                model_present: true
            }
        );
        let stale = parse_list(r#"{"people": [{"id": "01OLDPERSON", "name": "옛사람", "samples": 1, "created_at": "2026-01-01T00:00:00+09:00"}], "reenroll": true}"#).unwrap();
        assert!(stale.needs_reenroll && stale.people.len() == 1 && forget_args(&stale.people[0].id).is_ok());
        assert!(parse_list(r#"{"people": [], "reenroll": false}"#).unwrap().people.is_empty());
        // v3.17: model_present가 든 현재 코어 출력 (모델 폴더가 비었을 때와 있을 때, 통합 실행에서 받은 그대로)
        assert!(!parse_list(r#"{"people": [], "reenroll": false, "model_present": false}"#).unwrap().model_present);
        assert!(parse_list(r#"{"people": [], "reenroll": false, "model_present": true}"#).unwrap().model_present);
        assert_eq!(stdout_json(r#"{"person_id": "01M4ABVBAA6N46V7MCV8M7DC17", "name": "유나", "samples": 1}"#).unwrap()["samples"].as_u64(), Some(1));
        assert_eq!(stdout_json(r#"{"forgotten": 1}"#).unwrap()["forgotten"].as_u64(), Some(1));
    }
}
