// The audio for a share: all of the system's minus the apps that should stay
// out of it, or only the application a shared window belongs to.
//
//   harmony-audio-capture [--exclude-pids 123,456,...]
//   harmony-audio-capture --include-window <CGWindowID>
//   harmony-audio-capture --list-windows
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
// display to capture from, 4 the capture failed to start or stopped, 5 the
// window is not there (closed since it was picked).
//
// ScreenCaptureKit is the only API macOS offers that can leave one app's
// audio out of a system capture. It can also do the reverse: a display filter
// that INCLUDES only some applications carries only their audio. For a shared
// window that is the application that owns it -- the whole application, since
// macOS has no sound per window, which is what a window share on Windows sends
// as well. (A filter on the window alone is not that: it is a picture, and the
// audio is not what comes with it.) It needs macOS 13, and the Screen
// Recording permission Harmony already holds for the picture.
//
// --list-windows prints what could be asked for, for finding a window's number
// by hand: id, application, bundle, pid, title.
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
var includeWindow: CGWindowID?
var listWindows = false
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    if arg == "--exclude-pids", let list = args.popFirst() {
        for piece in list.split(separator: ",") {
            if let pid = pid_t(piece) { excluded.insert(pid) }
        }
    } else if arg == "--include-window", let value = args.popFirst() {
        includeWindow = CGWindowID(value)
    } else if arg == "--list-windows" {
        listWindows = true
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
    /// Whether any audio has arrived: silence that is the capture's fault and
    /// silence that is the application's are told apart by this one line.
    var heard = false

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, let data = pcm16(from: sampleBuffer) else { return }
        if !heard {
            heard = true
            say("audio flowing")
        }
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
        // A window the person picked a moment ago may have gone to another
        // Space or been minimised since; it is still theirs to share.
        content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: includeWindow == nil)
    } catch {
        // -3801: the user has not allowed Screen Recording for this app.
        let code = (error as NSError).code
        fail(code == -3801 ? 2 : 4, code == -3801
            ? "permission Screen Recording is not allowed for Harmony"
            : "content \(error.localizedDescription)")
    }
    if listWindows {
        for window in content.windows {
            let app = window.owningApplication
            say("\(window.windowID)\t\(app?.applicationName ?? "-")\t\(app?.bundleIdentifier ?? "-")\t\(app?.processID ?? 0)\t\(window.title ?? "")")
        }
        exit(0)
    }

    let filter: SCContentFilter
    if let id = includeWindow {
        // The application the window belongs to, and only that: its audio is
        // what a display filter that includes it carries.
        guard let window = content.windows.first(where: { $0.windowID == id }) else {
            fail(5, "window gone that window is not open any more")
        }
        guard let owner = window.owningApplication else {
            fail(5, "window gone no application owns that window")
        }
        guard let display = content.displays.first(where: { $0.frame.intersects(window.frame) })
                ?? content.displays.first else { fail(3, "display none to capture from") }

        // An application's sound comes from more than its main process: a
        // browser or an Electron app plays it from helper processes, filed
        // under entries of their own whose bundle ids start with the app's.
        let bundle = owner.bundleIdentifier
        let apps = content.applications.filter { app in
            app.processID == owner.processID
                || (!bundle.isEmpty && (app.bundleIdentifier == bundle || app.bundleIdentifier.hasPrefix(bundle + ".")))
        }
        let names = apps.map { "\($0.applicationName) \($0.processID)" }.joined(separator: ", ")
        say("window \(id): \(owner.applicationName) (\(bundle)); capturing audio of \(apps.count): \(names)")
        filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
    } else {
        guard let display = content.displays.first else { fail(3, "display none to capture from") }

        // An application matches if it, or any process the caller listed, is one of
        // the excluded pids. The caller passes the whole process tree: an Electron
        // app plays its sound from a helper process, and ScreenCaptureKit files
        // that under the helper's own entry as often as under the app's.
        let apps = content.applications.filter { excluded.contains($0.processID) }
        filter = SCContentFilter(display: display, excludingApplications: apps, exceptingWindows: [])
    }

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

    // Said once, and a little late: an application that is not playing anything
    // is quiet by right, one that is and still arrives here as nothing is not.
    DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
        if !sink.heard { say("no audio has arrived yet (is the application playing sound?)") }
    }
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
