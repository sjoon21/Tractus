// swift-tools-version:5.10
import Foundation
import PackageDescription

// Info.plist를 실행 파일의 __TEXT,__info_plist 섹션에 넣는다(마이크·시스템 오디오 권한 문구).
// 링커는 작업 디렉터리가 정해져 있지 않으므로 절대 경로를 쓴다.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

// 화자 분리 헬퍼 tractus-diar는 diar/ 에 별도 패키지로 있다(FluidAudio가 Swift 6.2 이상을 요구하므로 나눴다).
let package = Package(
    name: "tractus-rec",
    platforms: [.macOS("14.4")],
    products: [
        .executable(name: "tractus-rec", targets: ["tractus-rec"]),
    ],
    targets: [
        .target(name: "RecorderKit"),
        // Swift do/catch가 못 잡는 Objective-C 예외(AVAudioNode.installTap 등)를 NSError로 바꾸는 작은 C 계열 타깃
        .target(name: "ObjCCatch"),
        .executableTarget(
            name: "tractus-rec",
            dependencies: ["RecorderKit", "ObjCCatch"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
            ]
        ),
        // tractus-rec에 의존해 swift test가 실행 파일도 빌드하게 한다(fake 모드 E2E 테스트용).
        .testTarget(name: "RecorderKitTests", dependencies: ["RecorderKit", "ObjCCatch", "tractus-rec"]),
    ],
    swiftLanguageVersions: [.v5]
)
