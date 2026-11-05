//! 사전 (WORDS.md §4.29, 코드 이름 glossary): `tractus glossary add|remove|rename|list`.

use crate::i18n::t;
use super::{blocking, run_tractus, stdout_json, AppState};
use serde_json::Value;
use tauri::State;

/// `tractus glossary add|remove|rename -- <용어…>`. 사전(glossary.md) 단어는 다음 전사의 hotwords가 된다.
/// 중복·한도·없는 단어는 코어가 가린다. 여기서는 빈 값과 줄바꿈(한 줄에 한 단어인 파일 형식을 깬다)만 막는다
fn glossary_args(verb: &str, terms: &[String]) -> Result<Vec<String>, String> {
    let terms: Vec<&str> = terms.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    let count_ok = if verb == "rename" { terms.len() == 2 } else { !terms.is_empty() };
    if !count_ok || terms.iter().any(|t| t.contains(['\n', '\r'])) {
        return Err(t("사전에 넣을 단어가 없습니다"));
    }
    Ok(["glossary", verb, "--"].into_iter().chain(terms).map(String::from).collect())
}

fn glossary_run(state: &State<'_, AppState>, verb: &str, terms: &[String]) -> Result<impl FnOnce() -> Result<Value, String> + Send + 'static, String> {
    let s = state.settings();
    let args = glossary_args(verb, terms)?;
    Ok(move || stdout_json(&run_tractus(&s, &args, None, &t("사전을 고치지 못했습니다"))?))
}

/// 사전에 단어 더하기 → {"added": N, "skipped": M} (skipped: 40자 초과·사전이 가득 참)
#[tauri::command]
pub async fn glossary_add(state: State<'_, AppState>, terms: Vec<String>) -> Result<Value, String> {
    blocking(glossary_run(&state, "add", &terms)?).await
}

/// 사전 단어 지우기 → {"removed": N}
#[tauri::command]
pub async fn glossary_remove(state: State<'_, AppState>, terms: Vec<String>) -> Result<Value, String> {
    blocking(glossary_run(&state, "remove", &terms)?).await
}

/// 사전 단어 하나 고치기 → {"changed": bool}. 새 단어가 이미 있으면 옛 단어만 지운다
#[tauri::command]
pub async fn glossary_rename(state: State<'_, AppState>, old: String, new: String) -> Result<Value, String> {
    blocking(glossary_run(&state, "rename", &[old, new])?).await
}

/// 사전 단어 목록 → {"terms": [최근에 더한 것부터], "max": 변환이 쓰는 개수}
#[tauri::command]
pub async fn glossary_list(state: State<'_, AppState>) -> Result<Value, String> {
    let s = state.settings();
    blocking(move || stdout_json(&run_tractus(&s, &["glossary", "list", "--json"].map(String::from), None, &t("사전을 읽지 못했습니다"))?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glossary_command_args() {
        let t = |verb: &str, v: &[&str]| glossary_args(verb, &v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(t("add", &[" budget ", "", "-WTO"]).unwrap(), ["glossary", "add", "--", "budget", "-WTO"]);
        assert_eq!(t("remove", &["-WTO"]).unwrap(), ["glossary", "remove", "--", "-WTO"]);
        assert!(t("add", &["  "]).is_err());
        assert!(t("add", &["a\nb"]).is_err());
        // 고치기는 옛 단어·새 단어 정확히 둘: 새 단어가 비면 거절 (코어가 1~40자를 본다)
        assert_eq!(t("rename", &["쿠버", " 쿠버네티스 "]).unwrap(), ["glossary", "rename", "--", "쿠버", "쿠버네티스"]);
        assert!(t("rename", &["쿠버", " "]).is_err());
        assert!(t("rename", &["a", "b\nc"]).is_err());
    }
}
