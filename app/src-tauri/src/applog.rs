//! 앱 로그 파일 (docs/desktop.md §3.10): `<앱 설정 폴더>/logs/app.log`. 넘치면 `app.old.log`로 바꾸고 새로 쓴다(파일은 둘뿐).
//! 남기는 것: 앱의 개발자용 진단(`log_eprintln!`)과 하위 프로세스가 실패했을 때의 stderr 꼬리(녹음 프로그램은 늘).
//! 남기지 않는 것: 노트 문장·제목·사람 이름·API 키·경로의 사용자 이름. 줄마다 `scrub`을 지난다.
//! 파일은 이 컴퓨터에만 있다. 로그를 못 써도 앱은 그대로 돈다. (Yogurt edbf8a7·f4e453b의 두 파일 방식을 따른다, MIT)

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 파일 하나의 상한. 넘으면 앞 파일이 된다: 두 파일을 합쳐 2 MB를 넘지 않는다
const CAP: u64 = 1_000_000;
/// 한 줄의 상한 (stderr의 긴 줄이 파일을 채우지 않게)
const LINE_MAX: usize = 400;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

/// stderr에 찍고(지금과 같다) 앱 로그 파일에도 남긴다. 개발자용 진단 문장이라 t()를 거치지 않는다
macro_rules! log_eprintln {
    ($($a:tt)*) => {{
        let m = format!($($a)*);
        eprintln!("{m}");
        $crate::applog::write(&m);
    }};
}
pub(crate) use log_eprintln;

/// 앱 시작 때 한 번: `<앱 설정 폴더>/logs`. 정하기 전의 줄은 stderr에만 간다
pub fn init(config_dir: &Path) {
    let _ = DIR.set(config_dir.join("logs"));
}

pub fn write(msg: &str) {
    let Some(dir) = DIR.get() else { return };
    let line = format!("{} {}\n", utc_now(), scrub(msg, &Who::current()).replace('\n', "\n  "));
    let _guard = LOCK.lock();
    let _ = append(dir, &line, CAP);
}

fn append(dir: &Path, line: &str, cap: u64) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let file = dir.join("app.log");
    if file.metadata().is_ok_and(|m| m.len() + line.len() as u64 > cap) {
        fs::rename(&file, dir.join("app.old.log"))?; // 앞 파일을 바꿔 쓴다
    }
    OpenOptions::new().create(true).append(true).open(&file)?.write_all(line.as_bytes())
}

/// 경로에서 지울 사용자 정보: 홈 폴더와 사용자 이름
pub struct Who {
    home: Option<String>,
    user: Option<String>,
}

impl Who {
    fn current() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Who { home: var("HOME").or_else(|| var("USERPROFILE")), user: var("USER").or_else(|| var("USERNAME")) }
    }
}

/// 로그에 남기기 전에 가린다: 홈 폴더 → `~`, 사용자 이름 → `<user>`, `meetings/` 다음 폴더 이름(날짜_제목_ID) → `…`, ‘…’·“…” 안(코어 문장이 노트 제목·사람 이름 같은 값을 넣는 자리, WORDS.md) → `‘…’`,
/// 키처럼 생긴 긴 토큰(소문자와 숫자가 섞인 20자 이상) → `***`. 줄은 LINE_MAX에서 자른다.
/// shortcut: 따옴표 밖에 들어간 노트 문장(파이썬 예외 메시지 등)은 못 가린다, 그런 stderr가 보이면 그 자리를 따옴표로 감싸게 코어를 고친다
pub fn scrub(msg: &str, who: &Who) -> String {
    let mut s = msg.to_string();
    if let Some(home) = who.home.as_deref().filter(|h| h.len() > 1) {
        s = s.replace(home, "~").replace(&home.replace('\\', "/"), "~");
    }
    if let Some(user) = who.user.as_deref().filter(|u| u.chars().count() >= 3) {
        s = s.replace(user, "<user>");
    }
    s.lines().map(|l| cut(&mask_keys(&mask_quoted(&mask_note_dirs(l))))).collect::<Vec<_>>().join("\n")
}

/// 노트 폴더 이름에는 제목이 들어 있다: `meetings/` 다음 칸을 다음 경로 구분자까지 지운다 (제목에 공백이 있을 수 있어 줄 끝까지 갈 수 있다)
fn mask_note_dirs(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(i) = rest.find("meetings/").or_else(|| rest.find("meetings\\")) {
        let start = i + "meetings/".len();
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail.find(['/', '\\']).unwrap_or(tail.len());
        if end > 0 {
            out.push('…');
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn mask_quoted(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(i) = rest.find(['‘', '“']) {
        let open = rest[i..].chars().next().unwrap();
        let close = if open == '‘' { '’' } else { '”' };
        let after = &rest[i + open.len_utf8()..];
        let Some(j) = after.find(close) else { break };
        out.push_str(&rest[..i]);
        out.push(open);
        out.push('…');
        out.push(close);
        rest = &after[j + close.len_utf8()..];
    }
    out.push_str(rest);
    out
}

fn mask_keys(line: &str) -> String {
    let is_tok = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    let mut out = String::new();
    let mut tok = String::new();
    let flush = |tok: &mut String, out: &mut String| {
        let key_like = tok.len() >= 20 && tok.chars().any(|c| c.is_ascii_lowercase()) && tok.chars().any(|c| c.is_ascii_digit());
        out.push_str(if key_like { "***" } else { tok });
        tok.clear();
    };
    for c in line.chars() {
        if is_tok(c) {
            tok.push(c);
        } else {
            flush(&mut tok, &mut out);
            out.push(c);
        }
    }
    flush(&mut tok, &mut out);
    out
}

fn cut(line: &str) -> String {
    match line.char_indices().nth(LINE_MAX) {
        Some((i, _)) => format!("{}…", &line[..i]),
        None => line.to_string(),
    }
}

/// `2026-11-27T03:04:05Z` (UTC). 날짜 크레이트 없이 계산한다 (Howard Hinnant의 civil_from_days)
fn utc_now() -> String {
    utc(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()))
}

fn utc(secs: u64) -> String {
    let (days, s) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", s / 3600, s / 60 % 60, s % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_dates() {
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc(1_795_741_445), "2026-11-27T01:04:05Z");
    }

    #[test]
    fn scrub_hides_user_paths_quoted_values_and_keys() {
        let who = Who { home: Some("/Users/kim".into()), user: Some("kim".into()) };
        let s = scrub("Error: ‘예산 회의’에 해당하는 노트가 없습니다 (/Users/kim/Tractus/meetings/01X)", &who);
        assert_eq!(s, "Error: ‘…’에 해당하는 노트가 없습니다 (~/Tractus/meetings/…");
        assert_eq!(scrub("노트 파일을 읽지 못했습니다\n/Users/kim/T/meetings/2026-10-02_예산 회의_01X/transcript.json: EOF", &who), "노트 파일을 읽지 못했습니다\n~/T/meetings/…/transcript.json: EOF");
        assert_eq!(scrub(r"C:\T\meetings\2026_예산_01X\a.json", &who), r"C:\T\meetings\…\a.json");
        assert_eq!(scrub("“김민수” 님 kim@host", &who), "“…” 님 <user>@host");
        assert_eq!(scrub("Authorization: Bearer up_a1b2c3d4e5f6g7h8i9j0k1", &who), "Authorization: Bearer ***");
        // 노트 ID(ULID, 대문자)와 장치 이름·소리 크기는 그대로다 (녹음 프로그램 진단)
        assert_eq!(scrub("01KQ8Z3V5W6X7Y8Z9A0B1C2D3E mic \"MacBook Pro Microphone\" rms -32.5 dB", &who), "01KQ8Z3V5W6X7Y8Z9A0B1C2D3E mic \"MacBook Pro Microphone\" rms -32.5 dB");
        let win = Who { home: Some(r"C:\Users\kim".into()), user: Some("kim".into()) };
        assert_eq!(scrub(r"File C:\Users\kim\AppData\x.py and C:/Users/kim/y", &win), r"File ~\AppData\x.py and ~/y");
        assert_eq!(scrub("열림 ‘닫히지 않음", &who), "열림 ‘닫히지 않음"); // 짝이 없으면 그대로
        assert_eq!(scrub(&"가".repeat(500), &who).chars().count(), LINE_MAX + 1);
    }

    #[test]
    fn keeps_two_files_under_the_cap() {
        let dir = std::env::temp_dir().join(format!("tractus-applog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for i in 0..30 {
            append(&dir, &format!("{i:02} {}\n", "x".repeat(16)), 100).unwrap();
        }
        let cur = fs::read_to_string(dir.join("app.log")).unwrap();
        let old = fs::read_to_string(dir.join("app.old.log")).unwrap();
        assert!(cur.len() <= 100 && old.len() <= 100);
        assert!(cur.ends_with(&format!("29 {}\n", "x".repeat(16))));
        assert!(old.lines().last().unwrap() < cur.lines().next().unwrap()); // 앞 파일이 바로 앞 줄들이다
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
