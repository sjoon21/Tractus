import Foundation
import DiarKit
import XCTest

final class DiarCommandTests: XCTestCase {
    func testParse() throws {
        XCTAssertEqual(try DiarCommand.parse(["download", "--models", "m"]), .download(models: "m"))
        XCTAssertEqual(try DiarCommand.parse(["run", "--audio", "a.wav", "--models", "m"]), .run(audio: "a.wav", models: "m", maxSpeakers: nil))
        XCTAssertEqual(try DiarCommand.parse(["run", "--models", "m", "--audio", "a.wav", "--max-speakers", "12"]), .run(audio: "a.wav", models: "m", maxSpeakers: 12))
    }

    func testParseErrors() {
        for args in [[], ["check"], ["run", "--models", "m"], ["run", "--audio", "a"], ["download"], ["download", "--models"],
                     ["download", "--models", "m", "--audio", "a"], ["run", "--audio", "a", "--models", "m", "--max-speakers", "0"],
                     ["run", "--audio", "a", "--models", "m", "--max-speakers", "x"], ["run", "--audio", "a", "--models", "m", "--bogus", "1"]] {
            XCTAssertThrowsError(try DiarCommand.parse(args), "\(args)")
        }
    }

    func testLabelTurnsByFirstAppearance() {
        let turns = labelTurns([(5.0, 7.004, "S3"), (0.0, 2.5, "S2"), (2.6, 4.9, "S3"), (8.0, 8.0, "S9"), (7.1, 9.0, "S2")])
        XCTAssertEqual(turns.map(\.0), [0.0, 2.6, 5.0, 7.1])
        XCTAssertEqual(turns.map(\.1), [2.5, 4.9, 7.0, 9.0])
        XCTAssertEqual(turns.map(\.2), ["S1", "S2", "S2", "S1"], "빈 turn은 버리고 처음 말한 순서대로 S1, S2")
    }

    func testResultShape() throws {
        let event = diarResult(turns: [(0.0, 1.5, "S1"), (1.6, 3.24, "S2")], model: "repo@rev", elapsed: 1.234)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: jsonData(event)) as? [String: Any])
        XCTAssertEqual(json["event"] as? String, "result")
        XCTAssertEqual(json["engine"] as? String, "fluid")
        XCTAssertEqual(json["model"] as? String, "repo@rev")
        XCTAssertEqual(json["speakers"] as? Int, 2)
        XCTAssertEqual(json["elapsed"] as? Double, 1.23)
        let turns = try XCTUnwrap(json["turns"] as? [[Any]])
        XCTAssertEqual(turns[1][1] as? Double, 3.24)
        XCTAssertEqual(turns[1][2] as? String, "S2")
    }
}

/// 빌드된 tractus-diar를 실행한다. 실제 모델이 필요한 테스트는 모델이 없으면 건너뛴다.
final class DiarBinaryTests: XCTestCase {
    var binary: URL { Bundle(for: Self.self).bundleURL.deletingLastPathComponent().appendingPathComponent("tractus-diar") }
    /// TRACTUS_DIAR_MODELS, 없으면 <저장소>/models/speaker-diarization
    var models: String {
        ProcessInfo.processInfo.environment["TRACTUS_DIAR_MODELS"]
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../models/speaker-diarization").standardizedFileURL.path
    }

    func run(_ args: [String]) throws -> (events: [[String: Any]], status: Int32) {
        let p = Process()
        p.executableURL = binary
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let events = String(decoding: data, as: UTF8.self).split(separator: "\n").map {
            (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] ?? ["invalid": String($0)]
        }
        return (events, p.terminationStatus)
    }

    func assertError(_ args: [String], file: StaticString = #filePath, line: UInt = #line) throws {
        let r = try run(args)
        XCTAssertEqual(r.status, 1, file: file, line: line)
        XCTAssertEqual(r.events.count, 1, "stdout은 error 이벤트 하나", file: file, line: line)
        XCTAssertEqual(r.events.last?["event"] as? String, "error", file: file, line: line)
        XCTAssertNotNil(r.events.last?["message"] as? String, file: file, line: line)
    }

    func testUsageError() throws { try assertError(["run", "--audio"]) }

    func testMissingAudio() throws { try assertError(["run", "--audio", "/nonexistent.wav", "--models", "/nonexistent"]) }

    func testMissingModelsDoesNotDownload() throws {
        let dir = try tempDir()
        let wav = dir.appendingPathComponent("a.wav")
        // 모델을 여는 데서 먼저 실패하므로 내용은 보지 않는다. 헤더만 있는 빈 WAV.
        try Data("RIFF".utf8 + [36, 0, 0, 0] + "WAVEfmt ".utf8 + [16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3E, 0, 0, 0, 0x7D, 0, 0, 2, 0, 16, 0] + "data".utf8 + [0, 0, 0, 0]).write(to: wav)
        let empty = dir.appendingPathComponent("models")
        try assertError(["run", "--audio", wav.path, "--models", empty.path])
        let fetched = (try? FileManager.default.contentsOfDirectory(atPath: empty.appendingPathComponent("speaker-diarization").path)) ?? []
        XCTAssertFalse(fetched.contains { $0.hasSuffix(".mlmodelc") }, "offline 모드에서는 받지 않는다")
    }

    /// `say` 한국어 음성 하나로 실제 모델을 돌린다(결과 이벤트 모양만 본다).
    func testRealModelOnSay() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: models + "/Segmentation.mlmodelc"), "모델 없음: tractus-diar download --models \(models)")
        let audio = try tempDir().appendingPathComponent("say.aiff")
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-v", "Yuna", "-o", audio.path, "오늘 회의에서는 다음 분기 예산과 채용 계획을 이야기합니다. 먼저 지난 분기 결과를 짧게 정리하겠습니다."]
        try say.run()
        say.waitUntilExit()
        try XCTSkipUnless(say.terminationStatus == 0, "say 실패")

        let r = try run(["run", "--audio", audio.path, "--models", models])
        XCTAssertEqual(r.status, 0)
        XCTAssertFalse(r.events.contains { $0["invalid"] != nil }, "stdout은 JSON Lines만")
        let result = try XCTUnwrap(r.events.last)
        XCTAssertEqual(result["event"] as? String, "result")
        XCTAssertEqual(result["engine"] as? String, "fluid")
        XCTAssertEqual(result["model"] as? String, "FluidInference/speaker-diarization-coreml@df2625ac79a7ac6b65ad868fee6d80f320da4232")
        let turns = try XCTUnwrap(result["turns"] as? [[Any]])
        XCTAssertFalse(turns.isEmpty)
        XCTAssertEqual(turns.first?[2] as? String, "S1")
        XCTAssertEqual(result["speakers"] as? Int, Set(turns.compactMap { $0[2] as? String }).count)
    }
}

func tempDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tractus-diar-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}
