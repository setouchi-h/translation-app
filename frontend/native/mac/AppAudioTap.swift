// Captures the audio that chosen apps play, without a virtual audio device.
//
//   app-audio-tap list
//       Prints a JSON array of the processes that use audio, grouped by app, to stdout.
//
//   app-audio-tap capture <include|exclude> [app id]...
//       Writes 24 kHz mono 16-bit little-endian PCM to stdout until it is terminated.
//       `include` taps only those apps. `exclude` taps all system audio but those apps.
//       Status goes to stderr as one JSON object per line.
//
// Needs macOS 14.2 or later (Core Audio process taps).

import AVFoundation
import CoreAudio
import Darwin
import Foundation

/// The rate both speech services take, so nothing downstream has to resample.
let outputSampleRate = 24_000.0
let chunkMilliseconds = 100
/// Longer than the interval between audio callbacks, so silence never lands inside live audio.
let silenceAfterIdleNanoseconds: UInt64 = 300_000_000

// MARK: - Output

func emitStatus(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
  FileHandle.standardError.write(data + Data([0x0A]))
}

func fail(_ message: String) -> Never {
  emitStatus(["type": "error", "message": message])
  exit(1)
}

/// Writes all bytes to stdout. Exits when the reader is gone, which is how the helper
/// stops if the app that launched it dies.
func writeToStdout(_ pointer: UnsafeRawPointer, _ count: Int) {
  var offset = 0
  while offset < count {
    let written = write(STDOUT_FILENO, pointer + offset, count - offset)
    if written < 0 {
      if errno == EINTR { continue }
      exit(0)
    }
    offset += written
  }
}

// MARK: - Core Audio properties

func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
}

func readProperty<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T)
  -> T?
{
  var address = propertyAddress(selector)
  var size = UInt32(MemoryLayout<T>.size)
  var value = initial
  let status = withUnsafeMutablePointer(to: &value) {
    AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
  }
  return status == noErr ? value : nil
}

func audioProcessObjects() -> [AudioObjectID] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var address = propertyAddress(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else {
    return []
  }

  var objects = [AudioObjectID](
    repeating: AudioObjectID(kAudioObjectUnknown),
    count: Int(size) / MemoryLayout<AudioObjectID>.size
  )
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &objects) == noErr else {
    return []
  }

  return Array(objects.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
}

// MARK: - Apps

struct AudioProcess {
  let object: AudioObjectID
  let pid: pid_t
  /// Bundle identifier of the app that owns the process, or the executable path when the
  /// process is not part of an app bundle.
  let appId: String
  let appName: String
  let isApp: Bool
  let isPlaying: Bool
}

func executablePath(of pid: pid_t) -> String? {
  var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
  return length > 0 ? String(cString: buffer) : nil
}

/// The outermost `.app` that contains the path. Helper processes such as
/// `Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/...` resolve to `Discord.app`,
/// which is the app a person would pick.
func owningAppBundle(of path: String) -> String? {
  var current = ""
  for component in path.split(separator: "/") {
    current += "/" + component
    if component.hasSuffix(".app") {
      return current
    }
  }
  return nil
}

var appInfoCache: [String: (id: String, name: String)] = [:]

func appInfo(forBundle bundlePath: String) -> (id: String, name: String) {
  if let cached = appInfoCache[bundlePath] {
    return cached
  }

  let bundle = Bundle(path: bundlePath)
  let fallbackName = String(
    (bundlePath as NSString).lastPathComponent.dropLast(".app".count))
  let name =
    bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
    ?? bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String
    ?? fallbackName
  let info = (id: bundle?.bundleIdentifier ?? bundlePath, name: name)
  appInfoCache[bundlePath] = info
  return info
}

func describeProcess(_ object: AudioObjectID) -> AudioProcess? {
  guard let pid = readProperty(object, kAudioProcessPropertyPID, pid_t(-1)), pid > 0,
    let path = executablePath(of: pid)
  else {
    return nil
  }

  let isPlaying = (readProperty(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0

  if let bundlePath = owningAppBundle(of: path) {
    let info = appInfo(forBundle: bundlePath)
    // Bundles under /System/Library are background agents such as Control Center, not apps
    // a person would pick. Apple's own apps live in /System/Applications.
    return AudioProcess(
      object: object, pid: pid, appId: info.id, appName: info.name,
      isApp: !bundlePath.hasPrefix("/System/Library/"), isPlaying: isPlaying)
  }

  return AudioProcess(
    object: object, pid: pid, appId: path, appName: (path as NSString).lastPathComponent,
    isApp: false, isPlaying: isPlaying)
}

func listApps() {
  let ownAppId = executablePath(of: getpid()).flatMap(owningAppBundle).map {
    appInfo(forBundle: $0).id
  }

  var apps: [String: [String: Any]] = [:]
  for process in audioProcessObjects().compactMap(describeProcess) {
    if process.pid == getpid() || process.appId == ownAppId {
      continue
    }

    var entry =
      apps[process.appId] ?? [
        "id": process.appId, "name": process.appName, "isApp": process.isApp, "playing": false,
      ]
    if process.isPlaying {
      entry["playing"] = true
    }
    apps[process.appId] = entry
  }

  guard let data = try? JSONSerialization.data(withJSONObject: Array(apps.values)) else {
    fail("Could not encode the app list.")
  }
  FileHandle.standardOutput.write(data + Data([0x0A]))
}

// MARK: - Capture

enum CaptureMode {
  case include
  case exclude
}

final class Capture {
  private let mode: CaptureMode
  private let appIds: Set<String>
  private let outputFormat: AVAudioFormat
  /// Serializes tap setup and teardown.
  private let queue = DispatchQueue(label: "app-audio-tap.control")
  /// Delivers audio. Kept apart from `queue` because stopping the device waits for the
  /// audio callback to finish, which would deadlock if both ran on one queue.
  private let audioQueue = DispatchQueue(label: "app-audio-tap.audio")
  private let silence: [UInt8]

  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateID = AudioObjectID(kAudioObjectUnknown)
  private var ioProcID: AudioDeviceIOProcID?
  private var tappedObjects: [AudioObjectID] = []
  private var isTapRunning = false
  private var silenceTimer: DispatchSourceTimer?
  private var healthTimer: DispatchSourceTimer?
  private var heardAudio = false
  /// Only touched on `audioQueue`.
  private var reportedAudio = false
  /// Only touched on `audioQueue`.
  private var lastAudioAt = DispatchTime.now()
  private var warnedAboutSilence = false
  private var silentChecksWhilePlaying = 0

  init(mode: CaptureMode, appIds: Set<String>) {
    self.mode = mode
    self.appIds = appIds
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: outputSampleRate, channels: 1,
        interleaved: true)
    else {
      fail("Could not create the output audio format.")
    }
    outputFormat = format
    silence = [UInt8](
      repeating: 0, count: Int(outputSampleRate) * chunkMilliseconds / 1000 * 2)
  }

  func run() {
    queue.async {
      self.watchProcessList()
      self.startSilenceTimer()
      self.startHealthTimer()
      self.rebuildIfNeeded(force: true)
    }
  }

  func shutdown() {
    queue.sync {
      self.teardown()
    }
  }

  // MARK: Process selection

  /// Every process that uses audio, other than this one.
  private func otherProcesses() -> [AudioProcess] {
    let ownPid = getpid()
    return audioProcessObjects().compactMap(describeProcess).filter { $0.pid != ownPid }
  }

  /// The processes of the listed apps, which the tap description names in both modes.
  private func listedObjects() -> [AudioObjectID] {
    otherProcesses().filter { appIds.contains($0.appId) }.map(\.object).sorted()
  }

  /// Whether any process the tap carries is playing: a listed app when including, any
  /// other process when excluding.
  private func isTappedAudioPlaying() -> Bool {
    otherProcesses().contains {
      $0.isPlaying && appIds.contains($0.appId) == (mode == .include)
    }
  }

  private func watchProcessList() {
    var address = propertyAddress(kAudioHardwarePropertyProcessObjectList)
    AudioObjectAddPropertyListenerBlock(
      AudioObjectID(kAudioObjectSystemObject), &address, queue
    ) { [weak self] _, _ in
      self?.rebuildIfNeeded(force: false)
    }
  }

  /// A process can exit between being listed and being tapped, which fails the tap.
  /// Listing again clears that up, so only a second failure in a row is fatal.
  private var isRetryingTap = false

  /// Apps start and stop audio helper processes at any time, so the tap is rebuilt whenever
  /// the set of matching processes changes.
  private func rebuildIfNeeded(force: Bool) {
    let objects = listedObjects()
    if !force && objects == tappedObjects {
      return
    }

    teardown()
    tappedObjects = objects

    if mode == .include && objects.isEmpty {
      emitStatus(["type": "waiting"])
      return
    }

    do {
      try startTap(objects)
      isRetryingTap = false
      emitStatus(["type": "capturing", "processes": objects.count])
    } catch {
      teardown()
      if isRetryingTap {
        fail("\(error)")
      }
      isRetryingTap = true
      queue.asyncAfter(deadline: .now() + .milliseconds(200)) {
        self.rebuildIfNeeded(force: true)
      }
    }
  }

  // MARK: Tap lifecycle

  private struct TapError: Error, CustomStringConvertible {
    let description: String
  }

  private func check(_ status: OSStatus, _ action: String) throws {
    if status != noErr {
      throw TapError(description: "\(action) failed (OSStatus \(status)).")
    }
  }

  private func startTap(_ objects: [AudioObjectID]) throws {
    let description =
      mode == .include
      ? CATapDescription(monoMixdownOfProcesses: objects)
      : CATapDescription(monoGlobalTapButExcludeProcesses: objects)
    description.uuid = UUID()
    description.name = "Caption audio tap"
    description.isPrivate = true
    description.muteBehavior = .unmuted

    try check(AudioHardwareCreateProcessTap(description, &tapID), "Creating the audio tap")

    guard var streamDescription = readProperty(
      tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription()),
      let format = AVAudioFormat(streamDescription: &streamDescription),
      let converter = AVAudioConverter(from: format, to: outputFormat)
    else {
      throw TapError(description: "Could not read the audio tap format.")
    }

    let aggregate: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Caption audio capture",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[String: Any]](),
      kAudioAggregateDeviceTapListKey: [
        [
          kAudioSubTapDriftCompensationKey: true,
          kAudioSubTapUIDKey: description.uuid.uuidString,
        ]
      ],
    ]
    try check(
      AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID),
      "Creating the capture device")

    try check(
      AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, audioQueue) {
        [weak self] _, inputData, _, _, _ in
        self?.handleInput(inputData, format: format, converter: converter)
      }, "Attaching to the capture device")
    try check(AudioDeviceStart(aggregateID, ioProcID), "Starting the capture device")
    isTapRunning = true
  }

  private func teardown() {
    if aggregateID != kAudioObjectUnknown {
      if let ioProcID {
        AudioDeviceStop(aggregateID, ioProcID)
        AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
      }
      AudioHardwareDestroyAggregateDevice(aggregateID)
    }
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
    }

    ioProcID = nil
    aggregateID = AudioObjectID(kAudioObjectUnknown)
    tapID = AudioObjectID(kAudioObjectUnknown)
    // The device has stopped, so no audio callback is running any more.
    audioQueue.sync {}
    isTapRunning = false
  }

  // MARK: Audio

  private func handleInput(
    _ inputData: UnsafePointer<AudioBufferList>, format inputFormat: AVAudioFormat,
    converter: AVAudioConverter
  ) {
    guard
      let input = AVAudioPCMBuffer(
        pcmFormat: inputFormat, bufferListNoCopy: inputData, deallocator: nil),
      input.frameLength > 0
    else {
      return
    }

    let ratio = outputFormat.sampleRate / inputFormat.sampleRate
    let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 64
    guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
      return
    }

    var supplied = false
    var conversionError: NSError?
    converter.convert(to: output, error: &conversionError) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return input
    }

    guard conversionError == nil, output.frameLength > 0, let samples = output.int16ChannelData
    else {
      return
    }

    let frameCount = Int(output.frameLength)
    if !reportedAudio {
      for index in 0..<frameCount where samples[0][index] != 0 {
        reportedAudio = true
        queue.async { self.heardAudio = true }
        break
      }
    }

    lastAudioAt = .now()
    writeToStdout(samples[0], frameCount * MemoryLayout<Int16>.size)
  }

  /// A tap delivers nothing at all while its apps are idle or not running. Silence fills
  /// those gaps so the speech service does not see the connection go idle.
  private func startSilenceTimer() {
    let timer = DispatchSource.makeTimerSource(queue: audioQueue)
    timer.schedule(
      deadline: .now() + .milliseconds(chunkMilliseconds),
      repeating: .milliseconds(chunkMilliseconds))
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      let idleNanoseconds = DispatchTime.now().uptimeNanoseconds - self.lastAudioAt.uptimeNanoseconds
      guard idleNanoseconds > silenceAfterIdleNanoseconds else { return }
      self.silence.withUnsafeBytes { writeToStdout($0.baseAddress!, $0.count) }
    }
    timer.resume()
    silenceTimer = timer
  }

  /// A tap that was denied permission delivers pure digital silence rather than an error.
  /// The only observable sign is an app that reports it is playing while every sample is zero.
  private func startHealthTimer() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
    timer.setEventHandler { [weak self] in
      guard let self, self.isTapRunning, !self.heardAudio, !self.warnedAboutSilence else {
        return
      }

      let isPlaying = self.isTappedAudioPlaying()
      self.silentChecksWhilePlaying = isPlaying ? self.silentChecksWhilePlaying + 1 : 0
      if self.silentChecksWhilePlaying >= 3 {
        self.warnedAboutSilence = true
        emitStatus(["type": "silent-while-playing"])
      }
    }
    timer.resume()
    healthTimer = timer
  }
}

// MARK: - Entry point

signal(SIGPIPE, SIG_IGN)

let usage = "Usage: app-audio-tap list | capture <include|exclude> [app id]..."
var arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
  fail(usage)
}
arguments.removeFirst()

switch command {
case "list":
  listApps()

case "capture":
  let mode: CaptureMode
  switch arguments.first {
  case "include": mode = .include
  case "exclude": mode = .exclude
  default: fail(usage)
  }

  let capture = Capture(mode: mode, appIds: Set(arguments.dropFirst()))

  var signalSources: [DispatchSourceSignal] = []
  for signalNumber in [SIGINT, SIGTERM] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler {
      capture.shutdown()
      exit(0)
    }
    source.resume()
    signalSources.append(source)
  }

  capture.run()
  dispatchMain()

default:
  fail("Unknown command: \(command).")
}
