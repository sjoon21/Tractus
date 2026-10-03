//! 회의 오디오 전용 URI 스킴 `media://localhost/<인코딩된 절대 경로>` (프론트엔드: convertFileSrc(path, "media")).
//!
//! Tauri asset protocol을 쓰지 않는 이유: asset protocol은 내용으로 MIME을 추정해 Ogg Opus를 `audio/opus`로 보내는데,
//! WKWebView는 `audio/opus`를 재생하지 못하고(MEDIA_ERR_SRC_NOT_SUPPORTED) `audio/ogg`면 재생한다 (macOS 26.6에서 확인).
//! 그래서 MIME을 `audio/ogg`로 고정하고 Range 요청(탐색)을 직접 처리한다. 회의 폴더 밖 파일은 열지 않는다.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::http::{header, Response, StatusCode};

const AUDIO_EXT: [&str; 2] = ["ogg", "opus"];

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

/// "bytes=a-b" | "bytes=a-" | "bytes=-n" → [start, end] (포함). 형식이 틀리거나 범위 밖이면 None.
fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let (a, b) = h.strip_prefix("bytes=")?.split(',').next()?.trim().split_once('-')?;
    let (start, end) = match (a.parse::<u64>().ok(), b.parse::<u64>().ok()) {
        (Some(s), Some(e)) => (s, e.min(len.saturating_sub(1))),
        (Some(s), None) if b.is_empty() => (s, len.saturating_sub(1)),
        (None, Some(n)) if a.is_empty() && n > 0 => (len.saturating_sub(n), len.saturating_sub(1)),
        _ => return None,
    };
    (start <= end && end < len).then_some((start, end))
}

pub fn respond(meetings_dir: &Path, uri_path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let decoded = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8_lossy().into_owned();
    let path = Path::new(&decoded);
    let allowed = match (path.canonicalize(), meetings_dir.canonicalize()) {
        (Ok(p), Ok(root)) => p.starts_with(&root) && p.extension().and_then(|e| e.to_str()).is_some_and(|e| AUDIO_EXT.contains(&e)),
        _ => false,
    };
    if !allowed {
        return status(StatusCode::FORBIDDEN);
    }
    let Ok(mut file) = File::open(path) else { return status(StatusCode::NOT_FOUND) };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let (start, end, code) = match range {
        None => (0, len.saturating_sub(1), StatusCode::OK),
        Some(h) => match parse_range(h, len) {
            Some((s, e)) => (s, e, StatusCode::PARTIAL_CONTENT),
            None => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .body(Vec::new())
                    .unwrap()
            }
        },
    };
    let mut body = vec![0; if len == 0 { 0 } else { (end - start + 1) as usize }];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut body)).is_err() {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut res = Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, "audio/ogg")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len());
    if code == StatusCode::PARTIAL_CONTENT {
        res = res.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    res.body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup() -> (std::path::PathBuf, String) {
        let root = std::env::temp_dir().join(format!("tractus-media-{}", std::process::id()));
        let dir = root.join("meetings/2026-10-02_회의_01X");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("audio.ogg"), b"OggS0123456789").unwrap();
        fs::write(root.join("secret.ogg"), b"nope").unwrap();
        fs::write(dir.join("transcript.json"), b"{}").unwrap();
        let enc = percent_encoding::utf8_percent_encode(dir.join("audio.ogg").to_str().unwrap(), percent_encoding::NON_ALPHANUMERIC).to_string();
        (root, format!("/{enc}"))
    }

    #[test]
    fn serves_whole_file_and_ranges_as_audio_ogg() {
        let (root, uri) = setup();
        let m = root.join("meetings");
        let r = respond(&m, &uri, None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()[header::CONTENT_TYPE], "audio/ogg");
        assert_eq!(r.body(), b"OggS0123456789");

        let r = respond(&m, &uri, Some("bytes=4-7"));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body(), b"0123");
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 4-7/14");
        assert_eq!(respond(&m, &uri, Some("bytes=10-")).body(), b"6789");
        assert_eq!(respond(&m, &uri, Some("bytes=-2")).body(), b"89");
        assert_eq!(respond(&m, &uri, Some("bytes=0-999")).body().len(), 14);
        assert_eq!(respond(&m, &uri, Some("bytes=99-")).status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[test]
    fn refuses_files_outside_meetings_or_non_audio() {
        let (root, uri) = setup();
        let m = root.join("meetings");
        let enc = |p: &Path| format!("/{}", percent_encoding::utf8_percent_encode(p.to_str().unwrap(), percent_encoding::NON_ALPHANUMERIC));
        assert_eq!(respond(&m, &enc(&root.join("secret.ogg")), None).status(), StatusCode::FORBIDDEN);
        assert_eq!(respond(&m, &enc(&m.join("2026-10-02_회의_01X/../../secret.ogg")), None).status(), StatusCode::FORBIDDEN);
        assert_eq!(respond(&m, &enc(&m.join("2026-10-02_회의_01X/transcript.json")), None).status(), StatusCode::FORBIDDEN);
        assert_eq!(respond(&root.join("elsewhere"), &uri, None).status(), StatusCode::FORBIDDEN);
    }
}
