import Foundation
import UIKit
import UserNotifications
import Capacitor

// What the iPad app adds to the web page (window.Capacitor.Plugins.Doodlehive):
// - "pencilTap" and "pencilSqueeze" events: Apple Pencil double-tap (2nd gen, Pro) and squeeze (Pro),
//   with the action the person picked in iPadOS Settings and, when the Pencil hovers, where it is.
// - info(): which push environment this build talks to and the system's Pencil settings.
// - setBadge(): the app icon's number, kept equal to the unread notifications.
@objc(DoodlehivePlugin)
public class DoodlehivePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DoodlehivePlugin"
    public let jsName = "Doodlehive"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise)
    ]

    private var pencil: PencilListener?

    override public func load() {
        Task { @MainActor [weak self] in
            guard let self, let view = self.bridge?.webView else { return }
            self.pencil = PencilListener(view: view) { [weak self] event, data in
                self?.notifyListeners(event, data: data)
            }
        }
    }

    @objc func info(_ call: CAPPluginCall) {
        Task { @MainActor in
            var squeeze = false
            if #available(iOS 17.5, *) { squeeze = true }
            var hoverPreview = true
            if #available(iOS 17.5, *) { hoverPreview = UIPencilInteraction.prefersHoverToolPreview }
            #if DEBUG
            let apns = "sandbox"
            #else
            let apns = "production"
            #endif
            call.resolve([
                "apns": apns,
                "pencilOnly": UIPencilInteraction.prefersPencilOnlyDrawing,
                "hoverPreview": hoverPreview,
                "squeeze": squeeze
            ])
        }
    }

    @objc func setBadge(_ call: CAPPluginCall) {
        let n = max(0, call.getInt("count") ?? 0)
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(n) { _ in call.resolve() }
        } else {
            Task { @MainActor in
                UIApplication.shared.applicationIconBadgeNumber = n
                call.resolve()
            }
        }
    }
}

/// Listens for Pencil gestures over the web view and reports them as plain dictionaries.
@MainActor
final class PencilListener: NSObject, UIPencilInteractionDelegate {
    private let interaction = UIPencilInteraction()
    private let send: (String, [String: Any]) -> Void

    init(view: UIView, send: @escaping (String, [String: Any]) -> Void) {
        self.send = send
        super.init()
        interaction.delegate = self
        view.addInteraction(interaction)
    }

    // iPadOS 17.5 and later: taps and squeezes, with the hover position when the Pencil is near the screen.

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        var data = pose(tap.hoverPose)
        data["action"] = name(UIPencilInteraction.preferredTapAction)
        send("pencilTap", data)
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        // One event per squeeze, when it is let go; a cancelled squeeze does nothing.
        guard squeeze.phase == .ended else { return }
        var data = pose(squeeze.hoverPose)
        data["action"] = name(UIPencilInteraction.preferredSqueezeAction)
        send("pencilSqueeze", data)
    }

    // Earlier versions: double-tap only, without a position.

    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        send("pencilTap", ["action": name(UIPencilInteraction.preferredTapAction), "hover": false])
    }

    @available(iOS 17.5, *)
    private func pose(_ p: UIPencilHoverPose?) -> [String: Any] {
        guard let p else { return ["hover": false] }
        return [
            "hover": true,
            "x": Double(p.location.x),
            "y": Double(p.location.y),
            "z": Double(p.zOffset),
            "altitude": Double(p.altitudeAngle),
            "azimuth": Double(p.azimuthAngle),
            "roll": Double(p.rollAngle)
        ]
    }

    private func name(_ a: UIPencilPreferredAction) -> String {
        if #available(iOS 17.5, *) {
            if a == .showContextualPalette { return "showContextualPalette" }
            if a == .runSystemShortcut { return "runSystemShortcut" }
        }
        if #available(iOS 16.0, *), a == .showInkAttributes { return "showInkAttributes" }
        switch a {
        case .switchEraser: return "switchEraser"
        case .switchPrevious: return "switchPrevious"
        case .showColorPalette: return "showColorPalette"
        default: return "ignore"
        }
    }
}
