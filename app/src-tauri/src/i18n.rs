//! 화면 언어 (docs/desktop.md §3.8). 고른 값은 settings.json `ui_lang`("system" | "ko" | "en"), `system`이면 macOS 첫 선호 언어.
//! Rust가 화면에 보내는 문장(오류·메뉴 막대)은 `t("한국어")`·`tv("‘{title}’ …", &[("title", x)])`로 쓰고 영어는 `en.json`에 둔다 (화면의 app/src/i18n.ts와 같은 규칙).
//! 코어(Python)에는 `TRACTUS_LANG`으로 넘긴다 (Settings::child_env).

use serde_json::Value;
use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static EN: AtomicBool = AtomicBool::new(false);

fn dict() -> &'static HashMap<String, Value> {
    static D: OnceLock<HashMap<String, Value>> = OnceLock::new();
    D.get_or_init(|| serde_json::from_str(include_str!("en.json")).expect("en.json은 JSON 객체다"))
}

/// 지금 언어: "en" | "ko"
pub fn lang() -> &'static str {
    if EN.load(Ordering::Relaxed) { "en" } else { "ko" }
}

pub fn set(lang: &str) {
    EN.store(lang == "en", Ordering::Relaxed);
}

/// 고른 값과 macOS 언어로 정한다. 한국어(`ko…`)면 한국어, 그 밖은 영어, macOS 언어를 모르면 한국어
pub fn resolve(pref: &str, system: Option<&str>) -> &'static str {
    match pref {
        "ko" => "ko",
        "en" => "en",
        _ => match system {
            None => "ko",
            Some(s) if s.to_ascii_lowercase().starts_with("ko") => "ko",
            Some(_) => "en",
        },
    }
}

fn pick(ko: &str, n: Option<i64>) -> String {
    if !EN.load(Ordering::Relaxed) {
        return ko.to_string();
    }
    match dict().get(ko) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(v)) if v.len() == 2 => v[usize::from(n != Some(1))].as_str().unwrap_or(ko).to_string(),
        _ => ko.to_string(),
    }
}

pub fn t(ko: &str) -> String {
    pick(ko, None)
}

/// 자리표시자 `{이름}`을 채운다. `n`이 있으면 영어 복수형을 고른다
pub fn tv(ko: &str, vars: &[(&str, String)]) -> String {
    let n = vars.iter().find(|(k, _)| *k == "n").and_then(|(_, v)| v.parse().ok());
    vars.iter().fold(pick(ko, n), |s, (k, v)| s.replace(&format!("{{{k}}}"), v))
}

/// `defaults read -g AppleLanguages`의 첫 항목 (예: `ko-KR`). 못 읽으면 None
pub fn system_lang() -> Option<String> {
    let out = Command::new("/usr/bin/defaults").args(["read", "-g", "AppleLanguages"]).output().ok()?;
    first_language(&String::from_utf8_lossy(&out.stdout))
}

/// `(\n    "ko-KR",\n    en\n)` 모양에서 첫 항목. 따옴표는 있을 수도 없을 수도 있다
fn first_language(plist: &str) -> Option<String> {
    plist
        .lines()
        .map(|l| l.trim().trim_end_matches(',').trim_matches('"'))
        .find(|l| !l.is_empty() && *l != "(" && *l != ")")
        .map(str::to_string)
}

/// settings.json의 ui_lang만 바꾼다
pub fn merge_ui_lang(raw: Option<&str>, pref: &str) -> Result<String, String> {
    if !matches!(pref, "system" | "ko" | "en") {
        return Err(format!("unknown ui_lang: {pref}"));
    }
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| serde_json::json!({}));
    v["ui_lang"] = serde_json::json!(pref);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_first_preferred_language() {
        assert_eq!(first_language("(\n    \"ko-KR\",\n    \"en-US\"\n)\n").as_deref(), Some("ko-KR"));
        assert_eq!(first_language("(\n    en\n)\n").as_deref(), Some("en"));
        assert_eq!(first_language(""), None);
        assert_eq!(first_language("(\n)\n"), None);
    }

    #[test]
    fn system_follows_macos_and_unknown_is_korean() {
        assert_eq!(resolve("system", Some("ko-KR")), "ko");
        assert_eq!(resolve("system", Some("en-GB")), "en");
        assert_eq!(resolve("system", Some("ja")), "en");
        assert_eq!(resolve("system", None), "ko");
        assert_eq!(resolve("en", Some("ko-KR")), "en");
        assert_eq!(resolve("ko", Some("en-US")), "ko");
        assert_eq!(resolve("bogus", None), "ko");
    }

    /// 문자열 조각: (내용, 시작 줄, 바로 앞 코드 40자). 주석은 버린다. 테스트 모듈(`#[cfg(test)]`) 아래는 보지 않는다
    fn strings(src: &str) -> Vec<(String, usize, String)> {
        let src = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let b: Vec<char> = src.chars().collect();
        let (mut out, mut code, mut line, mut i) = (vec![], String::new(), 1, 0);
        while i < b.len() {
            if b[i] == '/' && b.get(i + 1) == Some(&'/') {
                while i < b.len() && b[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            // 문자 리터럴('"' 등)은 문자열 시작이 아니다
            if b[i] == '\'' && b.get(i + 2) == Some(&'\'') {
                code.push_str("'_'");
                i += 3;
                continue;
            }
            let raw = b[i] == 'r' && matches!(b.get(i + 1), Some('"') | Some('#')) && !b.get(i.wrapping_sub(1)).is_some_and(|c| c.is_alphanumeric() || *c == '_');
            if b[i] == '"' || raw {
                let hashes = if raw { b[i + 1..].iter().take_while(|c| **c == '#').count() } else { 0 };
                let start_line = line;
                let mut j = i + if raw { 2 + hashes } else { 1 };
                let mut text = String::new();
                loop {
                    if j >= b.len() {
                        break;
                    }
                    if b[j] == '"' && b[j + 1..].iter().take(hashes).filter(|c| **c == '#').count() == hashes {
                        break;
                    }
                    if !raw && b[j] == '\\' {
                        text.push(b[j]);
                        j += 1;
                    }
                    if b[j] == '\n' {
                        line += 1;
                    }
                    text.push(b[j]);
                    j += 1;
                }
                let before: String = code.chars().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect();
                out.push((text, start_line, before));
                i = j + 1 + hashes;
                continue;
            }
            if b[i] == '\n' {
                line += 1;
            }
            code.push(b[i]);
            i += 1;
        }
        out
    }

    fn sources() -> Vec<(String, String)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "rs")).map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read_to_string(&p).unwrap())).collect();
        v.sort();
        v
    }

    fn hangul(s: &str) -> bool {
        s.chars().any(|c| ('가'..='힣').contains(&c))
    }

    fn is_t_call(before: &str) -> bool {
        let b = before.trim_end();
        ["t(", "tv("].iter().any(|f| b.ends_with(f) && !b[..b.len() - f.len()].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.'))
    }

    fn unescape(s: &str) -> String {
        s.replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\")
    }

    /// 화면에 가는 한국어 문장은 t()/tv() 안에 있다. eprintln!·expect·panic! 같은 개발자용 출력과 줄 끝 `i18n-ok`는 뺀다
    #[test]
    fn no_hangul_strings_outside_t() {
        let mut left = vec![];
        for (name, src) in sources() {
            let lines: Vec<&str> = src.lines().collect();
            for (text, line, before) in strings(&src) {
                if !hangul(&text) || is_t_call(&before) {
                    continue;
                }
                let l = lines.get(line - 1).copied().unwrap_or("");
                let dev = ["eprintln!", "expect(", "panic!", "unreachable!", "debug_assert", "i18n-ok"];
                if dev.iter().any(|d| l.contains(d) || before.contains(d)) {
                    continue;
                }
                left.push(format!("{name}:{line}: {}", text.chars().take(50).collect::<String>()));
            }
        }
        assert!(left.is_empty(), "t() 밖의 한국어 {}곳:\n{}", left.len(), left.join("\n"));
    }

    #[test]
    fn every_key_has_english_and_every_entry_is_used() {
        let keys: std::collections::BTreeSet<String> = sources().iter().flat_map(|(_, src)| strings(src)).filter(|(t, _, b)| hangul(t) && is_t_call(b)).map(|(t, _, _)| unescape(&t)).collect();
        let missing: Vec<_> = keys.iter().filter(|k| !dict().contains_key(*k)).collect();
        let unused: Vec<_> = dict().keys().filter(|k| !keys.contains(*k)).collect();
        assert!(missing.is_empty(), "영어가 없는 키: {missing:#?}");
        assert!(unused.is_empty(), "쓰이지 않는 번역: {unused:#?}");
    }

    #[test]
    fn english_entries_keep_placeholders_and_have_no_hangul() {
        let vars = |s: &str| {
            let mut v: Vec<String> = s.split('{').skip(1).filter_map(|p| p.split_once('}')).map(|(k, _)| k.to_string()).filter(|k| k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).collect();
            v.sort();
            v
        };
        for (k, v) in dict() {
            let vals: Vec<&str> = match v {
                Value::String(s) => vec![s],
                Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
                _ => panic!("{k}: 값은 문자열이나 [한 개, 여러 개]다"),
            };
            for s in vals {
                assert_eq!(vars(s), vars(k), "{k} → {s}");
                assert!(!hangul(s), "{k} → {s}");
            }
        }
    }

    /// 권한 창 문구: 두 언어의 .strings가 Info.plist와 같은 키를 갖고, 한국어는 Info.plist 그대로다
    #[test]
    fn info_plist_strings_match() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let plist = std::fs::read_to_string(root.join("Info.plist")).unwrap();
        let usage: Vec<(String, String)> = plist.split("<key>").skip(1).filter_map(|p| {
            let (k, rest) = p.split_once("</key>")?;
            let v = rest.trim().strip_prefix("<string>")?.split_once("</string>")?.0;
            k.ends_with("UsageDescription").then(|| (k.to_string(), v.to_string()))
        }).collect();
        assert_eq!(usage.len(), 3);
        for lang in ["ko", "en"] {
            let strings = std::fs::read_to_string(root.join(format!("locales/{lang}.lproj/InfoPlist.strings"))).unwrap();
            for (k, v) in &usage {
                let line = strings.lines().find(|l| l.starts_with(&format!("\"{k}\" = "))).unwrap_or_else(|| panic!("{lang}: {k}"));
                assert!(line.ends_with("\";"), "{line}");
                assert_eq!(lang == "ko", line.contains(v.as_str()), "{lang}: {k}");
                assert_eq!(lang == "en", !hangul(line), "{lang}: {k}");
            }
        }
    }

    #[test]
    fn ui_lang_merge_keeps_other_keys_and_rejects_unknown_values() {
        let out: Value = serde_json::from_str(&merge_ui_lang(Some(r#"{"home":"~/N"}"#), "en").unwrap()).unwrap();
        assert_eq!((out["home"].as_str(), out["ui_lang"].as_str()), (Some("~/N"), Some("en")));
        assert!(merge_ui_lang(None, "fr").is_err());
    }
}
