import Foundation

/// stdin 한 줄 = 명령 하나.
public enum Command: Equatable {
    case bookmark
    case memo(String)
    case pause
    case resume
    case stop

    public static func parse(_ line: String) -> Command? {
        let s = line.trimmingCharacters(in: .whitespacesAndNewlines)
        switch s {
        case "bookmark": return .bookmark
        case "stop": return .stop
        case "pause": return .pause
        case "resume": return .resume
        default:
            guard s.hasPrefix("memo ") else { return nil }
            let text = s.dropFirst(5).trimmingCharacters(in: .whitespaces)
            return text.isEmpty ? nil : .memo(text)
        }
    }
}

public struct UsageError: Error, CustomStringConvertible {
    public let description: String
}

/// `tractus-rec record`의 인수.
public struct RecordOptions: Equatable {
    public var out: String
    public var mic = true
    public var system = true
    public var fake = false
    /// 화상·하이브리드 회의용. 마이크에 macOS 음성 처리(에코 제거)를 켠다. 대면 회의 기본값은 끈다.
    public var echoCancel = false

    public init(out: String) { self.out = out }

    public static func parse(_ args: [String]) throws -> RecordOptions {
        var out: String?
        var o = RecordOptions(out: "")
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--out":
                i += 1
                guard i < args.count else { throw UsageError(description: "--out에 디렉터리가 필요합니다") }
                out = args[i]
            case "--no-mic": o.mic = false
            case "--no-system": o.system = false
            case "--fake": o.fake = true
            case "--echo-cancel": o.echoCancel = true
            default: throw UsageError(description: "알 수 없는 인수: \(args[i])")
            }
            i += 1
        }
        guard let out else { throw UsageError(description: "--out이 필요합니다") }
        o.out = out
        return o
    }
}

public struct Mark: Equatable {
    public let t: Double
    public let kind: String  // "bookmark" | "memo"
    public let text: String?

    public init(t: Double, kind: String, text: String?) { self.t = t; self.kind = kind; self.text = text }

    public var json: [String: Any] { ["t": t, "kind": kind, "text": text ?? NSNull()] }
}

/// 일시정지 한 번. `at`은 오디오 시각(일시정지 시간을 뺀 녹음 시계)이다.
public struct Pause: Equatable {
    public let at: Double
    public let wallStart: String
    public let wallEnd: String

    public init(at: Double, wallStart: String, wallEnd: String) { self.at = at; self.wallStart = wallStart; self.wallEnd = wallEnd }

    public var json: [String: Any] { ["at": at, "wall_start": wallStart, "wall_end": wallEnd] }
}

/// recording.json (docs/desktop.md §1). null 필드를 빠뜨리지 않으려고 Codable 대신 JSONSerialization을 쓴다.
public struct RecordingInfo {
    public var startedAt: String
    public var duration: Double?
    public var tracks: [String: String]
    public var marks: [Mark] = []
    /// 끝난 일시정지만 들어간다(진행 중인 것은 계속/종료 때 추가).
    public var pauses: [Pause] = []
    public var echoCancel: Bool

    public init(startedAt: String, tracks: [String: String], echoCancel: Bool = false) {
        self.startedAt = startedAt; self.tracks = tracks; self.echoCancel = echoCancel
    }

    public var json: [String: Any] {
        [
            "schema_version": 1,
            "started_at": startedAt,
            "duration": duration ?? NSNull(),
            "tracks": tracks,
            "marks": marks.map(\.json),
            "pauses": pauses.map(\.json),  // 추가 키(2026-10-14). 읽는 쪽은 모르는 키를 무시하므로 schema_version은 1 그대로
            "echo_cancel": echoCancel,  // 계약 밖 키. 읽는 쪽은 모르는 키를 무시하므로 schema_version은 1 그대로
        ]
    }

    /// 임시 파일에 쓰고 rename한다(원자적).
    public func write(to url: URL) throws {
        try jsonData(json, pretty: true).write(to: url, options: .atomic)
    }
}

/// JSONSerialization은 0.24를 0.23999999999999999로 쓴다. Double을 최단 10진 표기(NSDecimalNumber)로 바꿔 직렬화한다.
public func jsonData(_ object: [String: Any], pretty: Bool = false) throws -> Data {
    func clean(_ v: Any) -> Any {
        switch v {
        case let d as Double: return NSDecimalNumber(string: String(d))
        case let a as [Any]: return a.map(clean)
        case let o as [String: Any]: return o.mapValues(clean)
        default: return v
        }
    }
    let options: JSONSerialization.WritingOptions = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.withoutEscapingSlashes]
    return try JSONSerialization.data(withJSONObject: clean(object), options: options)
}

/// 소수 둘째 자리 반올림(이벤트·JSON의 시각 표기).
public func round2(_ x: Double) -> Double { (x * 100).rounded() / 100 }

/// "2026-10-02T14:00:00+09:00" (로컬 시간대 오프셋 포함)
public func isoLocal(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = .current
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: date)
}
