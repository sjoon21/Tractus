// swift-tools-version:6.2
import PackageDescription

// tractus-diar — 9명 이상 화자 분리 헬퍼(선택). 녹음 프로그램(../Package.swift)과 별도 패키지다:
// FluidAudio의 `traits: []`가 Swift 6.2 이상을 요구해서, 이 패키지만 Xcode 26 이상이 필요하다.
let package = Package(
    name: "tractus-diar",
    platforms: [.macOS("14.4")],
    products: [
        .executable(name: "tractus-diar", targets: ["tractus-diar"]),
    ],
    dependencies: [
        // pyannote community-1 Core ML. Apache-2.0, 모델 가중치는 CC-BY-4.0(NOTICE).
        // traits: [] — 화자 분리에 필요 없는 NeMo 텍스트 정규화 바이너리(xcframework)를 링크하지 않는다(tools 6.2 이상).
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.5", traits: []),
    ],
    targets: [
        // 순수 로직(인수 해석, 화자 라벨 붙이기, 결과 이벤트). FluidAudio에 의존하지 않는다.
        .target(name: "DiarKit"),
        .executableTarget(name: "tractus-diar", dependencies: ["DiarKit", .product(name: "FluidAudio", package: "FluidAudio")]),
        // tractus-diar에 의존해 swift test가 실행 파일도 빌드하게 한다.
        .testTarget(name: "DiarTests", dependencies: ["DiarKit", "tractus-diar"]),
    ],
    swiftLanguageModes: [.v5]
)
