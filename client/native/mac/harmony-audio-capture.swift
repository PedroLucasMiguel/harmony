// System audio for a screen share, minus the apps that should stay out of it.
//
//   harmony-audio-capture [--exclude-pids 123,456,...]
//
// Writes interleaved signed 16-bit little-endian PCM, stereo, 48 kHz to stdout
// -- the same format the Windows capture addon produces, so everything after
// the main process is shared. Progress and failures go to stderr as single
// lines:
//
//   ready                      capture is running
//   error: <code> <detail>     it is not, and will not be; the exit code says why
//
// Exit codes: 0 stopped normally, 2 Screen Recording is not allowed, 3 no
// display to capture from, 4 the capture failed to start or stopped.
//
// ScreenCaptureKit is the only API macOS offers that can leave one app's
// audio out of a system capture (an audio tap by process would do the
// opposite: pick the apps to include). It needs macOS 13, and the Screen
// Recording permission Harmony already holds for the picture.
//
// The process exits when its stdin closes, so an Electron that is killed
// rather than quit does not leave a capture running behind it.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IOFBF, 0)

func say(_ line: String) {
    FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
}

func fail(_ code: Int32, _ message: String) -> Never {
    say("error: \(message)")
    exit(code)
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

var excluded = Set<pid_t>()
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    if arg == "--exclude-pids", let list = args.popFirst() {
        for piece in list.split(separator: ",") {
            if let pid = pid_t(piece) { excluded.insert(pid) }
        }
    }
}

// ---------------------------------------------------------------------------
// Sample conversion
// ---------------------------------------------------------------------------

/// What comes out of ScreenCaptureKit is 32-bit float, usually one buffer per
/// channel. Interleave it and squeeze it into 16 bits, clipping rather than
/// wrapping: a wrapped sample is a loud click, a clipped one is only loud.
func pcm16(from sampleBuffer: CMSampleBuffer) -> Data? {
    guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
          let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
    else { return nil }

    var sizeNeeded = 0
    var blockBuffer: CMBlockBuffer?
    let probe = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: &sizeNeeded,
        bufferListOut: nil,
        bufferListSize: 0,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: 0,
        blockBufferOut: nil
    )
    guard probe == noErr, sizeNeeded > 0 else { return nil }

    let raw = UnsafeMutableRawPointer.allocate(
        byteCount: sizeNeeded,
        alignment: MemoryLayout<AudioBufferList>.alignment
    )
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)

    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: list,
        bufferListSize: sizeNeeded,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer
    )
    guard status == noErr else { return nil }

    let buffers = UnsafeMutableAudioBufferListPointer(list)
    let frames = Int(CMSampleBufferGetNumSamples(sampleBuffer))
    let channels = Int(description.mChannelsPerFrame)
    guard frames > 0, channels > 0, description.mBitsPerChannel == 32 else { return nil }

    let planar = (description.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    var out = [Int16](repeating: 0, count: frames * 2)

    @inline(__always) func clip(_ v: Float) -> Int16 {
        Int16(max(-1, min(1, v)) * 32767)
    }

    if planar {
        // One buffer per channel. Mono is played from both sides; anything
        // past the second channel is dropped, as a stereo stream has no room.
        func channel(_ i: Int) -> UnsafePointer<Float>? {
            guard i < buffers.count, let data = buffers[i].mData else { return nil }
            return UnsafePointer(data.assumingMemoryBound(to: Float.self))
        }
        guard let left = channel(0) else { return nil }
        let right = channel(1) ?? left
        for i in 0..<frames {
            out[2 * i] = clip(left[i])
            out[2 * i + 1] = clip(right[i])
        }
    } else {
        guard let data = buffers[0].mData else { return nil }
        let samples = UnsafePointer(data.assumingMemoryBound(to: Float.self))
        for i in 0..<frames {
            out[2 * i] = clip(samples[i * channels])
            out[2 * i + 1] = clip(samples[i * channels + (channels > 1 ? 1 : 0)])
        }
    }
    return out.withUnsafeBufferPointer { Data(buffer: $0) }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

final class Sink: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, let data = pcm16(from: sampleBuffer) else { return }
        data.withUnsafeBytes { bytes in
            _ = fwrite(bytes.baseAddress, 1, bytes.count, stdout)
        }
        fflush(stdout)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail(4, "stopped \(error.localizedDescription)")
    }
}

let sink = Sink()
var capture: SCStream?

func start() async {
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
        // -3801: the user has not allowed Screen Recording for this app.
        let code = (error as NSError).code
        fail(code == -3801 ? 2 : 4, code == -3801
            ? "permission Screen Recording is not allowed for Harmony"
            : "content \(error.localizedDescription)")
    }
    guard let display = content.displays.first else { fail(3, "display none to capture from") }

    // An application matches if it, or any process the caller listed, is one of
    // the excluded pids. The caller passes the whole process tree: an Electron
    // app plays its sound from a helper process, and ScreenCaptureKit files
    // that under the helper's own entry as often as under the app's.
    let apps = content.applications.filter { excluded.contains($0.processID) }
    let filter = SCContentFilter(display: display, excludingApplications: apps, exceptingWindows: [])

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = 48000
    config.channelCount = 2
    // There is no way to ask for audio alone, so ask for the cheapest picture:
    // two pixels, once a second, which is then never read.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    config.showsCursor = false

    let stream = SCStream(filter: filter, configuration: config, delegate: sink)
    do {
        try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: DispatchQueue(label: "harmony.audio"))
        try await stream.startCapture()
    } catch {
        fail(4, "start \(error.localizedDescription)")
    }
    capture = stream
    say("ready")
}

// Parent gone, or asked to stop: finish the capture rather than leave it.
func finish() -> Never {
    if let stream = capture {
        let done = DispatchSemaphore(value: 0)
        stream.stopCapture { _ in done.signal() }
        _ = done.wait(timeout: .now() + 2)
    }
    exit(0)
}

signal(SIGTERM, SIG_IGN)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminate.setEventHandler { finish() }
terminate.resume()

DispatchQueue.global().async {
    while FileHandle.standardInput.availableData.count > 0 {}
    finish()
}

Task {
    await start()
}
RunLoop.main.run()
