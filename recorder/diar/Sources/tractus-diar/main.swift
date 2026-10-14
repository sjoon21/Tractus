import FluidAudio
import Foundation
import DiarKit

// tractus-diar — 9명 이상 화자 분리 헬퍼. FluidAudio OfflineDiarizerManager(pyannote community-1 Core ML)를 돌린다.
// stdout에는 JSON Lines 이벤트만 쓴다(progress…, 마지막에 result 또는 error). 로그는 stderr.

let usage = """
사용법:
  tractus-diar download --models <dir>
  tractus-diar run --audio <wav> --models <dir> [--max-speakers N]
"""

signal(SIGPIPE, SIG_IGN)
let started = Date()
let repo = Repo.diarizer
let modelID = "\(repo.remotePath)@\(repo.revision)"  // FluidAudio 0.17.5가 고정한 revision

func emit(_ object: [String: Any]) {
    guard var data = try? jsonData(object) else { return }
    data.append(0x0A)
    data.withUnsafeBytes { _ = write(STDOUT_FILENO, $0.baseAddress, $0.count) }
}

func fail(_ message: String) -> Never {
    emit(["event": "error", "message": message])
    exit(1)
}

/// FluidAudio는 <dir>/speaker-diarization/ 아래에 둔다. 그 폴더 자체를 줘도 같은 곳을 가리키게 한다.
func modelsRoot(_ path: String) -> URL {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    return url.lastPathComponent == repo.folderName ? url.deletingLastPathComponent() : url
}

func download(_ models: String) async {
    let root = modelsRoot(models)
    do {
        _ = try await OfflineDiarizerModels.load(from: root)  // 받고 Core ML로 한 번 열어 본다
    } catch {
        fail("모델을 받지 못했습니다: \(error)")
    }
    emit(["event": "downloaded", "path": root.appendingPathComponent(repo.folderName).path, "model": modelID])
}

func run(audio: String, models: String, maxSpeakers: Int?) async {
    ModelHub.offlineMode = true  // 실행 중에는 네트워크를 쓰지 않는다. 모델이 없거나 깨졌으면 받지 않고 실패한다
    guard FileManager.default.fileExists(atPath: audio) else { fail("오디오 파일이 없습니다: \(audio)") }
    let root = modelsRoot(models)
    var config = OfflineDiarizerConfig.default
    if let maxSpeakers { config = config.withSpeakers(max: maxSpeakers) }

    let loaded: OfflineDiarizerModels
    do {
        loaded = try await OfflineDiarizerModels.load(from: root)
    } catch {
        fail("모델을 열지 못했습니다(\(root.appendingPathComponent(repo.folderName).path)). tractus-diar download --models \(models)로 받으세요: \(error)")
    }
    let manager = OfflineDiarizerManager(config: config)
    manager.initialize(models: loaded)

    do {
        // 메모리로 읽는다. makeDiskBackedSource는 $TMPDIR을 무시하는 임시 폴더에 float32 사본을 쓰고 defer로만 지워서,
        // SIGKILL(파이썬 시간 초과)이면 회의 오디오가 남았다.
        // ponytail: 표본당 4바이트(90분 ≈ 345 MB). 더 긴 회의에서 메모리가 문제면 직접 만들고 바로 unlink하는 mmap 소스로.
        let samples = try AudioConverter(sampleRate: Double(config.segmentation.sampleRate)).resampleAudioFile(path: audio)
        let result = try await manager.process(audio: samples) { done, total in
            if done == total || done % max(1, total / 20) == 0 { emit(["event": "progress", "done": done, "total": total]) }
        }
        let turns = labelTurns(result.segments.map { (Double($0.startTimeSeconds), Double($0.endTimeSeconds), $0.speakerId) })
        emit(diarResult(turns: turns, model: modelID, elapsed: Date().timeIntervalSince(started)))
    } catch {
        fail("화자 분리 실패: \(error)")
    }
}

let command: DiarCommand
do { command = try DiarCommand.parse(Array(CommandLine.arguments.dropFirst())) } catch { fail("\(error)\n\(usage)") }
switch command {
case .download(let models): await download(models)
case let .run(audio, models, maxSpeakers): await run(audio: audio, models: models, maxSpeakers: maxSpeakers)
}
exit(0)
