// cutout: lifts the main subject out of a photo (Vision, macOS 14 or later) and
// places it centred on a white square, for the Homey driver image.
//
// Usage: swift tools/cutout.swift <photo> <output.png> [size]

import AppKit
import CoreImage
import Vision

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: cutout <photo> <output.png> [size]\n".data(using: .utf8)!)
    exit(1)
}
let size = args.count > 3 ? Int(args[3]) ?? 1000 : 1000

guard let input = CIImage(contentsOf: URL(fileURLWithPath: args[1]), options: [.applyOrientationProperty: true]) else {
    FileHandle.standardError.write("cannot read \(args[1])\n".data(using: .utf8)!)
    exit(1)
}

let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(ciImage: input)
try handler.perform([request])
guard let result = request.results?.first, !result.allInstances.isEmpty else {
    FileHandle.standardError.write("no subject found\n".data(using: .utf8)!)
    exit(2)
}

// Keep only the largest subject, so cables or other things on the table drop out.
let mask = result.instanceMask
CVPixelBufferLockBaseAddress(mask, .readOnly)
var areas: [Int: Int] = [:]
let base = CVPixelBufferGetBaseAddress(mask)!.assumingMemoryBound(to: UInt8.self)
let rowBytes = CVPixelBufferGetBytesPerRow(mask)
for y in 0..<CVPixelBufferGetHeight(mask) {
    for x in 0..<CVPixelBufferGetWidth(mask) {
        let label = Int(base[y * rowBytes + x])
        if label != 0 { areas[label, default: 0] += 1 }
    }
}
CVPixelBufferUnlockBaseAddress(mask, .readOnly)
let largest = areas.max { $0.value < $1.value }?.key ?? result.allInstances.first!

let masked = try result.generateMaskedImage(
    ofInstances: IndexSet(integer: largest), from: handler, croppedToInstancesExtent: true)
let subject = CIImage(cvPixelBuffer: masked)

// Fit the subject into 80% of the square and centre it on white.
let extent = subject.extent
let scale = CGFloat(size) * 0.8 / max(extent.width, extent.height)
let scaled = subject.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
let dx = (CGFloat(size) - scaled.extent.width) / 2 - scaled.extent.minX
let dy = (CGFloat(size) - scaled.extent.height) / 2 - scaled.extent.minY
let placed = scaled.transformed(by: CGAffineTransform(translationX: dx, y: dy))
let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: size, height: size))
let composed = placed.composited(over: white)

let context = CIContext()
guard let cg = context.createCGImage(composed, from: white.extent) else { exit(3) }
let rep = NSBitmapImageRep(cgImage: cg)
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
print("\(args[2]) \(size)x\(size)")
