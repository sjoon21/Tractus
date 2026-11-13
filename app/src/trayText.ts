// 메뉴 막대 아이콘의 설정 문구 (WORDS.md §4.16). 메뉴 자체의 글자는 Rust(tray.rs)에 있다.

import { t } from "./i18n";

export const TRAY_SHOW_LABEL = t("메뉴 막대에 Tractus 표시");
export const TRAY_SHOW_HINT = t("창을 열지 않고 메뉴 막대에서 녹음하고 노트를 엽니다.");
export const TRAY_KEEP_LABEL = t("창을 닫아도 메뉴 막대에 남기기");
export const TRAY_KEEP_HINT = t("창을 닫아도 녹음과 변환이 이어집니다. 끝내려면 ⌘Q를 누르세요.");
export const MINI_LABEL = t("녹음 중 작은 창 띄우기");
export const MINI_HINT = t("Tractus 창을 보고 있지 않을 때 화면 구석에 녹음 시각과 종료 단추를 띄웁니다. 끌어서 옮길 수 있습니다.");
export const CALL_DETECT_LABEL = t("통화가 시작되면 녹음할지 묻기");
export const CALL_DETECT_HINT = t("Zoom·Teams·FaceTime 같은 통화 앱이 마이크를 쓰기 시작하면 화면 구석에서 묻습니다. 소리는 듣지 않고 어떤 앱이 마이크를 쓰는지만 봅니다. 브라우저 통화는 캘린더에 지금 일정이 있을 때만 묻습니다.");
export const CALL_STOP_LABEL = t("통화가 끝나면 녹음 끝내기");
export const CALL_STOP_HINT = t("통화 앱이 10초 동안 마이크를 쓰지 않으면 녹음을 끝냅니다. 끄면 끝낼지 묻습니다.");
