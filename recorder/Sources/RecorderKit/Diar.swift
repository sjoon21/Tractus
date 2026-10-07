import Foundation

/// `tractus-diar`의 인수. `download --models <dir>` 또는 `run --audio <wav> --models <dir> [--max-speakers N]`.
public enum DiarCommand: Equatable {
    case download(models: String)
    case run(audio: String, models: String, maxSpeakers: Int?)

    public static func parse(_ args: [String]) throws -> DiarCommand {
        guard let sub = args.first, sub == "download" || sub == "run" else {
            throw UsageError(description: "download 또는 run이 필요합니다")
        }
        var values: [String: String] = [:]
        var i = 1
        while i < args.count {
            let key = args[i]
            guard ["--models", "--audio", "--max-speakers"].contains(key), !(sub == "download" && key != "--models") else {
                throw UsageError(description: "알 수 없는 인수: \(key)")
            }
            i += 1
            guard i < args.count else { throw UsageError(description: "\(key)에 값이 필요합니다") }
            values[key] = args[i]
            i += 1
        }
        guard let models = values["--models"] else { throw UsageError(description: "--models가 필요합니다") }
        if sub == "download" { return .download(models: models) }
        guard let audio = values["--audio"] else { throw UsageError(description: "--audio가 필요합니다") }
        var maxSpeakers: Int?
        if let raw = values["--max-speakers"] {
            guard let n = Int(raw), n >= 1 else { throw UsageError(description: "--max-speakers는 1 이상의 정수입니다: \(raw)") }
            maxSpeakers = n
        }
        return .run(audio: audio, models: models, maxSpeakers: maxSpeakers)
    }
}

/// 엔진이 준 (시작, 끝, 화자 ID)를 시작 순으로 정렬하고, 처음 말한 순서대로 S1, S2, …로 다시 붙인다. 시각은 소수 둘째 자리.
public func labelTurns(_ segments: [(start: Double, end: Double, speaker: String)]) -> [(Double, Double, String)] {
    let sorted = segments.filter { $0.end > $0.start }.sorted { ($0.start, $0.end) < ($1.start, $1.end) }
    var names: [String: String] = [:]
    return sorted.map { s in
        let name = names[s.speaker] ?? "S\(names.count + 1)"
        names[s.speaker] = name
        return (round2(s.start), round2(s.end), name)
    }
}

/// 마지막 `result` 이벤트.
public func diarResult(turns: [(Double, Double, String)], model: String, elapsed: Double) -> [String: Any] {
    [
        "event": "result",
        "turns": turns.map { [$0.0, $0.1, $0.2] as [Any] },
        "speakers": Set(turns.map(\.2)).count,
        "engine": "fluid",
        "model": model,
        "elapsed": round2(elapsed),
    ]
}
