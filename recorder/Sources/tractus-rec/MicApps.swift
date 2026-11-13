import AppKit
import CoreAudio
import RecorderKit

// `tractus-rec mic-apps`: 지금 마이크를 쓰는 프로세스와, 그중 통화 앱의 도우미 프로세스를 거르기 위한 실행 중인 앱 목록 (통화 감지, 앱 calls.rs).
// Core Audio 프로세스 객체 목록(macOS 14+)의 IsRunningInput을 읽는다. 마이크 권한·소리는 필요 없다.
// 참고: Yogurt(FrigadeHQ/yogurt, MIT) native/yogurt-mac/main.swift의 audioApps. 출력 모양은 Tractus 것이다.

private func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

private func processObjects() -> [AudioObjectID] {
    var a = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    let sys = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(sys, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(sys, &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

private func uint(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32 {
    var a = address(sel), v: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
    _ = AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v)
    return v
}

private func bundleID(_ obj: AudioObjectID) -> String {
    var a = address(kAudioProcessPropertyBundleID), size = UInt32(MemoryLayout<CFString?>.size)
    var s: Unmanaged<CFString>?
    guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &s) == noErr, let v = s else { return "" }
    return v.takeRetainedValue() as String
}

/// {"mic": [{"bundle_id", "pid"}], "running": [보이는 앱의 bundle id], "now": 로컬 ISO 시각(일정과 같은 꼴)} 한 줄
func runMicApps() -> Never {
    let me = ProcessInfo.processInfo.processIdentifier
    let mic: [[String: Any]] = processObjects().compactMap { obj in
        guard uint(obj, kAudioProcessPropertyIsRunningInput) != 0 else { return nil }
        let pid = Int32(bitPattern: uint(obj, kAudioProcessPropertyPID))
        guard pid != me else { return nil }
        return ["bundle_id": bundleID(obj), "pid": Int(pid)]
    }
    let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap(\.bundleIdentifier)
    emit(["mic": mic, "running": Array(Set(running)).sorted(), "now": isoLocal(Date())])
    exit(0)
}
