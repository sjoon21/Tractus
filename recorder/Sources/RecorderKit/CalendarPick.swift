import Foundation

// `tractus-rec calendar next`의 고르기 규칙 (EventKit 없이 시험할 수 있게 여기 둔다). 계약: docs/design/calendar.md

public struct CalendarEvent: Equatable {
    public let id: String
    public let title: String
    public let start: Date
    public let end: Date
    public let allDay: Bool
    public let calendar: String
    public let attendees: [String]

    public init(id: String, title: String, start: Date, end: Date, allDay: Bool, calendar: String, attendees: [String]) {
        (self.id, self.title, self.start, self.end, self.allDay, self.calendar, self.attendees) = (id, title, start, end, allDay, calendar, attendees)
    }
}

/// 끝나지 않았고 ahead초 안에 시작하는 일정 (종일 제외), 시작 순
public func upcoming(_ events: [CalendarEvent], now: Date, ahead: TimeInterval) -> [CalendarEvent] {
    events.filter { !$0.allDay && $0.end > now && $0.start <= now.addingTimeInterval(ahead) }
        .sorted { ($0.start, $0.title) < ($1.start, $1.title) }
}

/// 참석자 이름: 공백 정리, 빈 이름·중복 제거. 이름이 없는 초대 대상은 EventKit이 이메일을 name에 넣으므로 `@`가 든 이름은 뺀다 (이메일은 내보내지 않는다)
public func attendeeNames(_ raw: [String?]) -> [String] {
    var seen = Set<String>()
    return raw.compactMap { $0?.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        .filter { !$0.isEmpty && !$0.contains("@") && seen.insert($0).inserted }
}

/// 카드 제목: 공백 정리, 200자까지. 비면 nil (그 일정은 보이지 않는다: 녹음 제목이 될 수 없다)
public func eventTitle(_ raw: String?) -> String? {
    let t = (raw ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return t.isEmpty ? nil : String(t.prefix(200))
}

public struct NextOptions: Equatable {
    public var ahead: Int = 15  // 분
    public var exclude: [String] = []

    /// `--ahead N`(1~1440분), `--exclude ID`(여러 번)
    public static func parse(_ args: [String]) throws -> NextOptions {
        var o = NextOptions()
        var it = args.makeIterator()
        while let a = it.next() {
            switch a {
            case "--ahead":
                guard let v = it.next(), let n = Int(v), (1...1440).contains(n) else { throw UsageError(description: "--ahead는 1~1440분입니다") }
                o.ahead = n
            case "--exclude":
                guard let v = it.next(), !v.isEmpty else { throw UsageError(description: "--exclude에 캘린더 ID가 필요합니다") }
                o.exclude.append(v)
            default: throw UsageError(description: "알 수 없는 옵션: \(a)")
            }
        }
        return o
    }
}
