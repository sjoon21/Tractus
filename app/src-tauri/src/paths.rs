//! 코어(`tractus`)·녹음 프로그램(`tractus-rec`) 경로 해결과 데이터 폴더 점검 (docs/desktop.md §3.4, WORDS.md §4.19).
//! 설정의 경로가 비어 있으면 "자동"이다: 실행할 때마다 아래 순서로 찾고, 저장하지 않는다.
//! 순서: 직접 지정(파일이 있을 때) → 환경변수 → 앱 번들 안 → 빌드한 저장소 → 알려진 설치 위치.

use super::expand;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 찾은 경로와 그 출처: `custom`(직접 지정) | `env` | `bundle` | `repo` | `known` | `none`(어디서도 못 찾음: path는 안내용)
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Resolved {
    pub path: String,
    pub source: &'static str,
}

pub struct Bin {
    env: &'static str,
    /// `<앱>/Contents/Resources/` 아래
    bundle: &'static str,
    /// 저장소 루트 아래 (컴파일할 때 소스 위치로 계산)
    repo: &'static str,
    known: &'static [&'static str],
}

pub const TRACTUS: Bin = Bin { env: "TRACTUS_BIN", bundle: "runtime/bin/tractus", repo: ".venv/bin/tractus", known: &["~/.local/bin/tractus", "/opt/homebrew/bin/tractus"] };
pub const REC: Bin = Bin { env: "TRACTUS_REC_BIN", bundle: "bin/tractus-rec", repo: "recorder/.build/release/tractus-rec", known: &[] };

#[cfg(test)]
thread_local! {
    /// 시험 전용: 이 Mac에 실제로 있는 번들·저장소·설치 위치가 결과에 끼지 않게 자동 후보를 끈다
    pub static NO_AUTO: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(Path::parent).unwrap_or(Path::new("/")).to_path_buf()
}

fn lossy(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

impl Bin {
    /// 실행 파일(`<앱>/Contents/MacOS/…`) 기준 번들 안 후보: `<앱>/Contents/Resources/<bundle>`
    fn in_bundle(&self, exe: Option<&Path>) -> Option<PathBuf> {
        exe.and_then(|e| Some(e.parent()?.parent()?.join("Resources").join(self.bundle)))
    }

    /// 직접 지정·환경변수를 뺀 자동 후보 (우선순위 순)
    pub fn auto(&self, exe: Option<&Path>) -> Vec<(&'static str, PathBuf)> {
        #[cfg(test)]
        if NO_AUTO.get() {
            return vec![];
        }
        self.in_bundle(exe).map(|b| ("bundle", b)).into_iter().chain([("repo", repo_root().join(self.repo))]).chain(self.known.iter().map(|k| ("known", expand(k)))).collect()
    }

    pub fn resolve(&self, user: &str, env: Option<String>, exe: Option<&Path>) -> Resolved {
        let user = (!user.is_empty()).then(|| expand(user));
        let env = env.filter(|e| !e.is_empty()).map(|e| expand(&e));
        let hit = user.iter().map(|p| ("custom", p.clone())).chain(env.map(|p| ("env", p))).chain(self.auto(exe)).find(|(_, p)| p.is_file());
        match hit {
            Some((source, p)) => Resolved { path: lossy(p), source },
            None => Resolved { path: lossy(user.unwrap_or_else(|| repo_root().join(self.repo))), source: "none" },
        }
    }

    /// 지금 앱이 쓸 경로. `user`는 설정에 저장된 값(비어 있으면 자동)
    pub fn find(&self, user: &str) -> Resolved {
        self.resolve(user, std::env::var(self.env).ok(), std::env::current_exe().ok().as_deref())
    }

    /// 저장된 값이 자동이 알아서 찾을 값(기본값)과 같은가: 같으면 저장할 필요가 없다
    pub fn is_default(&self, saved: &str) -> bool {
        let v = expand(saved);
        self.auto(std::env::current_exe().ok().as_deref()).iter().any(|(_, p)| *p == v)
    }
}

/// 미리 만든 앱(번들)인가: 실행 파일 옆 `../Resources/runtime/bin/tractus` 가 있을 때만. 저장소에서 install.sh 로 만든 앱·개발 실행은 아니다
pub fn is_bundled(exe: Option<&Path>) -> bool {
    TRACTUS.in_bundle(exe).is_some_and(|p| p.is_file())
}

/// 업데이트 확인을 할 수 있는가(= 번들인가). 저장소에서 만든 앱은 scripts/update.sh 로 업데이트하므로 화면이 확인을 건너뛴다 (docs/desktop.md)
#[tauri::command]
pub fn update_available() -> bool {
    is_bundled(std::env::current_exe().ok().as_deref())
}

/// 데이터 폴더가 동기화 폴더이거나 Obsidian 볼트 안이면 그 이름. 폴더와 그 위 폴더를 모두 본다
/// ponytail: 폴더 이름으로만 안다. iCloud의 `데스크탑 및 문서 폴더` 동기화처럼 이름에 드러나지 않는 것은 못 잡는다
pub fn sync_risk(home: &Path) -> Option<&'static str> {
    home.ancestors().find_map(|a| {
        let name = a.file_name()?.to_str()?;
        if a.ends_with("Library/Mobile Documents") {
            Some("iCloud Drive")
        } else if name.starts_with("Dropbox") {
            Some("Dropbox")
        } else if name.starts_with("OneDrive") {
            Some("OneDrive")
        } else if name.starts_with("GoogleDrive") || name == "Google Drive" {
            Some("Google Drive")
        } else if a.join(".obsidian").is_dir() {
            Some("Obsidian")
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tractus-paths-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(p: &Path) -> String {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "").unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn user_then_env_then_bundle_in_that_order() {
        let d = tmp("order");
        let exe = d.join("Tractus.app/Contents/MacOS/tractus-app");
        let bundled = touch(&d.join("Tractus.app/Contents/Resources/runtime/bin/tractus"));
        let (mine, from_env) = (touch(&d.join("mine")), touch(&d.join("env")));
        let r = |user: &str, env: Option<&str>| TRACTUS.resolve(user, env.map(String::from), Some(&exe));
        assert_eq!(r(&mine, Some(&from_env)), Resolved { path: mine.clone(), source: "custom" });
        assert_eq!(r("", Some(&from_env)), Resolved { path: from_env.clone(), source: "env" });
        // 직접 지정한 파일이 없으면 자동으로 넘어간다 (환경변수 → 번들)
        assert_eq!(r("/nonexistent/x", Some(&from_env)).source, "env");
        assert_eq!(r("/nonexistent/x", Some("/nonexistent/y")), Resolved { path: bundled, source: "bundle" });
        assert_eq!(r("", Some("")).source, "bundle"); // 빈 환경변수는 없는 것과 같다
    }

    #[test]
    fn bundle_path_is_relative_to_the_running_exe_and_recorder_has_its_own_folder() {
        let d = tmp("bundle");
        let exe = d.join("A.app/Contents/MacOS/app");
        let core = touch(&d.join("A.app/Contents/Resources/runtime/bin/tractus"));
        let rec = touch(&d.join("A.app/Contents/Resources/bin/tractus-rec"));
        assert_eq!(TRACTUS.resolve("", None, Some(&exe)), Resolved { path: core, source: "bundle" });
        assert_eq!(REC.resolve("", None, Some(&exe)), Resolved { path: rec, source: "bundle" });
        // 번들에 없으면 다음 후보(저장소 → 설치 위치)로. 이 Mac의 후보를 끄고 아무것도 없을 때를 본다
        NO_AUTO.set(true);
        let none = TRACTUS.resolve("", None, Some(&exe));
        assert_eq!(none.source, "none");
        assert!(none.path.ends_with(".venv/bin/tractus"), "{}", none.path); // 안내용: 빌드할 곳
        NO_AUTO.set(false);
    }

    #[test]
    fn is_bundled_only_when_the_core_sits_next_to_the_exe_in_resources() {
        let d = tmp("bundled");
        let exe = d.join("Tractus.app/Contents/MacOS/tractus-app");
        assert!(!is_bundled(Some(&exe)), "runtime/ 이 없으면 저장소 빌드다");
        touch(&d.join("Tractus.app/Contents/Resources/runtime/bin/tractus"));
        assert!(is_bundled(Some(&exe)));
        assert!(!is_bundled(None));
    }

    #[test]
    fn defaults_are_recognised_so_save_never_pins_them() {
        let repo_default = repo_root().join(".venv/bin/tractus").to_string_lossy().into_owned();
        assert!(TRACTUS.is_default(&repo_default));
        assert!(TRACTUS.is_default("~/.local/bin/tractus"));
        assert!(!TRACTUS.is_default("/somewhere/else/tractus"));
        assert!(REC.is_default(&repo_root().join("recorder/.build/release/tractus-rec").to_string_lossy()));
    }

    #[test]
    fn sync_risk_sees_sync_folders_and_obsidian_vaults() {
        let d = tmp("risk");
        let mk = |rel: &str| {
            let p = d.join(rel);
            fs::create_dir_all(&p).unwrap();
            p
        };
        assert_eq!(sync_risk(&mk("plain/Tractus")), None);
        assert_eq!(sync_risk(&mk("Library/Mobile Documents/com~apple~CloudDocs/Tractus")), Some("iCloud Drive"));
        assert_eq!(sync_risk(&mk("Library/CloudStorage/Dropbox/Tractus")), Some("Dropbox"));
        assert_eq!(sync_risk(&mk("Library/CloudStorage/OneDrive-Personal/x/Tractus")), Some("OneDrive"));
        assert_eq!(sync_risk(&mk("Library/CloudStorage/GoogleDrive-a@b.c/My Drive/Tractus")), Some("Google Drive"));
        let vault = mk("vault/notes/Tractus");
        assert_eq!(sync_risk(&vault), None);
        fs::create_dir_all(d.join("vault/.obsidian")).unwrap(); // 위 폴더에 .obsidian이 있으면 볼트 안이다
        assert_eq!(sync_risk(&vault), Some("Obsidian"));
        assert_eq!(sync_risk(&d.join("vault/not-created-yet")), Some("Obsidian")); // 아직 없는 폴더도 위 폴더로 본다
    }
}
