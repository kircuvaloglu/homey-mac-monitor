// macsensors: reads temperature, fan and power values from the AppleSMC and
// prints a single line of JSON. Apple silicon only; does not need root.
//
// Keys (checked on M4):
//   Tp* / Te*   performance and efficiency core sensors -> CPU
//   Tg*         GPU sensors                             -> GPU
//   TH0*        NAND / SSD                              -> SSD temperature
//   PSTR        total system power (W)
//   F0Ac/Mn/Mx  fan actual/min/max RPM, FNum fan count
//
// Run with --all to dump every key (useful for mapping a new Mac model).

import Foundation
import IOKit

// MARK: - SMC access
// SMCParamStruct is 80 bytes. The key and dataType fields are native (little-endian)
// UInt32 values; the returned data bytes are big-endian except for "flt".
private let kStructSize = 80
private let OFF_KEY = 0, OFF_DATASIZE = 28, OFF_DATATYPE = 32
private let OFF_RESULT = 40, OFF_DATA8 = 42, OFF_DATA32 = 44, OFF_BYTES = 48
private let kSMCHandleYPCEvent: UInt32 = 2
private let kSMCReadKey: UInt8 = 5
private let kSMCGetKeyFromIndex: UInt8 = 8
private let kSMCGetKeyInfo: UInt8 = 9

private var conn: io_connect_t = 0

private func smcOpen() -> Bool {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"))
    guard service != 0 else { return false }
    defer { IOObjectRelease(service) }
    return IOServiceOpen(service, mach_task_self_, 0, &conn) == kIOReturnSuccess
}

private func fourCC(_ s: String) -> UInt32 {
    var v: UInt32 = 0
    for b in s.utf8.prefix(4) { v = (v << 8) | UInt32(b) }
    return v
}
private func fourCCString(_ v: UInt32) -> String {
    let b = [UInt8((v >> 24) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)]
    return String(bytes: b.map { $0 == 0 ? 32 : $0 }, encoding: .ascii) ?? "????"
}
private func putLE32(_ b: inout [UInt8], _ o: Int, _ v: UInt32) {
    b[o] = UInt8(v & 0xff); b[o+1] = UInt8((v >> 8) & 0xff)
    b[o+2] = UInt8((v >> 16) & 0xff); b[o+3] = UInt8((v >> 24) & 0xff)
}
private func getLE32(_ b: [UInt8], _ o: Int) -> UInt32 {
    UInt32(b[o]) | (UInt32(b[o+1]) << 8) | (UInt32(b[o+2]) << 16) | (UInt32(b[o+3]) << 24)
}
private func getBE32(_ b: [UInt8], _ o: Int) -> UInt32 {
    (UInt32(b[o]) << 24) | (UInt32(b[o+1]) << 16) | (UInt32(b[o+2]) << 8) | UInt32(b[o+3])
}

private func call(_ input: inout [UInt8]) -> [UInt8]? {
    var output = [UInt8](repeating: 0, count: kStructSize)
    var outSize = kStructSize
    let r = input.withUnsafeBytes { inPtr in
        output.withUnsafeMutableBytes { outPtr in
            IOConnectCallStructMethod(conn, kSMCHandleYPCEvent, inPtr.baseAddress, kStructSize,
                                      outPtr.baseAddress, &outSize)
        }
    }
    guard r == kIOReturnSuccess, output[OFF_RESULT] == 0 else { return nil }
    return output
}

private func keyInfo(_ key: UInt32) -> (size: UInt32, type: UInt32)? {
    var input = [UInt8](repeating: 0, count: kStructSize)
    putLE32(&input, OFF_KEY, key)
    input[OFF_DATA8] = kSMCGetKeyInfo
    guard let out = call(&input) else { return nil }
    return (getLE32(out, OFF_DATASIZE), getLE32(out, OFF_DATATYPE))
}
private func keyAtIndex(_ i: UInt32) -> UInt32? {
    var input = [UInt8](repeating: 0, count: kStructSize)
    putLE32(&input, OFF_DATA32, i)
    input[OFF_DATA8] = kSMCGetKeyFromIndex
    guard let out = call(&input) else { return nil }
    return getLE32(out, OFF_KEY)
}
private func readValue(_ key: UInt32, _ size: UInt32, _ type: UInt32) -> Double? {
    var input = [UInt8](repeating: 0, count: kStructSize)
    putLE32(&input, OFF_KEY, key)
    putLE32(&input, OFF_DATASIZE, size)
    input[OFF_DATA8] = kSMCReadKey
    guard let out = call(&input), size >= 1, size <= 32 else { return nil }
    let b = Array(out[OFF_BYTES..<(OFF_BYTES + Int(size))])
    switch fourCCString(type).trimmingCharacters(in: .whitespaces) {
    case "flt":  return b.count >= 4 ? Double(Float(bitPattern: getLE32(b, 0))) : nil
    case "ui8":  return Double(b[0])
    case "ui16": return b.count >= 2 ? Double(UInt16(b[0]) << 8 | UInt16(b[1])) : nil
    case "ui32": return b.count >= 4 ? Double(getBE32(b, 0)) : nil
    case "sp78": return b.count >= 2 ? Double(Int16(bitPattern: UInt16(b[0]) << 8 | UInt16(b[1]))) / 256.0 : nil
    case "fpe2": return b.count >= 2 ? Double(UInt16(b[0]) << 8 | UInt16(b[1])) / 4.0 : nil
    default: return nil
    }
}

// MARK: - Collection

struct Reading { let key: String; let value: Double }

func collect(all: Bool) -> [Reading] {
    guard let ci = keyInfo(fourCC("#KEY")), let count = readValue(fourCC("#KEY"), ci.size, ci.type) else { return [] }
    var out: [Reading] = []
    out.reserveCapacity(Int(count))
    for i in 0..<UInt32(count) {
        guard let k = keyAtIndex(i) else { continue }
        let name = fourCCString(k)
        if !all {
            // Only temperature, fan and power keys are needed.
            let interesting = name.hasPrefix("T") || name.hasPrefix("F") || name == "PSTR"
            if !interesting { continue }
        }
        guard let info = keyInfo(k), let v = readValue(k, info.size, info.type), v.isFinite else { continue }
        out.append(Reading(key: name, value: v))
    }
    return out
}

func plausibleTemps(_ rs: [Reading], prefixes: [String]) -> [Double] {
    rs.filter { r in prefixes.contains { r.key.hasPrefix($0) } }
      .map { $0.value }
      .filter { $0 > 5 && $0 < 130 }   // skip idle or uncalibrated sensors
}
// Rounds to one decimal; NSDecimalNumber avoids output like 55.100000000000001.
func r1(_ v: Double) -> NSDecimalNumber { NSDecimalNumber(string: String(format: "%.1f", v)) }

guard smcOpen() else {
    print(#"{"ok":false,"error":"could not open AppleSMC"}"#)
    exit(1)
}

let wantAll = CommandLine.arguments.contains("--all")
let readings = collect(all: wantAll)
var byKey: [String: Double] = [:]
for r in readings { byKey[r.key] = r.value }

var result: [String: Any] = ["ok": !readings.isEmpty, "sensors": readings.count]

let cpu = plausibleTemps(readings, prefixes: ["Tp", "Te"])
if !cpu.isEmpty {
    result["cpu"] = r1(cpu.reduce(0,+) / Double(cpu.count))
    result["cpuMax"] = r1(cpu.max()!)
}
let gpu = plausibleTemps(readings, prefixes: ["Tg"])
if !gpu.isEmpty { result["gpu"] = r1(gpu.max()!) }

let ssd = plausibleTemps(readings, prefixes: ["TH0"])
if !ssd.isEmpty { result["ssd"] = r1(ssd.max()!) }

if let p = byKey["PSTR"], p > 0 { result["powerWatts"] = r1(p) }

// FNum is the fan count; F<n>Ac is the actual RPM of fan n.
let fanCount = Int(byKey["FNum"] ?? 0)
if fanCount > 0 {
    var fans: [[String: Any]] = []
    for i in 0..<fanCount {
        guard let actual = byKey["F\(i)Ac"] else { continue }
        let mn = byKey["F\(i)Mn"] ?? 0
        let mx = byKey["F\(i)Mx"] ?? 0
        var f: [String: Any] = ["rpm": Int(actual.rounded()), "min": Int(mn), "max": Int(mx)]
        if mx > mn { f["percent"] = Int((((actual - mn) / (mx - mn)) * 100).rounded()) }
        fans.append(f)
    }
    if !fans.isEmpty {
        result["fans"] = fans
        result["fanRpm"] = fans[0]["rpm"]
        if let p = fans[0]["percent"] { result["fanPercent"] = p }
    }
}

if wantAll {
    result["all"] = readings.sorted { $0.value > $1.value }.map { ["key": $0.key, "value": r1($0.value)] }
}

print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
