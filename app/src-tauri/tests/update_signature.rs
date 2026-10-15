//! 릴리스 서명 검증: scripts/release.sh 가 만든 `Tractus.app.tar.gz` 와 `.sig` 를 tauri.conf.json 의 `plugins.updater.pubkey` 로 검사한다
//! (tauri-plugin-updater 의 `verify_signature` 와 같은 순서: 공개 키·서명은 base64 로 감싼 minisign 텍스트다).
//! 환경변수 `TRACTUS_UPDATE_ARTIFACT`(tar.gz 경로)·`TRACTUS_UPDATE_SIG`(.sig 경로)가 둘 다 있을 때만 검사하고, 없으면 조용히 통과한다.
//! 예: TRACTUS_UPDATE_ARTIFACT=dist/release/0.1.1/Tractus.app.tar.gz TRACTUS_UPDATE_SIG=dist/release/0.1.1/Tractus.app.tar.gz.sig cargo test --test update_signature
use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn unwrap_base64(s: &str) -> String {
    let bytes = base64::engine::general_purpose::STANDARD.decode(s.trim()).expect("base64 가 아니다");
    String::from_utf8(bytes).expect("utf-8 이 아니다")
}

#[test]
fn release_artifact_is_signed_with_the_pubkey_in_tauri_conf() {
    let (Ok(artifact), Ok(sig)) = (std::env::var("TRACTUS_UPDATE_ARTIFACT"), std::env::var("TRACTUS_UPDATE_SIG")) else {
        return; // 검사할 산출물이 없다 (보통의 cargo test)
    };
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let pubkey = conf["plugins"]["updater"]["pubkey"].as_str().expect("tauri.conf.json 에 plugins.updater.pubkey 가 없다");
    let version = conf["version"].as_str().expect("tauri.conf.json 에 version 이 없다");

    let public_key = PublicKey::decode(&unwrap_base64(pubkey)).expect("공개 키를 읽지 못했다");
    let signature = Signature::decode(&unwrap_base64(&std::fs::read_to_string(&sig).unwrap())).expect("서명 파일을 읽지 못했다");
    let data = std::fs::read(&artifact).unwrap();
    public_key.verify(&data, &signature, true).expect("서명이 공개 키와 맞지 않는다");

    // tauri signer sign --app-version 이 trusted comment 에 적는 버전. latest.json 의 version(= tauri.conf.json)과 다르면 플러그인이 설치를 거부한다
    let signed = signature.trusted_comment().split('\t').find_map(|f| f.strip_prefix("version:"));
    assert_eq!(signed, Some(version), "서명에 적힌 버전이 tauri.conf.json 과 다르다 (trusted comment: {})", signature.trusted_comment());
}
