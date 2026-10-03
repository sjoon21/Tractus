import AVFoundation
import CoreAudio
import Foundation
import RecorderKit

typealias SampleSink = ([Int16]) -> Void

/// 실제 장치 소스. 장치가 바뀌거나 끊기면 Recorder가 stop() → start()로 다시 연다.
protocol AudioSource: AnyObject {
    func start(_ sink: @escaping SampleSink) throws
    func stop()
}

/// 아무 포맷 → 48 kHz mono Int16. 상태를 유지하므로 소스마다 하나씩 쓴다.
final class MonoConverter {
    static let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(WavWriter.sampleRate), channels: 1, interleaved: true)!
    private let converter: AVAudioConverter

    /// `firstChannelOnly`: 음성 처리를 켠 입력은 여러 채널로 나올 수 있는데, 처리된 소리는 첫 채널에 있다.
    init?(from format: AVAudioFormat, firstChannelOnly: Bool = false) {
        guard let c = AVAudioConverter(from: format, to: Self.outFormat) else { return nil }
        c.downmix = true
        // ponytail: 음성 처리 출력의 나머지 채널은 섞지 않고 버린다. 실기기에서 레벨이 이상하면 다시 본다.
        if firstChannelOnly, format.channelCount > 1 { c.channelMap = [0] }
        converter = c
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> [Int16] {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Self.outFormat.sampleRate / buffer.format.sampleRate) + 64
        guard buffer.frameLength > 0, let out = AVAudioPCMBuffer(pcmFormat: Self.outFormat, frameCapacity: capacity) else { return [] }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed { inputStatus.pointee = .noDataNow; return nil }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, let p = out.int16ChannelData else {
            log("변환 실패: \(error?.localizedDescription ?? "알 수 없음")")
            return []
        }
        return Array(UnsafeBufferPointer(start: p[0], count: Int(out.frameLength)))
    }
}

/// 마이크: AVAudioEngine 입력 노드에 tap을 건다.
/// 입력 장치가 바뀌면(AirPods 연결 등) 엔진이 스스로 멈추므로 `onChange`로 알려 다시 열게 한다.
/// `echoCancel`이면 macOS 음성 처리(에코 제거 + AGC·잡음 억제)를 켠다. 스피커로 나간 상대방 목소리가 마이크 트랙에 다시 들어가지 않게 한다.
final class MicSource: AudioSource {
    private let engine = AVAudioEngine()
    /// 실제로 켜졌는지. 켜지 못하면 경고 후 false로 녹음한다.
    private(set) var echoCancel: Bool

    init(echoCancel: Bool, onChange: @escaping () -> Void) {
        self.echoCancel = echoCancel
        // 음성 처리를 켜면 입력 구성이 바뀌므로 관찰자를 걸기 전에 켠다.
        if echoCancel {
            do {
                try enableVoiceProcessing()
            } catch {
                self.echoCancel = false
                warning("echo_cancel_failed", "에코 제거를 켜지 못해 에코 제거 없이 녹음합니다: \(error)")
            }
        }
        // ponytail: 관찰자는 프로세스가 끝날 때까지 둔다(녹음 1회 = 프로세스 1개).
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in onChange() }
    }

    /// 엔진이 멈춘 상태에서만 부른다. 덕킹 설정 변경도 구성 변경 알림을 부를 수 있으므로 켤 때만 넣는다.
    private func enableVoiceProcessing() throws {
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        // 다른 앱 소리(화상회의 상대 목소리)를 줄이지 않게 덕킹을 최소로 둔다.
        input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
    }

    /// 음성 처리로 열지 못하면(켜기·포맷·엔진 시작 중 어디서든) 경고 후 끄고 음성 처리 없이 다시 연다.
    /// 한 번 꺼지면 이후 재연결도 음성 처리 없이 한다(마이크 트랙을 잃지 않는 게 먼저다).
    func start(_ sink: @escaping SampleSink) throws {
        if echoCancel {
            do {
                // 장치가 바뀌어 다시 열 때 음성 처리가 풀렸으면 다시 켠다. 켜져 있으면 건드리지 않는다.
                if !engine.inputNode.isVoiceProcessingEnabled { try enableVoiceProcessing() }
                try open(sink)
                return
            } catch {
                stop()
                try? engine.inputNode.setVoiceProcessingEnabled(false)
                echoCancel = false
                warning("echo_cancel_failed", "에코 제거를 켜지 못해 에코 제거 없이 녹음합니다: \(error)")
            }
        }
        try open(sink)
    }

    private func open(_ sink: @escaping SampleSink) throws {
        let input = engine.inputNode
        // 음성 처리는 입력 포맷(채널 수 등)을 바꾸므로 켠 뒤에 포맷을 읽는다.
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, let converter = MonoConverter(from: format, firstChannelOnly: input.isVoiceProcessingEnabled) else {
            throw WavError.io("입력 장치가 없거나 포맷을 변환할 수 없습니다 (\(format))")
        }
        input.installTap(onBus: 0, bufferSize: 4800, format: format) { buffer, _ in sink(converter.convert(buffer)) }
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

/// 시스템 오디오: Core Audio process tap(macOS 14.2+) → private aggregate device → IOProc.
/// 절차는 AudioCap(BSD-2, github.com/insidegui/AudioCap)의 ProcessTap.swift를 참고했다.
/// aggregate는 시작 시점의 기본 출력 장치에 묶이므로, 기본 출력이 바뀌면 `onChange`로 알려 새 장치로 다시 열게 한다.
final class SystemTap: AudioSource {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "tractus.rec.tap")

    init(onChange: (() -> Void)? = nil) {
        guard let onChange else { return }
        // ponytail: 리스너는 프로세스가 끝날 때까지 둔다.
        var address = propertyAddress(kAudioHardwarePropertyDefaultSystemOutputDevice)
        let status = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue) { _, _ in onChange() }
        if status != noErr { log("기본 출력 장치 리스너 등록 실패 (OSStatus \(status))") }
    }

    func start(_ sink: @escaping SampleSink) throws {
        do {
            // 우리 프로세스만 빼고 모든 프로세스의 출력을 mono로 섞어 받는다.
            let description = CATapDescription(monoGlobalTapButExcludeProcesses: ownProcessObject().map { [$0] } ?? [])
            description.uuid = UUID()
            description.isPrivate = true
            description.muteBehavior = .unmuted
            try check(AudioHardwareCreateProcessTap(description, &tapID), "AudioHardwareCreateProcessTap")

            var asbd = AudioStreamBasicDescription()
            try getProperty(tapID, kAudioTapPropertyFormat, &asbd)
            guard let format = AVAudioFormat(streamDescription: &asbd), let converter = MonoConverter(from: format) else {
                throw WavError.io("tap 포맷을 변환할 수 없습니다")
            }

            var outputDevice = AudioObjectID(kAudioObjectUnknown)
            try getProperty(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, &outputDevice)
            var uid: Unmanaged<CFString>?
            try getProperty(outputDevice, kAudioDevicePropertyDeviceUID, &uid)
            guard let outputUID = uid?.takeRetainedValue() as String? else { throw WavError.io("출력 장치 UID를 읽지 못했습니다") }

            let aggregate: [String: Any] = [
                kAudioAggregateDeviceNameKey: "Tractus-Tap",
                kAudioAggregateDeviceUIDKey: UUID().uuidString,
                kAudioAggregateDeviceMainSubDeviceKey: outputUID,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceIsStackedKey: false,
                kAudioAggregateDeviceTapAutoStartKey: true,
                kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
                kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
            ]
            try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "AudioHardwareCreateAggregateDevice")

            try check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
                sink(converter.convert(buffer))  // input은 콜백 안에서만 유효하므로 바로 변환한다
            }, "AudioDeviceCreateIOProcIDWithBlock")
            try check(AudioDeviceStart(aggregateID, procID), "AudioDeviceStart")
        } catch {
            stop()
            throw error
        }
    }

    /// 만든 역순으로 정리한다. 여러 번 불러도 된다.
    func stop() {
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    private func ownProcessObject() -> AudioObjectID? {
        var pid = getpid()
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = propertyAddress(kAudioHardwarePropertyTranslatePIDToProcessObject)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object)
        return status == noErr && object != kAudioObjectUnknown ? object : nil
    }
}

/// --fake: 권한 없이 앱·CI를 돌리기 위한 합성 신호. 마이크 440 Hz, 시스템 660 Hz.
/// 시스템 트랙은 2초 주기마다 [1.0, 1.5)초 구간이 정확히 0이다(레벨 이벤트의 무음 확인용).
final class FakeSource {
    static let amplitude = 0.3
    let frequency: Double
    let gaps: Bool
    private var index = 0

    init(frequency: Double, gaps: Bool) { self.frequency = frequency; self.gaps = gaps }

    /// 시작 후 `elapsed`초까지의 표본을 만든다(벽시계 기준이라 타이머가 밀려도 길이가 맞는다).
    func generate(upTo elapsed: Double) -> [Int16] {
        let target = Int(elapsed * Double(WavWriter.sampleRate))
        guard target > index else { return [] }
        let rate = Double(WavWriter.sampleRate)
        let out = (index..<target).map { i -> Int16 in
            let t = Double(i) / rate
            if gaps, t.truncatingRemainder(dividingBy: 2) >= 1, t.truncatingRemainder(dividingBy: 2) < 1.5 { return 0 }
            return Int16(Self.amplitude * 32767 * sin(2 * .pi * frequency * t))
        }
        index = target
        return out
    }
}

// MARK: - Core Audio 도우미

func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func getProperty<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T) throws {
    var address = propertyAddress(selector)
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
    try check(status, "AudioObjectGetPropertyData(\(selector))")
}

func check(_ status: OSStatus, _ what: String) throws {
    guard status == noErr else { throw WavError.io("\(what) 실패 (OSStatus \(status))") }
}
