// Backstage fast lane: clicks and text inserts straight through the macOS accessibility API.
//
// Why: Cua Driver runs every action through one input lane in its daemon (measured: ~0.6 s per click, and two apps
// at the same time take as long as one after the other). The same AXPress sent directly takes 2-4 ms, and two apps
// can be worked at the same time. Cua stays in charge of everything else (reading windows, web typing, keys, pixel
// clicks, launching, the foreground fallback), and of these two actions whenever the fast lane can't do them.
//
// Protocol: one JSON request per line on stdin, one JSON reply per line on stdout (requests run concurrently).
//   {"id":1,"op":"press","pid":123,"x":10,"y":20,"w":40,"h":30,"role":"AXButton","label":"7"}
//   {"id":2,"op":"type", ...same..., "text":"hello"}
//   -> {"id":1,"ok":true,"ms":3.1,"how":"hit-test"}  or  {"id":1,"ok":false,"error":"..."}
// On start it prints {"ready":true,"trusted":true|false}. Not trusted = no Accessibility permission: use Cua.
//
// Safety: an element is only acted on if its role, frame (within 3 points) and label match what the agent saw.
// Text is only inserted into native fields (never inside a web page, where the page wouldn't notice the change),
// and only reported as done if the field's value really changed.
import AppKit
import ApplicationServices

let out = FileHandle.standardOutput
let writeLock = NSLock()
func reply(_ d: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: d) else { return }
  writeLock.lock()
  out.write(data)
  out.write("\n".data(using: .utf8)!)
  writeLock.unlock()
}

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}
func frame(_ e: AXUIElement) -> CGRect? {
  guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
  return CGRect(origin: pt, size: sz)
}
func norm(_ s: String) -> String { s.lowercased().replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces) }

struct Target {
  let pid: pid_t, rect: CGRect, role: String, label: String
  var center: CGPoint { CGPoint(x: rect.midX, y: rect.midY) }

  func matches(_ e: AXUIElement) -> Bool {
    guard attr(e, kAXRoleAttribute) as? String == role, let f = frame(e) else { return false }
    let close = abs(f.minX - rect.minX) <= 3 && abs(f.minY - rect.minY) <= 3 && abs(f.width - rect.width) <= 3 && abs(f.height - rect.height) <= 3
    guard close else { return false }
    let want = norm(label)
    if want.isEmpty { return true }
    for a in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute, "AXPlaceholderValue", kAXIdentifierAttribute] {
      if let v = attr(e, a) as? String {
        let have = norm(v)
        if !have.isEmpty && (have == want || have.contains(want) || want.contains(have)) { return true }
      }
    }
    return false
  }
}

/** the element the agent meant: hit-test at its centre and walk up, else a pruned search of the app's windows */
func locate(_ t: Target) -> (AXUIElement, String)? {
  let app = AXUIElementCreateApplication(t.pid)
  AXUIElementSetMessagingTimeout(app, 1.0)
  var hit: AXUIElement?
  if AXUIElementCopyElementAtPosition(app, Float(t.center.x), Float(t.center.y), &hit) == .success, var e = hit {
    for _ in 0..<8 {
      if t.matches(e) { return (e, "hit-test") }
      guard let p = attr(e, kAXParentAttribute) else { break }
      e = p as! AXUIElement
    }
  }
  // covered by another window of the same app, the hit-test landed on a sibling, or the element is taller than what
  // is visible (a long document's text area): search, descending only into elements that overlap the target
  let start = CFAbsoluteTimeGetCurrent()
  var budget = 5000
  func search(_ e: AXUIElement, _ depth: Int) -> AXUIElement? {
    budget -= 1
    if budget <= 0 || depth > 40 || CFAbsoluteTimeGetCurrent() - start > 0.3 { return nil }
    if t.matches(e) { return e }
    if let f = frame(e), f.width > 0, !f.insetBy(dx: -2, dy: -2).intersects(t.rect) { return nil }
    for c in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { if let found = search(c, depth + 1) { return found } }
    return nil
  }
  for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
    if let found = search(w, 0) { return (found, "search") }
  }
  return nil
}

func insideWebPage(_ e: AXUIElement) -> Bool {
  var cur: AXUIElement? = e
  for _ in 0..<40 {
    guard let c = cur else { return false }
    if attr(c, kAXRoleAttribute) as? String == "AXWebArea" { return true }
    cur = attr(c, kAXParentAttribute).map { $0 as! AXUIElement }
  }
  return false
}

func handle(_ r: [String: Any]) {
  let id = r["id"] ?? 0
  let t0 = CFAbsoluteTimeGetCurrent()
  func done(_ ok: Bool, _ extra: [String: Any] = [:]) {
    var d: [String: Any] = ["id": id, "ok": ok, "ms": ((CFAbsoluteTimeGetCurrent() - t0) * 10000).rounded() / 10]
    for (k, v) in extra { d[k] = v }
    reply(d)
  }
  let op = r["op"] as? String ?? ""
  if op == "ping" { return done(true, ["trusted": AXIsProcessTrusted()]) }
  let num = { (k: String) -> Double in (r[k] as? NSNumber)?.doubleValue ?? 0 }
  guard let pid = (r["pid"] as? NSNumber)?.int32Value, let role = r["role"] as? String else { return done(false, ["error": "bad request"]) }
  let t = Target(pid: pid, rect: CGRect(x: num("x"), y: num("y"), width: num("w"), height: num("h")), role: role, label: r["label"] as? String ?? "")
  guard t.rect.width > 0, t.rect.height > 0 else { return done(false, ["error": "no frame"]) }
  guard let (e, how) = locate(t) else { return done(false, ["error": "element not found where the agent saw it"]) }

  switch op {
  case "press":
    let err = AXUIElementPerformAction(e, kAXPressAction as CFString)
    // -25205 (cannot complete) often comes back although the press happened: the agent's next read decides
    if err == .success || err == .cannotComplete { return done(true, ["how": how, "ax": err.rawValue]) }
    return done(false, ["error": "AXPress refused (\(err.rawValue))"])
  case "type":
    let text = r["text"] as? String ?? ""
    if insideWebPage(e) { return done(false, ["error": "inside a web page: needs key events"]) }
    let before = attr(e, kAXValueAttribute) as? String
    let err = AXUIElementSetAttributeValue(e, kAXSelectedTextAttribute as CFString, text as CFString)
    guard err == .success else { return done(false, ["error": "insert refused (\(err.rawValue))"]) }
    let after = attr(e, kAXValueAttribute) as? String
    // only "done" if the field really changed (some fields accept the write and ignore it)
    if after != nil, after != before, text.isEmpty || after!.contains(text) { return done(true, ["how": how]) }
    return done(false, ["error": "the field did not change"])
  default:
    return done(false, ["error": "unknown op \(op)"])
  }
}

reply(["ready": true, "trusted": AXIsProcessTrusted()])
let work = DispatchQueue(label: "fastlane", attributes: .concurrent)
while let line = readLine() {
  guard let d = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
  work.async { handle(d) }
}
