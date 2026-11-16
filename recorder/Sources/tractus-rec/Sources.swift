import AVFoundation
import CoreAudio
import Foundation
import ObjCCatch
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
    /// 장치가 바뀌면 같은 엔진의 입력 노드가 낡은 포맷을 쥔 채 남을 수 있어, `stop()`마다 새 엔진으로 바꾼다.
    private var engine = AVAudioEngine()
    private var observer: NSObjectProtocol?
    private let onChange: () -> Void
    /// 실제로 켜졌는지. 켜지 못하면 경고 후 false로 녹음한다.
    private(set) var echoCancel: Bool

    init(echoCancel: Bool, onChange: @escaping () -> Void) {
        self.echoCancel = echoCancel
        self.onChange = onChange
        // 음성 처리를 켜면 입력 구성이 바뀌므로 관찰자를 걸기 전에 켠다.
        // 실패해도 여기서 끄지 않는다: 장치를 잡는 중일 수 있어 start가 다시 켜 보고, 음성 처리 없이 열릴 때만 끈다.
        if echoCancel { try? enableVoiceProcessing() }
        attach()
    }

    /// 지금 엔진의 구성 변경 알림을 받는다 (엔진을 바꿀 때 이전 엔진의 관찰자는 뗀다).
    private func attach() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [onChange] _ in onChange() }
    }

    /// 엔진이 멈춘 상태에서만 부른다. 덕킹 설정 변경도 구성 변경 알림을 부를 수 있으므로 켤 때만 넣는다.
    private func enableVoiceProcessing() throws {
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        // 다른 앱 소리(화상회의 상대 목소리)를 줄이지 않게 덕킹을 최소로 둔다.
        input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
    }

    /// 음성 처리로 열지 못하면(켜기·포맷·엔진 시작 중 어디서든) 음성 처리 없이 다시 연다. 그렇게 열리면 경고 후 음성 처리를 끈다.
    /// 한 번 꺼지면 이후 재연결도 음성 처리 없이 한다(마이크 트랙을 잃지 않는 게 먼저다).
    /// 음성 처리 없이도 못 열면 장치 문제라 끄지 않고 던진다: 다음 재시도도 요청한 대로 음성 처리부터 연다.
    func start(_ sink: @escaping SampleSink) throws {
        if echoCancel {
            do {
                // 장치가 바뀌어 다시 열 때 음성 처리가 풀렸으면 다시 켠다. 켜져 있으면 건드리지 않는다.
                if !engine.inputNode.isVoiceProcessingEnabled { try enableVoiceProcessing() }
                try open(sink)
            } catch {
                stop()
                try? engine.inputNode.setVoiceProcessingEnabled(false)
                try open(sink)
                echoCancel = false
                warning("echo_cancel_failed", "에코 제거를 켜지 못해 에코 제거 없이 녹음합니다: \(error)")
            }
            return
        }
        try open(sink)
    }

    private func open(_ sink: @escaping SampleSink) throws {
        let input = engine.inputNode
        // 음성 처리는 입력 포맷(채널 수 등)을 바꾸므로 켠 뒤에 포맷을 읽는다.
        if let rate = micClientRateToSet(clientRate: input.outputFormat(forBus: 0).sampleRate, hardwareRate: input.inputFormat(forBus: 0).sampleRate, voiceProcessing: input.isVoiceProcessingEnabled),
           let unit = input.audioUnit {
            followHardwareRate(unit, rate)
        }
        let format = input.outputFormat(forBus: 0)
        let hardware = input.inputFormat(forBus: 0)
        if let problem = micFormatProblem(tapRate: format.sampleRate, tapChannels: Int(format.channelCount), hardwareRate: hardware.sampleRate, hardwareChannels: Int(hardware.channelCount), voiceProcessing: input.isVoiceProcessingEnabled) {
            throw WavError.io(problem)  // 맞추고도 다르면 던진다. 던지면 Recorder가 경고를 내고 watchdog이 2초마다 다시 연다(녹음 시작 때는 다른 트랙이 돌 때만, Recorder.start)
        }
        guard let converter = MonoConverter(from: format, firstChannelOnly: input.isVoiceProcessingEnabled) else {
            throw WavError.io("입력 장치가 없거나 포맷을 변환할 수 없습니다 (\(format))")
        }
        do {
            // 위 검사로 못 거른 조건에서도 AVFAudio가 NSException을 던질 수 있다: 녹음 프로세스가 죽지 않게 오류로 바꾼다
            try TractusObjC.catching { input.installTap(onBus: 0, bufferSize: 4800, format: format) { buffer, _ in sink(converter.convert(buffer)) } }
        } catch {
            throw WavError.io("마이크 입력을 열지 못했습니다: \(error.localizedDescription)")
        }
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
    }

    /// 입력 유닛의 클라이언트 쪽(출력 범위, 입력 요소 1) 표본 속도를 장치 속도로 바꾼다(Yogurt 3806507). 실패하면 기록만 하고 아래 포맷 검사가 거른다.
    private func followHardwareRate(_ unit: AudioUnit, _ rate: Double) {
        var client = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &client, &size) == noErr else { return }
        log("마이크가 \(Int(rate))Hz로 돌아 입력 표본 속도를 \(Int(client.mSampleRate))Hz에서 맞춥니다")
        client.mSampleRate = rate
        let status = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &client, size)
        if status != noErr { log("마이크 입력 표본 속도를 바꾸지 못했습니다 (OSStatus \(status))") }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        engine = AVAudioEngine()
        attach()
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
    private let onChange: (() -> Void)?
    /// 표본 속도 리스너. `stop()`이 뗀다.
    private var listeners: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

    init(onChange: (() -> Void)? = nil) {
        self.onChange = onChange
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
            let tapRate = asbd.mSampleRate

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

            // 버퍼는 장치가 도는 속도로 온다: tap 포맷과 다르면 장치 속도를 붙인다. 48 kHz 파일로의 변환은 MonoConverter가 이 속도에서 한다.
            let deviceRate = { [aggregateID] () -> Double? in
                var rate = Float64(0)
                return (try? getProperty(aggregateID, kAudioDevicePropertyNominalSampleRate, &rate)) != nil && rate > 0 ? rate : nil
            }
            asbd.mSampleRate = systemTapRate(tapRate: tapRate, deviceRate: deviceRate())
            if asbd.mSampleRate != tapRate { log("tap은 \(Int(tapRate))Hz라고 하지만 장치는 \(Int(asbd.mSampleRate))Hz로 돕니다") }
            guard let format = AVAudioFormat(streamDescription: &asbd), let converter = MonoConverter(from: format) else {
                throw WavError.io("tap 포맷을 변환할 수 없습니다")
            }
            // 통화 중 헤드셋 마이크가 켜지고 꺼지면 속도가 바뀐다: 정말 바뀌었을 때만 새 속도로 다시 연다.
            watchRate(aggregateID, kAudioDevicePropertyNominalSampleRate, from: asbd.mSampleRate, read: deviceRate)
            let tapFormatRate = { [tapID] () -> Double? in
                var d = AudioStreamBasicDescription()
                return (try? getProperty(tapID, kAudioTapPropertyFormat, &d)) != nil && d.mSampleRate > 0 ? d.mSampleRate : nil
            }
            // 기준은 aggregate를 만든 뒤에 다시 읽는다: tap 포맷은 장치에 붙으며 바뀔 수 있어 앞의 값과 비교하면 헛되이 다시 연다.
            watchRate(tapID, kAudioTapPropertyFormat, from: tapFormatRate() ?? tapRate, read: tapFormatRate)

            let channels = Int(format.channelCount)
            try check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
                // 출력 장치의 입력 스트림(헤드셋 마이크)이 앞에 올 수 있어 tap 버퍼(맨 뒤)만 쓴다. tap은 mono라 버퍼 하나다.
                let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
                guard let i = tapBufferIndex(channels: list.map { Int($0.mNumberChannels) }, tapChannels: channels) else { return }
                var one = AudioBufferList(mNumberBuffers: 1, mBuffers: list[i])
                withUnsafeMutablePointer(to: &one) { one in
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: one, deallocator: nil) else { return }
                    sink(converter.convert(buffer))  // input은 콜백 안에서만 유효하므로 바로 변환한다
                }
            }, "AudioDeviceCreateIOProcIDWithBlock")
            try check(AudioDeviceStart(aggregateID, procID), "AudioDeviceStart")
        } catch {
            stop()
            throw error
        }
    }

    /// `read()`가 `rate`와 다른 속도를 내면 `onChange`로 다시 열게 한다. 리스너는 오디오 스레드가 아니라 `queue`에서 돈다.
    private func watchRate(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, from rate: Double, read: @escaping () -> Double?) {
        guard let onChange else { return }
        var address = propertyAddress(selector)
        let block: AudioObjectPropertyListenerBlock = { _, _ in
            guard let now = read(), now != rate else { return }
            log("시스템 오디오 표본 속도가 \(Int(rate))Hz에서 \(Int(now))Hz로 바뀌었습니다")
            onChange()
        }
        let status = AudioObjectAddPropertyListenerBlock(object, &address, queue, block)
        if status == noErr { listeners.append((object, address, block)) } else { log("표본 속도 리스너 등록 실패 (OSStatus \(status))") }
    }

    /// 만든 역순으로 정리한다. 여러 번 불러도 된다.
    func stop() {
        for (object, address, block) in listeners {
            var address = address
            AudioObjectRemovePropertyListenerBlock(object, &address, queue, block)
        }
        listeners = []
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
    var index = 0  // 다음에 낼 표본 위치(녹음 시작 기준)

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

/// 시험 전용(`--fake` + `TRACTUS_REC_TEST_MIC_FAIL_UNTIL=<초>`): 녹음 시각 `until`초 전에는 열리지 않는 마이크.
/// 녹음 시작 때 마이크를 못 연 경우(화상회의 앱이 마이크를 잡는 중 등)의 재시도·시각 맞추기를 권한 없이 시험한다.
final class FlakyFakeMic: AudioSource {
    private let until: Double
    private let queue: DispatchQueue
    private let clock: () -> Double  // 녹음 시각. `queue`에서만 읽는다
    private var timer: DispatchSourceTimer?

    init(until: Double, queue: DispatchQueue, clock: @escaping () -> Double) { self.until = until; self.queue = queue; self.clock = clock }

    func start(_ sink: @escaping SampleSink) throws {
        guard clock() >= until else { throw WavError.io("시험: 마이크가 아직 준비되지 않았습니다") }
        let source = FakeSource(frequency: 440, gaps: false)
        source.index = Int(clock() * Double(WavWriter.sampleRate))  // 열린 때부터 낸다: 앞부분은 Recorder가 0으로 메운다
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 0.02)
        t.setEventHandler { [clock] in sink(source.generate(upTo: clock())) }
        t.resume()
        timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
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
