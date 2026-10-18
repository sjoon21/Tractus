//! macOS의 첫 번째 선호 언어 (화면 언어 `시스템 설정`, app/src/i18n.ts).
//! WKWebView의 navigator.language는 앱 번들의 지역화 목록을 따라가서 macOS 언어와 다를 수 있다: 시스템 설정을 직접 읽는다.

use std::process::Command;

/// `defaults read -g AppleLanguages`의 첫 항목 (예: `ko-KR`). 못 읽으면 None (화면은 한국어)
#[tauri::command]
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

#[cfg(test)]
mod tests {
    use super::first_language;

    #[test]
    fn reads_the_first_preferred_language() {
        assert_eq!(first_language("(\n    \"ko-KR\",\n    \"en-US\"\n)\n").as_deref(), Some("ko-KR"));
        assert_eq!(first_language("(\n    en\n)\n").as_deref(), Some("en"));
        assert_eq!(first_language(""), None);
        assert_eq!(first_language("(\n)\n"), None);
    }
}
