import EventKit
import Foundation
import RecorderKit

// tractus-rec calendar access|request|list|next — macOS 캘린더 읽기 (docs/design/calendar.md).
// 출력은 한 줄 JSON. 권한이 없으면 목록은 비고 오류가 아니다. 참석자 이메일은 내보내지 않는다.

func accessName(_ s: EKAuthorizationStatus) -> String {
    switch s {
    case .fullAccess: return "granted"
    case .writeOnly: return "write_only"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "undetermined"
    @unknown default: return "denied"
    }
}

func currentAccess() -> String { accessName(EKEventStore.authorizationStatus(for: .event)) }

/// 권한 창을 띄운다 (앱의 하위 프로세스라 앱 이름으로 뜬다). 이미 정해졌으면 창 없이 그 값
func requestAccess(_ store: EKEventStore) -> String {
    let done = DispatchSemaphore(value: 0)
    store.requestFullAccessToEvents { _, error in
        if let error { log("캘린더 권한 요청: \(error)") }
        done.signal()
    }
    done.wait()
    return currentAccess()
}

/// 카드에 올릴 일정. 제목이 없거나, 취소됐거나, 내가 거절한 일정은 nil
func calendarEvent(_ e: EKEvent) -> CalendarEvent? {
    guard let title = eventTitle(e.title), e.status != .canceled,
          !(e.attendees ?? []).contains(where: { $0.isCurrentUser && $0.participantStatus == .declined }) else { return nil }
    let people = (e.attendees ?? []).filter { $0.participantType == .person }.map(\.name)
    return CalendarEvent(id: e.calendarItemIdentifier, title: title, start: e.startDate, end: e.endDate, allDay: e.isAllDay,
                         calendar: e.calendar?.title ?? "", attendees: attendeeNames(people))
}

func runCalendar(_ args: [String]) -> Never {
    let store = EKEventStore()
    let sub = args.first ?? ""
    let granted = { currentAccess() == "granted" }
    switch sub {
    case "access":
        emit(["access": currentAccess()])
    case "request":
        emit(["access": requestAccess(store)])
    case "list":
        let cals = granted() ? store.calendars(for: .event).sorted { ($0.source.title, $0.title) < ($1.source.title, $1.title) } : []
        emit(["access": currentAccess(), "calendars": cals.map { ["id": $0.calendarIdentifier, "title": $0.title, "source": $0.source.title] }])
    case "next":
        let options: NextOptions
        do { options = try NextOptions.parse(Array(args.dropFirst())) } catch { fatal("\(error)") }
        var events: [CalendarEvent] = []
        if granted() {
            let cals = store.calendars(for: .event).filter { !options.exclude.contains($0.calendarIdentifier) }
            let now = Date()
            let ahead = TimeInterval(options.ahead * 60)
            if !cals.isEmpty {  // 빈 목록을 넘기면 EventKit은 모든 캘린더를 본다
                // 진행 중인 일정도 잡도록 하루 앞부터 찾는다 (끝이 지난 것은 upcoming이 거른다)
                let found = store.events(matching: store.predicateForEvents(withStart: now.addingTimeInterval(-86400), end: now.addingTimeInterval(ahead), calendars: cals))
                events = upcoming(found.compactMap(calendarEvent), now: now, ahead: ahead)
            }
        }
        emit(["access": currentAccess(), "events": events.map {
            ["id": $0.id, "title": $0.title, "start": isoLocal($0.start), "end": isoLocal($0.end), "calendar": $0.calendar, "attendees": $0.attendees] as [String: Any]
        }])
    default:
        fputs("사용법: tractus-rec calendar access|request|list|next [--ahead 분] [--exclude 캘린더ID]…\n", stderr)
        exit(1)
    }
    exit(0)
}
