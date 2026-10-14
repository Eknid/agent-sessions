// Prints the CGWindowID of the first on-screen window whose title contains argv[1].
import CoreGraphics
import Foundation
let needle = CommandLine.arguments.dropFirst().first ?? ""
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  let name = w[kCGWindowName as String] as? String ?? ""
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  if name.contains(needle) || (needle.isEmpty && owner == "Code") {
    print(w[kCGWindowNumber as String] as? Int ?? 0); exit(0)
  }
}
exit(1)
