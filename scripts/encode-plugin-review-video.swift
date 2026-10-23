import AppKit
import AVFoundation
import CoreVideo
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  fputs("Usage: swift encode-plugin-review-video.swift <frames-dir> <output.mp4>\n", stderr)
  exit(2)
}

let frameDirectory = URL(fileURLWithPath: arguments[1], isDirectory: true)
let outputURL = URL(fileURLWithPath: arguments[2])
let fileManager = FileManager.default
try? fileManager.removeItem(at: outputURL)

let frameURLs = try fileManager.contentsOfDirectory(at: frameDirectory, includingPropertiesForKeys: nil)
  .filter { $0.pathExtension.lowercased() == "png" && $0.lastPathComponent.hasPrefix("slide-") }
  .sorted { $0.lastPathComponent < $1.lastPathComponent }

guard !frameURLs.isEmpty else {
  fputs("No PNG frames found.\n", stderr)
  exit(3)
}

let width = 1280
let height = 720
let fps: Int32 = 30
let secondsPerSlide = 4
let framesPerSlide = Int(fps) * secondsPerSlide

let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
let settings: [String: Any] = [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: 4_000_000,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
  ]
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let attributes: [String: Any] = [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: width,
  kCVPixelBufferHeightKey as String: height
]
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
guard writer.canAdd(input) else { throw NSError(domain: "AIPIVideo", code: 1) }
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

func makePixelBuffer(from image: NSImage) -> CVPixelBuffer {
  var buffer: CVPixelBuffer?
  CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &buffer)
  guard let pixelBuffer = buffer else { fatalError("Could not allocate pixel buffer") }
  CVPixelBufferLockBaseAddress(pixelBuffer, [])
  defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
  guard let context = CGContext(
    data: CVPixelBufferGetBaseAddress(pixelBuffer),
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
  ) else { fatalError("Could not create bitmap context") }
  context.setFillColor(NSColor(calibratedRed: 0.03, green: 0.05, blue: 0.08, alpha: 1).cgColor)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("Could not decode image") }
  context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
  return pixelBuffer
}

var presentationFrame: Int64 = 0
for frameURL in frameURLs {
  guard let image = NSImage(contentsOf: frameURL) else { throw NSError(domain: "AIPIVideo", code: 2) }
  let pixelBuffer = makePixelBuffer(from: image)
  for _ in 0..<framesPerSlide {
    while !input.isReadyForMoreMediaData { usleep(1_000) }
    let time = CMTime(value: presentationFrame, timescale: fps)
    guard adaptor.append(pixelBuffer, withPresentationTime: time) else {
      throw writer.error ?? NSError(domain: "AIPIVideo", code: 3)
    }
    presentationFrame += 1
  }
}

input.markAsFinished()
let semaphore = DispatchSemaphore(value: 0)
writer.finishWriting { semaphore.signal() }
semaphore.wait()
guard writer.status == .completed else { throw writer.error ?? NSError(domain: "AIPIVideo", code: 4) }
print("Created \(outputURL.path) (\(frameURLs.count * secondsPerSlide)s)")
