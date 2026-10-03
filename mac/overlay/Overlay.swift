// Backstage Overlay: the on-screen half of Backstage (macOS, AppKit, no dependencies).
//
//  * Control + Option: HOLD to talk (on-device speech recognition), TAP to type in a box at the cursor. The server
//    decides what it was: a job for the agents ("compute 128 times 37 in Calculator") or a question about the screen.
//  * While agents work, each one has a small widget in the bottom-right corner: its colour, app, what it is doing
//    now, its result, and a live preview of the window it works in (ScreenCaptureKit; needs Screen Recording).
//    Every press or text insert flashes a ring in the agent's colour where it happened.
//    The moment the keys go down, the server is told to capture the screen (so this app's own windows are not in it).
//  * A small buddy follows the cursor (35 px to the right). It shows listening / thinking / the answer, and flies to
//    the thing it is explaining.
//  * Click-through, transparent windows over every screen draw what the server sends: rings, boxes, circles,
//    underlines, arrows and labels, which draw themselves in and fade away (a lesson step stays until "next").
//  * Answers are spoken in the language they are written in.
//  * Keys: Esc stops the voice (press it again to clear the drawings); Option + → / ← move through a lesson
//    (Control + Option alone stays the talk / type key).
//    They are global hotkeys (no permission needed), registered only while they mean something, so the rest of the
//    time Esc and the arrows belong to your apps.
//  * All of this app's windows are excluded from screen captures (sharingType = .none).
//
// It talks to the Backstage server over a local WebSocket (ws://127.0.0.1:3000-3009/overlay). Build: scripts/build-overlay.sh
import AppKit
import AVFoundation
import Carbon.HIToolbox
import ScreenCaptureKit
import NaturalLanguage
import Speech

// MARK: - look

let MINT = NSColor(srgbRed: 0.20, green: 0.83, blue: 0.60, alpha: 1)
let CORAL = NSColor(srgbRed: 1.00, green: 0.42, blue: 0.42, alpha: 1)
let INK = NSColor(srgbRed: 0.06, green: 0.09, blue: 0.16, alpha: 0.94)
let OFFSET = CGPoint(x: 35, y: 8) // the buddy sits this far right of / below the cursor
/** recording mode (--record): screen recordings show the cursors, widgets and drawings (normally this app's windows
 *  are never captured). Explain mode's own screenshot still sees a clean screen: the overlay hides for that instant */
let RECORDING = CommandLine.arguments.contains("--record") || CommandLine.arguments.contains("--visible-in-captures")
let SHARING: NSWindow.SharingType = RECORDING ? .readOnly : .none

// MARK: - geometry: the server speaks GLOBAL points, origin top-left of the main display (like Cua's frames)

func primaryHeight() -> CGFloat { NSScreen.screens.first?.frame.height ?? 0 }
func cocoa(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: primaryHeight() - p.y) }
func topLeft(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: primaryHeight() - p.y) }

struct Shape {
  var kind: String
  var rect: CGRect = .zero
  var from: CGPoint = .zero
  var to: CGPoint = .zero
  var text: String = ""

  init?(_ d: [String: Any]) {
    guard let k = d["kind"] as? String else { return nil }
    kind = k
    func n(_ key: String) -> CGFloat? { (d[key] as? NSNumber).map { CGFloat(truncating: $0) } }
    func pt(_ key: String) -> CGPoint? {
      guard let o = d[key] as? [String: Any], let x = o["x"] as? NSNumber, let y = o["y"] as? NSNumber else { return nil }
      return CGPoint(x: CGFloat(truncating: x), y: CGFloat(truncating: y))
    }
    if let x = n("x"), let y = n("y") { rect = CGRect(x: x, y: y, width: n("w") ?? 0, height: n("h") ?? 0) }
    from = pt("from") ?? .zero
    to = pt("to") ?? .zero
    text = d["text"] as? String ?? ""
  }

  /** where the buddy flies to: just right of the thing */
  var anchor: CGPoint {
    switch kind {
    case "arrow": return CGPoint(x: to.x + 14, y: to.y + 10)
    case "label": return CGPoint(x: rect.minX + 14, y: rect.minY + 14)
    default: return CGPoint(x: rect.maxX + 10, y: rect.midY)
    }
  }
}

// MARK: - drawing layer (one click-through window per screen)

final class DrawView: NSView {
  var items: [(shape: Shape, born: CFTimeInterval)] = []
  var origin: CGPoint = .zero // this screen's top-left, in global top-left points
  override var isFlipped: Bool { true }

  var animating: Bool { items.contains { CACurrentMediaTime() - $0.born < 0.9 } }

  override func draw(_ dirty: NSRect) {
    NSColor.clear.setFill()
    dirty.fill(using: .copy)
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    ctx.saveGState()
    ctx.translateBy(x: -origin.x, y: -origin.y)
    let now = CACurrentMediaTime()
    for (i, it) in items.enumerated() {
      // shapes draw themselves in one after another
      let t = max(0, now - it.born - Double(i) * 0.12)
      draw(it.shape, CGFloat(min(1, t / 0.45)))
    }
    ctx.restoreGState()
  }

  private func glow(_ c: NSColor = MINT) {
    let s = NSShadow()
    s.shadowColor = c.withAlphaComponent(0.85)
    s.shadowBlurRadius = 10
    s.shadowOffset = .zero
    s.set()
  }

  private func stroke(_ path: NSBezierPath, length: CGFloat, _ p: CGFloat, width: CGFloat = 3.5) {
    NSGraphicsContext.saveGraphicsState()
    glow()
    MINT.setStroke()
    path.lineWidth = width
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    if p < 1 { path.setLineDash([max(0.1, length * p), length * 2], count: 2, phase: 0) }
    path.stroke()
    NSGraphicsContext.restoreGraphicsState()
  }

  private func label(_ text: String, at p: CGPoint, below: Bool = false, right: Bool = false, alpha: CGFloat) {
    guard !text.isEmpty, alpha > 0 else { return }
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 14, weight: .semibold), .foregroundColor: NSColor.white.withAlphaComponent(alpha)]
    let s = NSAttributedString(string: text, attributes: attrs)
    let size = s.boundingRect(with: CGSize(width: 260, height: 200), options: [.usesLineFragmentOrigin]).size
    // below: centred under p · right: to the right of p, vertically centred (beside a line of text) · else: above-right
    var r = right
      ? CGRect(x: p.x + 10, y: p.y - (size.height + 10) / 2, width: size.width + 18, height: size.height + 10)
      : CGRect(x: p.x - (below ? size.width / 2 + 9 : -10), y: below ? p.y + 8 : p.y - size.height - 20, width: size.width + 18, height: size.height + 10)
    let screen = CGRect(origin: origin, size: bounds.size)
    r.origin.x = min(max(r.minX, screen.minX + 4), screen.maxX - r.width - 4)
    r.origin.y = min(max(r.minY, screen.minY + 4), screen.maxY - r.height - 4)
    let bubble = NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8)
    INK.withAlphaComponent(0.94 * alpha).setFill()
    bubble.fill()
    MINT.withAlphaComponent(alpha).setStroke()
    bubble.lineWidth = 1.5
    bubble.stroke()
    s.draw(with: r.insetBy(dx: 9, dy: 5), options: [.usesLineFragmentOrigin])
  }

  private func draw(_ s: Shape, _ p: CGFloat) {
    let textAlpha = max(0, min(1, (p - 0.6) / 0.4))
    switch s.kind {
    case "ring", "box":
      let r = s.rect.insetBy(dx: s.kind == "ring" ? -6 : -3, dy: s.kind == "ring" ? -6 : -3)
      let path = NSBezierPath(roundedRect: r, xRadius: s.kind == "ring" ? min(12, r.height / 2) : 4, yRadius: s.kind == "ring" ? min(12, r.height / 2) : 4)
      stroke(path, length: 2 * (r.width + r.height), p)
      label(s.text, at: CGPoint(x: r.midX, y: r.maxY), below: true, alpha: textAlpha)
    case "circle":
      let r = s.rect.insetBy(dx: -max(10, s.rect.width * 0.12), dy: -max(10, s.rect.height * 0.25))
      stroke(NSBezierPath(ovalIn: r), length: .pi * (r.width + r.height) / 2, p)
      label(s.text, at: CGPoint(x: r.midX, y: r.maxY), below: true, alpha: textAlpha)
    case "underline":
      let y = s.rect.maxY + 3
      let path = NSBezierPath()
      path.move(to: CGPoint(x: s.rect.minX, y: y))
      path.curve(to: CGPoint(x: s.rect.maxX, y: y), controlPoint1: CGPoint(x: s.rect.minX + s.rect.width * 0.33, y: y + 3), controlPoint2: CGPoint(x: s.rect.minX + s.rect.width * 0.66, y: y - 2))
      stroke(path, length: s.rect.width, p, width: 4)
      label(s.text, at: CGPoint(x: s.rect.maxX, y: s.rect.midY), right: true, alpha: textAlpha) // beside the line, never over the next one
    case "arrow":
      let a = s.from, b = s.to
      let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
      let len = hypot(b.x - a.x, b.y - a.y)
      let c = CGPoint(x: mid.x - (b.y - a.y) * 0.22, y: mid.y + (b.x - a.x) * 0.22) // a gentle curve
      let path = NSBezierPath()
      path.move(to: a)
      path.curve(to: b, controlPoint1: c, controlPoint2: c)
      stroke(path, length: len * 1.1, p)
      if p > 0.85 {
        let ang = atan2(b.y - c.y, b.x - c.x)
        let head = NSBezierPath()
        for d in [CGFloat.pi * 0.84, -CGFloat.pi * 0.84] {
          head.move(to: b)
          head.line(to: CGPoint(x: b.x + 16 * cos(ang + d), y: b.y + 16 * sin(ang + d)))
        }
        stroke(head, length: 40, 1)
      }
      label(s.text, at: a, alpha: textAlpha)
    case "label":
      if p > 0 {
        NSGraphicsContext.saveGraphicsState()
        glow()
        MINT.setFill()
        NSBezierPath(ovalIn: CGRect(x: s.rect.minX - 5, y: s.rect.minY - 5, width: 10, height: 10)).fill()
        NSGraphicsContext.restoreGraphicsState()
      }
      label(s.text, at: CGPoint(x: s.rect.minX, y: s.rect.minY), alpha: min(1, p * 1.5))
    default: break
    }
  }
}

final class Canvas {
  private var layers: [(window: NSWindow, view: DrawView)] = []
  private var timer: Timer?
  private var fadeAt: CFTimeInterval?

  init() {
    build()
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.build() }
  }

  private func build() {
    for l in layers { l.window.orderOut(nil) }
    layers = NSScreen.screens.map { screen in
      let w = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
      w.isOpaque = false
      w.backgroundColor = .clear
      w.hasShadow = false
      w.ignoresMouseEvents = true
      w.level = .screenSaver
      w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
      w.sharingType = SHARING // never in a screenshot
      let v = DrawView(frame: CGRect(origin: .zero, size: screen.frame.size))
      v.origin = CGPoint(x: screen.frame.minX, y: primaryHeight() - screen.frame.maxY)
      w.contentView = v
      w.orderFrontRegardless()
      return (w, v)
    }
  }

  func show(_ shapes: [Shape], fadeMs: Double) {
    let now = CACurrentMediaTime()
    for l in layers {
      l.window.alphaValue = 1
      l.view.items = shapes.map { ($0, now) }
      l.view.needsDisplay = true
    }
    fadeAt = fadeMs > 0 && !shapes.isEmpty ? now + fadeMs / 1000 : nil
    tick()
  }

  func clear() {
    fadeAt = nil
    for l in layers { l.view.items = []; l.view.needsDisplay = true; l.window.alphaValue = 1 }
  }

  private func tick() {
    timer?.invalidate()
    timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] t in
      guard let self else { t.invalidate(); return }
      var busy = false
      for l in self.layers where l.view.animating { l.view.needsDisplay = true; busy = true }
      if let f = self.fadeAt {
        let left = f - CACurrentMediaTime()
        if left <= 0 { self.clear() } else {
          busy = true
          if left < 0.6 { for l in self.layers { l.window.alphaValue = CGFloat(left / 0.6) } }
        }
      }
      if !busy { t.invalidate() }
    }
    RunLoop.main.add(timer!, forMode: .common)
  }
}

// MARK: - where the agents act: a quick ring in the agent's colour on each press / text insert

/** one agent's cursor: glides from where it was to where the agent acts, then a ripple there */
struct AgentCursor {
  var name: String
  var colour: NSColor
  var from: CGPoint
  var to: CGPoint
  var start: CFTimeInterval
  var last: CFTimeInterval // last action (the cursor fades a few seconds after the agent stops)
  static let glide = 0.32
  func position(_ now: CFTimeInterval) -> CGPoint {
    let k = min(1, max(0, (now - start) / AgentCursor.glide))
    let e = 1 - pow(1 - k, 3) // ease-out
    // a slight arc, like a hand moving
    let mid = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - min(80, hypot(to.x - from.x, to.y - from.y) * 0.15))
    let a = CGPoint(x: from.x + (mid.x - from.x) * e, y: from.y + (mid.y - from.y) * e)
    let b = CGPoint(x: mid.x + (to.x - mid.x) * e, y: mid.y + (to.y - mid.y) * e)
    return CGPoint(x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e)
  }
}

final class PulseView: NSView {
  var items: [(rect: CGRect, colour: NSColor, born: CFTimeInterval)] = []
  var cursors: [String: AgentCursor] = [:]
  var origin = CGPoint.zero // this screen's top-left in global top-left coordinates
  override var isFlipped: Bool { true }
  static let life = 0.7
  static let linger = 4.0 // seconds a cursor stays after its agent's last action

  override func draw(_ dirty: NSRect) {
    NSColor.clear.setFill()
    dirty.fill(using: .copy)
    let now = CACurrentMediaTime()
    for p in items where now >= p.born {
      let k = min(1, (now - p.born) / PulseView.life) // 0 → 1
      let grow = CGFloat(2 + 10 * k)
      let r = p.rect.offsetBy(dx: -origin.x, dy: -origin.y).insetBy(dx: -grow, dy: -grow)
      let path = NSBezierPath(roundedRect: r, xRadius: min(12, r.height / 2), yRadius: min(12, r.height / 2))
      path.lineWidth = 3
      NSGraphicsContext.saveGraphicsState()
      let sh = NSShadow(); sh.shadowColor = p.colour; sh.shadowBlurRadius = 8; sh.shadowOffset = .zero; sh.set()
      p.colour.withAlphaComponent(0.95 * (1 - k)).setStroke()
      path.stroke()
      NSGraphicsContext.restoreGraphicsState()
    }
    for c in cursors.values {
      let idle = now - c.last
      let alpha = idle < PulseView.linger ? 1 : max(0, 1 - (idle - PulseView.linger) / 0.6)
      guard alpha > 0 else { continue }
      let p = c.position(now)
      drawCursor(at: CGPoint(x: p.x - origin.x, y: p.y - origin.y), c.colour, c.name, CGFloat(alpha))
    }
  }

  /** an arrow pointer in the agent's colour, white outline, with its name in a pill */
  private func drawCursor(at p: CGPoint, _ colour: NSColor, _ name: String, _ alpha: CGFloat) {
    let arrow = NSBezierPath()
    let pts: [(CGFloat, CGFloat)] = [(0, 0), (0, 22), (6, 16.5), (10.5, 26), (14.5, 24.2), (10.2, 15), (17.5, 15)]
    arrow.move(to: CGPoint(x: p.x + pts[0].0, y: p.y + pts[0].1))
    for q in pts.dropFirst() { arrow.line(to: CGPoint(x: p.x + q.0, y: p.y + q.1)) }
    arrow.close()
    NSGraphicsContext.saveGraphicsState()
    let sh = NSShadow(); sh.shadowColor = NSColor.black.withAlphaComponent(0.45 * alpha); sh.shadowBlurRadius = 6; sh.shadowOffset = NSSize(width: 0, height: -2); sh.set()
    colour.withAlphaComponent(alpha).setFill(); arrow.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSColor.white.withAlphaComponent(alpha).setStroke(); arrow.lineWidth = 1.6; arrow.stroke()
    let font = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
    let text = NSAttributedString(string: name, attributes: [.font: font, .foregroundColor: NSColor.white.withAlphaComponent(alpha)])
    let size = text.size()
    let pill = CGRect(x: p.x + 16, y: p.y + 22, width: size.width + 14, height: size.height + 6)
    let path = NSBezierPath(roundedRect: pill, xRadius: pill.height / 2, yRadius: pill.height / 2)
    colour.withAlphaComponent(0.92 * alpha).setFill(); path.fill()
    text.draw(at: CGPoint(x: pill.minX + 7, y: pill.minY + 3))
  }
}

final class Pulses {
  private var layers: [(window: NSWindow, view: PulseView)] = []
  private var timer: Timer?
  private var cursors: [String: AgentCursor] = [:]

  init() {
    build()
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.build() }
  }

  private func build() {
    for l in layers { l.window.orderOut(nil) }
    layers = NSScreen.screens.map { screen in
      let w = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
      w.isOpaque = false
      w.backgroundColor = .clear
      w.hasShadow = false
      w.ignoresMouseEvents = true
      w.level = .floating
      w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
      w.sharingType = SHARING // never in a screenshot (the agents' reads and explain mode never see it)
      let v = PulseView(frame: CGRect(origin: .zero, size: screen.frame.size))
      v.origin = CGPoint(x: screen.frame.minX, y: primaryHeight() - screen.frame.maxY)
      w.contentView = v
      w.orderFrontRegardless()
      return (w, v)
    }
  }

  /** the cursor layer's windows (one per screen): the previews composite them over each agent's window */
  var windowIDs: [UInt32] { layers.map { UInt32($0.window.windowNumber) } }

  /** an agent acted at `rect`: its cursor glides there, and a ring ripples when it arrives */
  func flash(_ rect: CGRect, _ colour: NSColor, agent: String = "") {
    let now = CACurrentMediaTime()
    let target = CGPoint(x: rect.midX, y: rect.midY)
    var arrive = now
    if !agent.isEmpty {
      let from: CGPoint
      if let c = cursors[agent] { from = c.position(now) } else { from = CGPoint(x: target.x - 120, y: target.y + 90) } // enters from the lower left
      cursors[agent] = AgentCursor(name: agent, colour: colour, from: from, to: target, start: now, last: now)
      arrive = now + AgentCursor.glide
    }
    for l in layers { l.view.items.append((rect, colour, arrive)); l.view.cursors = cursors; l.window.orderFrontRegardless() }
    guard timer == nil else { return }
    let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] t in
      guard let self else { t.invalidate(); return }
      let now = CACurrentMediaTime()
      self.cursors = self.cursors.filter { now - $0.value.last < PulseView.linger + 0.7 }
      for l in self.layers {
        l.view.items.removeAll { now - $0.born > PulseView.life }
        l.view.cursors = self.cursors
        l.view.needsDisplay = true
      }
      if self.cursors.isEmpty && self.layers.allSatisfy({ $0.view.items.isEmpty }) { t.invalidate(); self.timer = nil }
    }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }
}

// MARK: - the agents' widgets (bottom right), each with a live preview of the window the agent works in

struct AgentCard {
  var id = "", name = "", app = "", goal = "", status = "queued", now = "", answer = "", reason = ""
  var colour = MINT
  var seconds = 0.0
  var windowId: UInt32 = 0
  var startedAt: CFTimeInterval? // when this overlay first saw it running (the clock ticks between server updates)
}

func colour(hex: String) -> NSColor {
  var v: UInt64 = 0
  Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
  return NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}

/** live pictures of the agents' windows (ScreenCaptureKit: works for covered windows; needs Screen Recording) */
final class Previews {
  private var content: SCShareableContent?
  private var contentAt: CFTimeInterval = 0
  private var busy = Set<UInt32>()
  private var asked = false
  var allowed: Bool { CGPreflightScreenCaptureAccess() }

  /** macOS asks once: System Settings › Privacy & Security › Screen Recording › Backstage Overlay */
  func askOnce() {
    guard !asked, !allowed else { return }
    asked = true
    CGRequestScreenCaptureAccess()
  }

  /** the windows composited over each agent's window in its preview (the cursor layer, in recording mode) */
  var overlayIDs: () -> [UInt32] = { [] }

  func capture(_ id: UInt32, width: CGFloat, done: @escaping (NSImage?) -> Void) {
    guard id != 0, allowed, !busy.contains(id) else { return }
    guard #available(macOS 14.0, *) else { return }
    busy.insert(id)
    let cached = CACurrentMediaTime() - contentAt < 3 ? content : nil
    let extras = RECORDING ? Set(overlayIDs()) : [] // our windows can only be captured in recording mode
    Task.detached {
      var list = cached
      if list == nil { list = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
      var image: NSImage?
      if let w = list?.windows.first(where: { $0.windowID == id }), w.frame.width > 0 {
        let cfg = SCStreamConfiguration()
        let scale: CGFloat = 2
        cfg.width = Int(width * scale)
        cfg.height = Int(width * scale * w.frame.height / w.frame.width)
        cfg.showsCursor = false
        // the agent's window with the agents' cursors on top (other apps' windows left out, so a covered window
        // still shows), cropped to the window; without the cursor layer, just the window
        var filter = SCContentFilter(desktopIndependentWindow: w)
        let layer = (list?.windows ?? []).filter { extras.contains($0.windowID) }
        if !layer.isEmpty, let d = list?.displays.first(where: { $0.frame.intersects(w.frame) }) {
          filter = SCContentFilter(display: d, including: [w] + layer)
          cfg.sourceRect = CGRect(x: w.frame.minX - d.frame.minX, y: w.frame.minY - d.frame.minY, width: w.frame.width, height: w.frame.height)
        }
        if let cg = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) {
          image = NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / scale, height: CGFloat(cg.height) / scale))
        }
      }
      DispatchQueue.main.async {
        if cached == nil, let list { self.content = list; self.contentAt = CACurrentMediaTime() }
        self.busy.remove(id)
        done(image)
      }
    }
  }
}

final class DockView: NSView {
  var cards: [AgentCard] = []
  var thumbs: [UInt32: NSImage] = [:]
  var showPreviews = true
  var previewsAllowed = true
  var columns = 1
  var thumbH: CGFloat = 0
  override var isFlipped: Bool { true }
  static let W: CGFloat = 300, TEXT_H: CGFloat = 70, GAP: CGFloat = 8
  var cardH: CGFloat { DockView.TEXT_H + (thumbH > 0 ? thumbH + 8 : 0) }

  /** where card i goes: rows fill left to right, the grid hugs the bottom-right corner */
  func rect(_ i: Int) -> CGRect {
    CGRect(x: CGFloat(i % columns) * (DockView.W + DockView.GAP), y: CGFloat(i / columns) * (cardH + DockView.GAP), width: DockView.W, height: cardH)
  }

  override func draw(_ dirty: NSRect) {
    NSColor.clear.setFill()
    dirty.fill(using: .copy)
    let t = CACurrentMediaTime()
    for (i, c) in cards.enumerated() {
      let r = rect(i)
      let accent = c.status == "failed" ? CORAL : c.colour
      let card = NSBezierPath(roundedRect: r.insetBy(dx: 1, dy: 1), xRadius: 12, yRadius: 12)
      INK.setFill(); card.fill()
      accent.withAlphaComponent(0.85).setStroke(); card.lineWidth = 1.2; card.stroke()

      // the agent's colour dot: breathing while it works
      let running = c.status == "running"
      let d: CGFloat = running ? 10 + 2.5 * CGFloat(sin(t * 5)) : 10
      let dot = CGRect(x: r.minX + 18 - d / 2, y: r.minY + 18 - d / 2, width: d, height: d)
      NSGraphicsContext.saveGraphicsState()
      let sh = NSShadow(); sh.shadowColor = c.colour; sh.shadowBlurRadius = running ? 8 : 3; sh.shadowOffset = .zero; sh.set()
      c.colour.setFill(); NSBezierPath(ovalIn: dot).fill()
      NSGraphicsContext.restoreGraphicsState()

      let white = NSColor.white, dim = NSColor.white.withAlphaComponent(0.55)
      let bold = NSFont.systemFont(ofSize: 13, weight: .semibold), small = NSFont.systemFont(ofSize: 11.5), mono = NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
      let title = NSMutableAttributedString(string: c.name, attributes: [.font: bold, .foregroundColor: white])
      title.append(NSAttributedString(string: "  ·  \(c.app)", attributes: [.font: small, .foregroundColor: dim]))
      title.draw(at: CGPoint(x: r.minX + 30, y: r.minY + 9))

      let secs = running ? (c.startedAt.map { t - $0 } ?? c.seconds) : c.seconds
      let badge: String
      switch c.status {
      case "running": badge = String(format: "%.0f s", secs)
      case "done": badge = String(format: "✓  %.1f s", secs)
      case "failed": badge = "✕  stopped"
      default: badge = "waiting"
      }
      let b = NSAttributedString(string: badge, attributes: [.font: mono, .foregroundColor: c.status == "done" ? MINT : c.status == "failed" ? CORAL : dim])
      b.draw(at: CGPoint(x: r.maxX - 14 - b.size().width, y: r.minY + 10))

      let line = { (text: String, y: CGFloat, colour: NSColor) in
        let p = NSMutableParagraphStyle(); p.lineBreakMode = .byTruncatingTail
        NSAttributedString(string: text, attributes: [.font: small, .foregroundColor: colour, .paragraphStyle: p])
          .draw(in: CGRect(x: r.minX + 14, y: r.minY + y, width: r.width - 28, height: 16))
      }
      line(c.goal, 30, dim)
      let now = c.status == "done" ? (c.answer.isEmpty ? "Done" : "→ \(c.answer)") : c.status == "failed" ? (c.reason.isEmpty ? "Couldn't finish" : c.reason) : (c.now.isEmpty ? (running ? "working" + String(repeating: ".", count: Int(t * 3) % 4) : "waiting for its turn") : c.now)
      line(now, 47, c.status == "done" ? white : c.status == "failed" ? CORAL : white.withAlphaComponent(0.85))

      // the live preview of the agent's window
      guard thumbH > 0 else { continue }
      let box = CGRect(x: r.minX + 10, y: r.minY + DockView.TEXT_H, width: r.width - 20, height: thumbH)
      NSGraphicsContext.saveGraphicsState()
      NSBezierPath(roundedRect: box, xRadius: 8, yRadius: 8).addClip()
      NSColor.black.withAlphaComponent(0.45).setFill(); box.fill()
      if let img = thumbs[c.windowId] {
        // fit the whole window in the box, centred
        let k = min(box.width / img.size.width, box.height / img.size.height)
        let size = CGSize(width: img.size.width * k, height: img.size.height * k)
        let at = CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height)
        img.draw(in: at, from: .zero, operation: .sourceOver, fraction: c.status == "running" ? 1 : 0.85, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
      } else {
        let msg = previewsAllowed ? (c.windowId == 0 ? "opening the window…" : "") : "allow Screen Recording for Backstage Overlay to see this window"
        let p = NSMutableParagraphStyle(); p.alignment = .center
        NSAttributedString(string: msg, attributes: [.font: small, .foregroundColor: dim, .paragraphStyle: p])
          .draw(with: box.insetBy(dx: 16, dy: box.height / 2 - 16), options: [.usesLineFragmentOrigin])
      }
      NSGraphicsContext.restoreGraphicsState()
      accent.withAlphaComponent(0.35).setStroke()
      let frameLine = NSBezierPath(roundedRect: box, xRadius: 8, yRadius: 8); frameLine.lineWidth = 1; frameLine.stroke()
    }
  }
}

final class Dock {
  private let window: NSWindow
  private let view = DockView()
  private let previews = Previews()
  private var runId = ""
  private var timer: Timer?
  private var hideAt: CFTimeInterval?
  private var shotAt: [UInt32: CFTimeInterval] = [:]
  private var finalShot = Set<UInt32>()
  func askForPreviews() { previews.askOnce() }
  func composite(_ ids: @escaping () -> [UInt32]) { previews.overlayIDs = ids }
  var showPreviews: Bool {
    get { view.showPreviews }
    set { view.showPreviews = newValue; if !view.cards.isEmpty { layout() } }
  }

  init() {
    window = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true // never in the way of a click
    window.level = .statusBar
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    window.sharingType = SHARING
    window.contentView = view
  }

  /** the server's view of the latest run: {runId, running, tasks: [...]} */
  func update(_ m: [String: Any]) {
    let id = m["runId"] as? String ?? ""
    let running = m["running"] as? Bool ?? false
    let tasks = m["tasks"] as? [[String: Any]] ?? []
    if id != runId {
      runId = id
      view.cards = []
      view.thumbs = [:]
      shotAt = [:]
      finalShot = []
      if !running { hide(); return } // a run that was already over when we connected isn't shown again
    }
    let old = Dictionary(uniqueKeysWithValues: view.cards.map { ($0.id, $0) })
    view.cards = tasks.map { d in
      var c = AgentCard()
      c.id = d["id"] as? String ?? ""
      c.name = d["name"] as? String ?? "Agent"
      c.app = d["app"] as? String ?? ""
      c.goal = d["goal"] as? String ?? ""
      c.status = d["status"] as? String ?? "queued"
      c.now = d["now"] as? String ?? ""
      c.answer = (d["answer"] as? String ?? "").replacingOccurrences(of: "\n", with: " ")
      c.reason = d["reason"] as? String ?? ""
      c.colour = colour(hex: d["colour"] as? String ?? "#2bb39a")
      c.seconds = (d["seconds"] as? NSNumber)?.doubleValue ?? 0
      c.windowId = (d["windowId"] as? NSNumber)?.uint32Value ?? 0
      c.startedAt = old[c.id]?.startedAt ?? (c.status == "running" ? CACurrentMediaTime() - c.seconds : nil)
      return c
    }
    if view.cards.isEmpty { hide(); return }
    layout()
    hideAt = running ? nil : CACurrentMediaTime() + 20 // results stay readable, then the widgets go
    window.alphaValue = 1
    window.orderFrontRegardless()
    start()
  }

  /** a grid in the bottom-right corner: 1 column for up to 3 agents, then 2, then 3; previews shrink to fit */
  private func layout() {
    guard let screen = NSScreen.screens.first else { return }
    let vf = screen.visibleFrame // above the Dock, below the menu bar
    let n = view.cards.count
    view.columns = n <= 3 ? 1 : n <= 6 ? 2 : 3
    let rows = Int(ceil(Double(n) / Double(view.columns)))
    let room = (vf.height - 32 - CGFloat(rows - 1) * DockView.GAP) / CGFloat(rows) - DockView.TEXT_H - 8
    view.thumbH = view.showPreviews ? min(165, room) : 0
    if view.thumbH < 60 { view.thumbH = 0 }
    let w = CGFloat(view.columns) * DockView.W + CGFloat(view.columns - 1) * DockView.GAP
    let h = CGFloat(rows) * view.cardH + CGFloat(rows - 1) * DockView.GAP
    window.setFrame(CGRect(x: vf.maxX - w - 16, y: vf.minY + 16, width: w, height: h), display: true)
    view.frame = CGRect(origin: .zero, size: window.frame.size)
    view.needsDisplay = true
  }

  private func hide() {
    timer?.invalidate(); timer = nil
    hideAt = nil
    view.cards = []
    view.thumbs = [:]
    window.orderOut(nil)
  }

  /** a fresh picture of each working agent's window about once a second, and a last one when it finishes */
  private func refreshPreviews() {
    guard view.thumbH > 0 else { return }
    view.previewsAllowed = previews.allowed
    let now = CACurrentMediaTime()
    for c in view.cards where c.windowId != 0 {
      let finished = c.status == "done" || c.status == "failed"
      if finished && finalShot.contains(c.windowId) { continue }
      if now - (shotAt[c.windowId] ?? 0) < (finished ? 0.3 : RECORDING ? 0.35 : 1.0) { continue }
      shotAt[c.windowId] = now
      if finished { finalShot.insert(c.windowId) }
      let id = c.windowId
      previews.capture(id, width: DockView.W - 20) { [weak self] img in
        guard let self, let img else { return }
        self.view.thumbs[id] = img
        self.view.needsDisplay = true
      }
    }
  }

  private func start() {
    guard timer == nil else { return }
    let t = Timer(timeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
      guard let self else { return }
      if let h = self.hideAt {
        let left = h - CACurrentMediaTime()
        if left <= 0 { self.hide(); return }
        if left < 1 { self.window.alphaValue = left } // fade out over the last second
      }
      self.refreshPreviews()
      self.view.needsDisplay = true
    }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }
}

// MARK: - the buddy next to the cursor

final class BuddyView: NSView {
  var state = "idle" // idle | listening | thinking | answer | error
  var text = ""
  override var isFlipped: Bool { true }

  static let font = NSFont.systemFont(ofSize: 13.5, weight: .medium)
  static func bubbleSize(_ text: String) -> CGSize {
    guard !text.isEmpty else { return .zero }
    let s = NSAttributedString(string: text, attributes: [.font: font])
    let r = s.boundingRect(with: CGSize(width: 300, height: 400), options: [.usesLineFragmentOrigin])
    return CGSize(width: ceil(r.width) + 22, height: ceil(r.height) + 14)
  }

  override func draw(_ dirty: NSRect) {
    NSColor.clear.setFill()
    dirty.fill(using: .copy)
    let t = CACurrentMediaTime()
    let pulse = state == "listening" ? 1 + 0.25 * sin(t * 8) : 1
    let colour = state == "listening" ? CORAL : state == "error" ? CORAL : MINT
    let d = 12 * pulse
    let dot = CGRect(x: 14 - d / 2, y: 14 - d / 2, width: d, height: d)
    NSGraphicsContext.saveGraphicsState()
    let sh = NSShadow(); sh.shadowColor = colour.withAlphaComponent(0.9); sh.shadowBlurRadius = 8; sh.shadowOffset = .zero; sh.set()
    colour.withAlphaComponent(state == "idle" ? 0.75 : 1).setFill()
    NSBezierPath(ovalIn: dot).fill()
    NSGraphicsContext.restoreGraphicsState()
    NSColor.white.withAlphaComponent(0.9).setStroke()
    let ring = NSBezierPath(ovalIn: dot); ring.lineWidth = 1.5; ring.stroke()

    var shown = text
    if state == "thinking" { shown = text + String(repeating: ".", count: Int(t * 3) % 4) }
    let size = BuddyView.bubbleSize(shown)
    guard size != .zero else { return }
    let r = CGRect(x: 28, y: 4, width: size.width, height: size.height)
    let b = NSBezierPath(roundedRect: r, xRadius: 10, yRadius: 10)
    INK.setFill(); b.fill()
    colour.withAlphaComponent(0.9).setStroke(); b.lineWidth = 1.2; b.stroke()
    NSAttributedString(string: shown, attributes: [.font: BuddyView.font, .foregroundColor: NSColor.white]).draw(with: r.insetBy(dx: 11, dy: 7), options: [.usesLineFragmentOrigin])
  }
}

final class Buddy {
  let window: NSPanel
  let view = BuddyView()
  var following = true
  var hiddenWhenIdle = false
  private var flyTarget: CGPoint? // global top-left point

  init() {
    window = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 40, height: 40), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.level = .screenSaver
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    window.sharingType = SHARING
    window.contentView = view
    window.orderFrontRegardless()
  }

  func set(_ state: String, _ text: String = "") {
    view.state = state
    view.text = text
    layout()
    view.needsDisplay = true
  }

  private var size: CGSize {
    let b = BuddyView.bubbleSize(view.state == "thinking" ? view.text + "..." : view.text)
    return CGSize(width: max(30, 30 + b.width + 4), height: max(30, b.height + 10))
  }

  /** the dot's centre goes to `p` (global top-left point) */
  private func frame(dotAt p: CGPoint) -> CGRect {
    let s = size
    let c = cocoa(p)
    return CGRect(x: c.x - 14, y: c.y + 14 - s.height, width: s.width, height: s.height)
  }

  func layout() {
    let target = flyTarget ?? { let m = topLeft(NSEvent.mouseLocation); return CGPoint(x: m.x + OFFSET.x, y: m.y + OFFSET.y) }()
    window.setFrame(frame(dotAt: target), display: true)
  }

  func fly(to p: CGPoint) {
    flyTarget = p
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.55
      ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      window.animator().setFrame(frame(dotAt: p), display: true)
    }
  }

  func home() { flyTarget = nil }

  /** called 60 times a second */
  func tick() {
    window.alphaValue = hiddenWhenIdle && view.state == "idle" ? 0 : 1
    if flyTarget == nil { layout() }
    if view.state == "listening" || view.state == "thinking" { view.needsDisplay = true }
  }
}

// MARK: - voice in (on-device speech recognition), voice out

final class Listener {
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private(set) var text = ""
  private var finished: ((String) -> Void)?

  static func askPermission() {
    SFSpeechRecognizer.requestAuthorization { _ in }
    AVCaptureDevice.requestAccess(for: .audio) { _ in }
  }

  var ready: Bool {
    SFSpeechRecognizer.authorizationStatus() == .authorized && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized && (recognizer?.isAvailable ?? false)
  }

  func start(partial: @escaping (String) -> Void) -> Bool {
    guard ready, let recognizer else { return false }
    text = ""
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true } // nothing leaves the Mac
    request = req
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.channelCount > 0 else { return false }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in self?.request?.append(buf) }
    engine.prepare()
    do { try engine.start() } catch { return false }
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      guard let self else { return }
      if let r = result {
        self.text = r.bestTranscription.formattedString
        DispatchQueue.main.async { partial(self.text) }
      }
      if error != nil || (result?.isFinal ?? false) {
        DispatchQueue.main.async { self.finish() }
      }
    }
    return true
  }

  /** stop listening; `done` gets the final text (or what was heard so far, after at most 1.2 s) */
  func stop(_ done: @escaping (String) -> Void) {
    finished = done
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    request?.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.finish() }
  }

  private func finish() {
    guard let f = finished else { return }
    finished = nil
    task?.cancel()
    task = nil
    request = nil
    f(text)
  }
}

final class Voice: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
  private let synth = AVSpeechSynthesizer()
  private var player: AVAudioPlayer?
  private enum Part { case mp3(Data), text(String) }
  private var queue: [Part] = []
  private var busy = false
  var talking: Bool { busy }
  var done: (() -> Void)?
  override init() { super.init(); synth.delegate = self }

  /** the Mac's own voice, picked for the language of the text (replaces whatever is playing) */
  func speak(_ text: String) {
    stop()
    enqueue(.text(text))
  }

  /** the next part of an answer, played after the parts before it: an MP3 the server fetched, or text */
  func add(mp3: Data) { enqueue(.mp3(mp3)) }
  func add(text: String) { enqueue(.text(text)) }

  private func enqueue(_ p: Part) {
    queue.append(p)
    if !busy { next() }
  }

  private func next() {
    guard !queue.isEmpty else { busy = false; done?(); return }
    busy = true
    switch queue.removeFirst() {
    case .mp3(let data):
      if let p = try? AVAudioPlayer(data: data) {
        p.delegate = self
        player = p
        if p.play() { return }
      }
      player = nil
      next()
    case .text(let text):
      let u = AVSpeechUtterance(string: text)
      let lang = NLLanguageRecognizer.dominantLanguage(for: text)?.rawValue ?? "en"
      let code = ["zh-Hans": "zh-CN", "zh-Hant": "zh-HK", "en": Locale.current.identifier.hasPrefix("en") ? Locale.current.identifier.replacingOccurrences(of: "_", with: "-") : "en-US"][lang] ?? lang
      u.voice = AVSpeechSynthesisVoice(language: code) ?? AVSpeechSynthesisVoice(language: "en-US")
      synth.speak(u)
    }
  }

  func stop() {
    queue.removeAll()
    busy = false
    if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
    player?.stop()
    player = nil
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { if busy { next() } }
  func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully ok: Bool) { if p === player { player = nil; next() } }
}

// MARK: - typing box (tap the hotkey)

final class KeyPanel: NSPanel {
  override var canBecomeKey: Bool { true }
}

final class TypeBox: NSObject, NSTextFieldDelegate {
  private let panel = KeyPanel(contentRect: CGRect(x: 0, y: 0, width: 380, height: 40), styleMask: [.borderless], backing: .buffered, defer: false)
  private let field = NSTextField()
  var submit: ((String) -> Void)?
  var closed: (() -> Void)?
  var isOpen: Bool { panel.isVisible }

  override init() {
    super.init()
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.level = .screenSaver
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.sharingType = SHARING
    let bg = NSView(frame: panel.contentLayoutRect)
    bg.wantsLayer = true
    bg.layer?.backgroundColor = INK.cgColor
    bg.layer?.cornerRadius = 12
    bg.layer?.borderColor = MINT.cgColor
    bg.layer?.borderWidth = 1.5
    field.frame = CGRect(x: 14, y: 9, width: 352, height: 22)
    field.isBordered = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.textColor = .white
    field.font = NSFont.systemFont(ofSize: 15)
    field.placeholderAttributedString = NSAttributedString(string: "Ask about your screen, or give the agents a job…", attributes: [.foregroundColor: NSColor.white.withAlphaComponent(0.45), .font: NSFont.systemFont(ofSize: 15)])
    field.delegate = self
    bg.addSubview(field)
    panel.contentView = bg
  }

  func open(near p: CGPoint) {
    let c = cocoa(CGPoint(x: p.x + 20, y: p.y + 24))
    let screen = NSScreen.screens.first { $0.frame.contains(c) } ?? NSScreen.main
    var o = CGPoint(x: c.x, y: c.y - 40)
    if let f = screen?.visibleFrame { o.x = min(max(o.x, f.minX + 8), f.maxX - 388); o.y = min(max(o.y, f.minY + 8), f.maxY - 48) }
    panel.setFrameOrigin(o)
    field.stringValue = ""
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(field)
  }

  func close() {
    guard panel.isVisible else { return }
    panel.orderOut(nil)
    closed?()
  }

  func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    if sel == #selector(NSResponder.insertNewline(_:)) {
      let t = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      close()
      if !t.isEmpty { submit?(t) }
      return true
    }
    if sel == #selector(NSResponder.cancelOperation(_:)) { close(); return true }
    return false
  }
}

// MARK: - keys (global hotkeys via Carbon: no Accessibility or Input Monitoring permission needed)

final class HotKeys {
  static var shared: HotKeys?
  private var refs: [UInt32: EventHotKeyRef] = [:]
  private var actions: [UInt32: () -> Void] = [:]

  init() {
    HotKeys.shared = self
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
      var id = EventHotKeyID()
      GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
      DispatchQueue.main.async { HotKeys.shared?.actions[id.id]?() }
      return noErr
    }, 1, &spec, nil, nil)
  }

  /** register (on) or release (off) one key; only while it's on does the key stop reaching other apps */
  func set(_ id: UInt32, key: Int, mods: Int = 0, on: Bool, action: @escaping () -> Void) {
    if on, refs[id] == nil {
      var ref: EventHotKeyRef?
      let hk = EventHotKeyID(signature: OSType(0x4253_544B), id: id) // 'BSTK'
      if RegisterEventHotKey(UInt32(key), UInt32(mods), hk, GetApplicationEventTarget(), 0, &ref) == noErr, let ref {
        refs[id] = ref
        actions[id] = action
      }
    } else if !on, let ref = refs[id] {
      UnregisterEventHotKey(ref)
      refs[id] = nil
    }
  }
}

// MARK: - link to the Backstage server

final class Link: NSObject {
  private var socket: URLSessionWebSocketTask?
  private var ports: [Int]
  private var portIndex = 0
  private(set) var connectedPort: Int?
  var onMessage: (([String: Any]) -> Void)?
  var onStatus: ((String) -> Void)?

  init(ports: [Int]) { self.ports = ports }

  func connect() {
    let port = ports[portIndex % ports.count]
    let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)/overlay")!)
    task.maximumMessageSize = 8 << 20 // spoken answers arrive as MP3 (about 20 KB a second)
    socket = task
    task.resume()
    // read from the start: the server may send something the moment we connect (the agents' widgets), and an unread
    // message holds back the ping's reply, which would leave us waiting forever
    receive(task, port: port)
    task.sendPing { [weak self] err in
      DispatchQueue.main.async {
        guard let self, self.socket === task else { return }
        if err != nil { self.retry(); return }
        self.connected(port)
      }
    }
  }

  private func connected(_ port: Int) {
    guard connectedPort != port else { return }
    connectedPort = port
    onStatus?("connected to Backstage on :\(port)")
  }

  private func retry() {
    socket?.cancel()
    socket = nil
    connectedPort = nil
    portIndex += 1
    onStatus?("looking for Backstage (run: bun run start)…")
    DispatchQueue.main.asyncAfter(deadline: .now() + (portIndex % ports.count == 0 ? 2 : 0.2)) { [weak self] in self?.connect() }
  }

  private func receive(_ task: URLSessionWebSocketTask, port: Int) {
    task.receive { [weak self] result in
      DispatchQueue.main.async {
        guard let self, self.socket === task else { return }
        switch result {
        case .failure: self.retry()
        case .success(let msg):
          self.connected(port)
          if case .string(let s) = msg, let d = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] { self.onMessage?(d) }
          self.receive(task, port: port)
        }
      }
    }
  }

  func send(_ d: [String: Any]) {
    guard let socket, connectedPort != nil, let data = try? JSONSerialization.data(withJSONObject: d), let s = String(data: data, encoding: .utf8) else { return }
    socket.send(.string(s)) { _ in }
  }
}

// MARK: - the app

final class App: NSObject, NSApplicationDelegate {
  let canvas = Canvas()
  let dock = Dock()
  let pulses = Pulses()
  let buddy = Buddy()
  let listener = Listener()
  let voice = Voice()
  let box = TypeBox()
  var link: Link!
  var status: NSStatusItem!
  var statusLine = NSMenuItem(title: "starting…", action: nil, keyEquivalent: "")

  var keysDown = false
  var downAt: CFTimeInterval = 0
  var listening = false
  var previousApp: NSRunningApplication?
  var idleAfter: CFTimeInterval?
  var answerSeq = 0 // the answer on screen now; its audio arrives separately
  var answerSay = ""
  var audioSeq = -1 // the answer whose audio parts are playing (not set when the Mac voice took over)
  let keys = HotKeys()
  var lessonOn = false // a lesson step is on screen: Option + arrows move through it
  var escAgainUntil: CFTimeInterval = 0 // just after Esc silenced the voice: Esc again clears the drawings

  func applicationDidFinishLaunching(_ n: Notification) {
    var ports = Array(3000...3009)
    if let i = CommandLine.arguments.firstIndex(of: "--port"), i + 1 < CommandLine.arguments.count, let p = Int(CommandLine.arguments[i + 1]) {
      ports.removeAll { $0 == p }
      ports.insert(p, at: 0)
    }
    link = Link(ports: ports)
    link.onStatus = { [weak self] s in self?.statusLine.title = s }
    link.onMessage = { [weak self] m in self?.handle(m) }
    link.connect()

    box.submit = { [weak self] t in self?.ask(t) }
    box.closed = { [weak self] in self?.previousApp?.activate(); if self?.buddy.view.state == "idle" { self?.buddy.set("idle") } }
    voice.done = { [weak self] in
      guard let self else { return }
      self.buddy.home()
      self.idleAfter = CACurrentMediaTime() + 6 // keep the answer readable a little longer
    }

    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    status.button?.image = NSImage(systemSymbolName: "scribble.variable", accessibilityDescription: "Backstage")
    let menu = NSMenu()
    menu.addItem(statusLine)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Ask or give a job…   (tap ⌃⌥)", action: #selector(menuAsk), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Clear drawings", action: #selector(menuClear), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Stop the agents", action: #selector(menuStop), keyEquivalent: ""))
    let previewsItem = NSMenuItem(title: "Show window previews in the agents' widgets", action: #selector(menuPreviews(_:)), keyEquivalent: "")
    previewsItem.state = UserDefaults.standard.object(forKey: "previews") as? Bool ?? true ? .on : .off
    dock.showPreviews = previewsItem.state == .on
    menu.addItem(previewsItem)
    let hide = NSMenuItem(title: "Hide the buddy when idle", action: #selector(menuHide(_:)), keyEquivalent: "")
    menu.addItem(hide)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Hold ⌃⌥ to talk · tap ⌃⌥ to type", action: nil, keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "esc: stop talking (again: clear) · ⌥→ / ⌥←: next / back", action: nil, keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Quit Backstage Overlay", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    for i in menu.items where i.action != nil && i.action != #selector(NSApplication.terminate(_:)) { i.target = self }
    status.menu = menu

    Listener.askPermission()
    // Screen Recording (the agents' window previews) is asked for HERE, at launch: asked during a run, macOS opened
    // System Settings on top of the demo
    if dock.showPreviews { dock.askForPreviews() }
    dock.composite { [weak self] in self?.pulses.windowIDs ?? [] }
    buddy.set("idle")

    let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
    RunLoop.main.add(t, forMode: .common)
  }

  @objc func menuAsk() { begin(); openBox() }
  @objc func menuStop() { link.send(["type": "stop"]) }
  @objc func menuPreviews(_ item: NSMenuItem) {
    item.state = item.state == .on ? .off : .on
    dock.showPreviews = item.state == .on
    UserDefaults.standard.set(item.state == .on, forKey: "previews")
  }
  @objc func menuClear() { link.send(["type": "dismiss"]); lessonOn = false; silence(); canvas.clear(); buddy.home(); buddy.set("idle") }
  @objc func menuHide(_ i: NSMenuItem) { buddy.hiddenWhenIdle.toggle(); i.state = buddy.hiddenWhenIdle ? .on : .off }

  // the hotkey: read the modifier keys 60 times a second (needs no permission)
  func tick() {
    buddy.tick()
    // keys that only exist while they mean something
    let now = CACurrentMediaTime()
    keys.set(1, key: kVK_Escape, on: voice.talking || now < escAgainUntil) { [weak self] in self?.escape() }
    keys.set(2, key: kVK_RightArrow, mods: optionKey, on: lessonOn) { [weak self] in self?.lessonKey("next") }
    keys.set(3, key: kVK_LeftArrow, mods: optionKey, on: lessonOn) { [weak self] in self?.lessonKey("back") }
    if let t = idleAfter, CACurrentMediaTime() > t { idleAfter = nil; buddy.set("idle") }
    let mods = NSEvent.modifierFlags.intersection([.control, .option, .command, .shift])
    let down = mods == [.control, .option]
    if down && !keysDown {
      keysDown = true
      downAt = CACurrentMediaTime()
      begin()
    } else if down && keysDown && !listening && CACurrentMediaTime() - downAt > 0.35 {
      startListening()
    } else if !down && keysDown {
      keysDown = false
      if listening { stopListening() }
      // a tap: released quickly, with no other modifier added (the two keys rarely come up in the same instant)
      else if CACurrentMediaTime() - downAt <= 0.35 && mods.isSubset(of: [.control, .option]) { box.isOpen ? box.close() : openBox() }
    }
  }

  /** a new question starts: stop talking, wipe the old drawings, and have the server capture the screen NOW */
  func begin() {
    // nothing is cleared yet: that happens when the question is actually asked (holding the keys and letting go
    // without a word leaves the lesson on screen)
    previousApp = NSWorkspace.shared.frontmostApplication
    if previousApp?.bundleIdentifier == Bundle.main.bundleIdentifier { previousApp = nil }
    guard RECORDING else { link.send(["type": "begin"]); return }
    // recording mode: our windows are visible to captures, so step aside while the server takes its screenshot
    hideForCapture()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in self?.link.send(["type": "begin"]) }
  }

  private var hiddenAlphas: [(NSWindow, CGFloat)] = []
  func hideForCapture() {
    guard hiddenAlphas.isEmpty else { return }
    hiddenAlphas = NSApp.windows.filter { $0.isVisible }.map { ($0, $0.alphaValue) }
    for (w, _) in hiddenAlphas { w.alphaValue = 0 }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.showAfterCapture() } // never stay hidden
  }
  func showAfterCapture() {
    for (w, a) in hiddenAlphas { w.alphaValue = a }
    hiddenAlphas = []
  }

  func startListening() {
    listening = true
    silence() // the mic shouldn't hear the old answer
    buddy.home()
    idleAfter = nil
    if listener.start(partial: { [weak self] t in self?.buddy.set("listening", t.isEmpty ? "Listening…" : t) }) {
      buddy.set("listening", "Listening…")
    } else {
      listening = false
      buddy.set("error", "I can't hear you yet: allow Microphone and Speech Recognition for Backstage Overlay in System Settings › Privacy. Tap ⌃⌥ to type instead.")
      idleAfter = CACurrentMediaTime() + 6
      keysDown = false
    }
  }

  func stopListening() {
    listening = false
    buddy.set("thinking", "One moment")
    listener.stop { [weak self] text in
      guard let self else { return }
      if text.trimmingCharacters(in: .whitespaces).isEmpty { self.buddy.set("idle"); return }
      self.ask(text)
    }
  }

  /** stop talking now, and drop any audio still on its way for this answer */
  func silence() {
    answerSay = ""
    audioSeq = -1
    voice.stop()
  }

  /** Esc: first press silences the voice (drawings stay); a second press within 2 s clears them too */
  func escape() {
    if voice.talking {
      link.send(["type": "key", "what": "esc: stopped talking"])
      silence()
      escAgainUntil = CACurrentMediaTime() + 2
      buddy.home()
      idleAfter = CACurrentMediaTime() + 4
    } else {
      escAgainUntil = 0
      link.send(["type": "key", "what": "esc again: cleared"])
      link.send(["type": "dismiss"])
    }
  }

  /** Option + → / ←: the next or previous lesson step, without saying anything */
  func lessonKey(_ go: String) {
    link.send(["type": "key", "what": "⌥\(go == "next" ? "→" : "←"): \(go)"])
    link.send(["type": "step", "go": go])
  }

  func openBox() {
    silence()
    buddy.home()
    idleAfter = nil
    buddy.set("idle")
    box.open(near: topLeft(NSEvent.mouseLocation))
  }

  func ask(_ text: String) {
    guard link.connectedPort != nil else {
      buddy.set("error", "Backstage isn't running. Start it with: bun run start")
      idleAfter = CACurrentMediaTime() + 5
      return
    }
    canvas.clear() // a new question: the old drawings go
    buddy.set("thinking", "“\(text.prefix(60))” – thinking")
    let m = topLeft(NSEvent.mouseLocation)
    link.send(["type": "ask", "text": text, "cursor": ["x": m.x, "y": m.y]])
  }

  func handle(_ m: [String: Any]) {
    switch m["type"] as? String {
    case "captured":
      showAfterCapture()
    case "status":
      buddy.set("thinking", (m["text"] as? String ?? "thinking").replacingOccurrences(of: "…", with: ""))
    case "answer":
      let say = m["say"] as? String ?? ""
      let shapes = (m["shapes"] as? [[String: Any]] ?? []).compactMap(Shape.init)
      var text = say
      lessonOn = false
      if let st = m["step"] as? [String: Any], let i = st["index"] as? Int, let n = st["total"] as? Int {
        text = "Step \(i + 1) of \(n): \(say)\n\n⌥→ next  ·  ⌥← back  ·  esc quiet"
        lessonOn = true
      }
      buddy.set("answer", text)
      canvas.show(shapes, fadeMs: (m["fadeMs"] as? NSNumber)?.doubleValue ?? 9000)
      if let first = shapes.first { buddy.fly(to: first.anchor) }
      answerSeq = (m["seq"] as? NSNumber)?.intValue ?? answerSeq + 1
      answerSay = say
      voice.stop()
      if m["audio"] as? String == "follows" {
        // the server is fetching a natural voice; if it doesn't arrive in time, the Mac voice says it
        let seq = answerSeq
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
          guard let self, self.answerSeq == seq, !self.answerSay.isEmpty else { return }
          self.answerSay = ""
          self.voice.speak(say)
        }
      } else {
        answerSay = ""
        voice.speak(say)
      }
    case "audio", "speak":
      // the parts of the spoken answer, in order; the first one cancels the Mac-voice fallback
      guard (m["seq"] as? NSNumber)?.intValue == answerSeq else { return }
      let seq = answerSeq
      if (m["part"] as? NSNumber)?.intValue == 0 {
        if answerSay.isEmpty { return } // too late: the Mac voice is already saying it
        answerSay = ""
        audioSeq = seq
      } else if audioSeq != seq { return }
      if let b64 = m["mp3"] as? String, let data = Data(base64Encoded: b64) { voice.add(mp3: data) }
      else if let t = m["say"] as? String { voice.add(text: t) }
    case "agents":
      dock.update(m)
    case "tap":
      let n = { (k: String) -> CGFloat in CGFloat((m[k] as? NSNumber)?.doubleValue ?? 0) }
      pulses.flash(CGRect(x: n("x"), y: n("y"), width: n("w"), height: n("h")), colour(hex: m["colour"] as? String ?? "#2bb39a"), agent: m["agent"] as? String ?? "")
    case "clear":
      lessonOn = false; silence(); canvas.clear(); buddy.home(); buddy.set("idle")
    case "error":
      buddy.home()
      buddy.set("error", m["text"] as? String ?? "something went wrong")
      idleAfter = CACurrentMediaTime() + 6
    default: break
    }
  }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
