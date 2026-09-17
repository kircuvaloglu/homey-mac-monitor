// macsession: reports whether a display is on. Prints a single line of JSON.
// The agent runs it inside the logged-in user's session (launchctl asuser),
// because the displays belong to the window server of that session.

import CoreGraphics
import Foundation

func displaysOn() -> Bool? {
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return nil }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetOnlineDisplayList(count, &displays, &count) == .success else { return nil }
    return displays.contains { CGDisplayIsAsleep($0) == 0 }
}

var result: [String: Any] = ["ok": true, "displays": 0]
if let on = displaysOn() {
    result["displayOn"] = on
    var count: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &count)
    result["displays"] = Int(count)
}

let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
