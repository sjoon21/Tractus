// swift-tools-version:5.10
import Foundation
import PackageDescription

// Info.plist를 실행 파일의 __TEXT,__info_plist 섹션에 넣는다(마이크·시스템 오디오 권한 문구).
// 링커는 작업 디렉터리가 정해져 있지 않으므로 절대 경로를 쓴다.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "tractus-rec",
    platforms: [.macOS("14.4")],
    products: [.executable(name: "tractus-rec", targets: ["tractus-rec"])],
    targets: [
        .target(name: "RecorderKit"),
        .executableTarget(
            name: "tractus-rec",
            dependencies: ["RecorderKit"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
            ]
        ),
        // tractus-rec에 의존해 swift test가 실행 파일도 빌드하게 한다(fake 모드 E2E 테스트용).
        .testTarget(name: "RecorderKitTests", dependencies: ["RecorderKit", "tractus-rec"]),
    ]
)
