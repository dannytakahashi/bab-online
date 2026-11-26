import SwiftUI

/// The game lobby header's count, in the web's words (GameLobby.js): the ready count only,
/// "Ready 2/4" (owner 2026-11-19: the rows show who is here, so "Players 7/8 ·" went), from a
/// server with or without the family keys.
struct LobbyCount: Equatable {
    /// Ready seats at the table, out of `seats` (4; 3 for Get Your Bid: "Ready 2/3").
    let ready: Int
    var seats: Int = 4

    init(ready: Int, seats: Int = 4) {
        self.ready = ready
        self.seats = seats
    }

    init(_ lobby: LobbyState) {
        self.init(ready: lobby.readyAtTable, seats: lobby.seats)
    }

    /// One line, never broken: "Ready 2/4".
    var text: String { "Ready \(ready)/\(seats)" }

    /// VoiceOver, whatever the layout: "2 of 4 ready".
    var spoken: String { "\(ready) of \(seats) ready" }
}

/// The game lobby's header: Leave (unless the vertical bar holds it), the lobby's title, the
/// mic while voice is on, and the count. Measured, never truncated (owner 2026-11-16, build 12
/// on an iPhone 17: "4/8 · Rea..."): one row where everything fits (the iPad, the open Duo's
/// column); else the count on a line under the title, as the tournament lobby's round line
/// (phones, the closed Duo); else (large Dynamic Type on a narrow screen) Leave and the mic on a
/// row of their own, the title wrapping under them, then the count on its own line.
struct LobbyHeaderView: View {
    let title: String
    let count: LobbyCount
    let showsLeave: Bool
    let showsMic: Bool
    let leave: () -> Void
    let openVoicePanel: () -> Void

    enum Form: String { case row, stacked, wrapped }

    /// The header's width, and the ideal (one-line) widths of the row and the stacked form, from
    /// hidden copies: the first form whose ideal width fits is shown (the ViewThatFits rule,
    /// decided here so the probe knows which form is up).
    @State private var width: CGFloat = 0
    @State private var rowWidth: CGFloat = .infinity
    @State private var stackedWidth: CGFloat = .infinity

    /// LobbyHeaderProbe's frames (fixture mode only records any).
    @StateObject private var probe = LobbyHeaderFrames()

    /// Before the first measurement: the phone form (no flash on the usual screen).
    var form: Form {
        guard width > 0 else { return .stacked }
        if rowWidth <= width + 0.5 { return .row }
        if stackedWidth <= width + 0.5 { return .stacked }
        return .wrapped
    }

    var body: some View {
        Group {
            switch form {
            case .row: row(.row)
            case .stacked: stacked(.stacked)
            case .wrapped: wrapped(.wrapped)
            }
        }
        // minWidth 0: the width offered, never the shown form's (a form wider than the screen
        // would otherwise widen the frame and keep itself chosen)
        .frame(minWidth: 0, maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width = $0 }
        .background(alignment: .topLeading) {
            ZStack(alignment: .topLeading) {
                row(nil).fixedSize()
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { rowWidth = $0 }
                stacked(nil).fixedSize()
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { stackedWidth = $0 }
            }
            .hidden()
            .accessibilityHidden(true)
            .allowsHitTesting(false)
        }
        .coordinateSpace(name: LobbyHeaderProbe.space)
        #if DEBUG
        .overlay(alignment: .topLeading) {
            if UIFixture.isActive {
                let frames = probe.frames(of: form)
                LobbyHeaderProbeView(check: LobbyHeaderProbe.check(
                    frames, container: CGRect(x: 0, y: 0, width: width, height: frames["form.\(form.rawValue)"]?.maxY ?? 0)))
            }
        }
        #endif
    }

    // MARK: - The three forms (`shown`: the form on screen; nil: a hidden copy, only measured)

    /// Leave | title | mic, count.
    private func row(_ shown: Form?) -> some View {
        HStack {
            if showsLeave {
                leaveButton(shown)
                Spacer()
            }
            titleText(wraps: false, shown)
            Spacer()
            HStack(spacing: Theme.Space.s3) {
                if showsMic { mic(shown) }
                countLine(.body, shown)
            }
        }
        .headerProbe("form.row", shown, probe)
    }

    /// Leave | title over the count | mic.
    private func stacked(_ shown: Form?) -> some View {
        HStack {
            if showsLeave {
                leaveButton(shown)
                Spacer()
            }
            VStack(alignment: showsLeave ? .center : .leading, spacing: 2) {
                titleText(wraps: false, shown)
                countLine(.caption, shown)
            }
            Spacer()
            if showsMic { mic(shown) }
        }
        .headerProbe("form.stacked", shown, probe)
    }

    /// Leave and mic, then the title (wrapping), then the count (one line: "Ready 2/4").
    private func wrapped(_ shown: Form?) -> some View {
        let alignment: HorizontalAlignment = showsLeave ? .center : .leading
        return VStack(alignment: alignment, spacing: Theme.Space.s2) {
            if showsLeave || showsMic {
                HStack {
                    if showsLeave { leaveButton(shown) }
                    Spacer(minLength: Theme.Space.s2)
                    if showsMic { mic(shown) }
                }
            }
            titleText(wraps: true, shown)
            countLine(.caption, shown)
        }
        .frame(maxWidth: .infinity, alignment: Alignment(horizontal: alignment, vertical: .center))
        .headerProbe("form.wrapped", shown, probe)
    }

    // MARK: - Parts

    private func leaveButton(_ shown: Form?) -> some View {
        Button(action: leave) {
            HStack(spacing: Theme.Space.s1) {
                Image(systemName: "chevron.left")
                    .accessibilityHidden(true)
                Text("Leave")
                    .lineLimit(1)
            }
            .foregroundColor(Theme.textSecondary)
        }
        .fixedSize()
        .headerProbe("leave", shown, probe)
    }

    @ViewBuilder
    private func mic(_ shown: Form?) -> some View {
        if shown != nil {
            VoiceMuteButton(onLongPress: openVoicePanel)
                .scaleEffect(0.8)
                .accessibilityIdentifier("lobby.mic")
                .headerProbe("mic", shown, probe)
        } else {
            Color.clear.frame(width: Theme.hitTarget, height: Theme.hitTarget)  // VoiceMuteButton's size
        }
    }

    private func titleText(wraps: Bool, _ shown: Form?) -> some View {
        Text(title)
            .font(.headline)
            .foregroundColor(Theme.textPrimary)
            .lineLimit(wraps ? nil : 1)
            .multilineTextAlignment(wraps && showsLeave ? .center : .leading)
            .fixedSize(horizontal: false, vertical: wraps)
            .headerProbe("title", shown, probe)
            .background(idealProbe(title, .headline, key: "titleIdeal", shown))
    }

    /// The count on one line at its full width, one accessibility element: it never truncates
    /// (a form it does not fit is never chosen).
    private func countLine(_ font: Font, _ shown: Form?) -> some View {
        piece(count.text, font, key: "0", shown)
            .countElement(count)
    }

    private func piece(_ text: String, _ font: Font, key: String, _ shown: Form?) -> some View {
        Text(text)
            .font(font)
            .foregroundColor(Theme.textSecondary)
            .lineLimit(1)
            .fixedSize()
            .headerProbe("count.\(key)", shown, probe)
            .background(idealProbe(text, font, key: "countIdeal.\(key)", shown))
    }

    /// DEBUG: the text at its full width (a hidden copy), so LobbyHeaderProbe can tell a cut-off one.
    @ViewBuilder
    private func idealProbe(_ text: String, _ font: Font, key: String, _ shown: Form?) -> some View {
        #if DEBUG
        if shown != nil && UIFixture.isActive {
            Text(text)
                .font(font)
                .lineLimit(1)
                .fixedSize()
                .hidden()
                .headerProbe(key, shown, probe)
        }
        #endif
    }
}

/// The header parts' frames in the header's space, by form ("stacked/title"), recorded with
/// onGeometryChange in fixture mode (a GeometryReader preference missed the header's last
/// layout pass after the screen's entry: the probe read an off-screen pass at 250 pt).
final class LobbyHeaderFrames: ObservableObject {
    @Published var all: [String: CGRect] = [:]

    func frames(of form: LobbyHeaderView.Form) -> [String: CGRect] {
        let prefix = form.rawValue + "/"
        return Dictionary(uniqueKeysWithValues: all.compactMap { k, v in
            k.hasPrefix(prefix) ? (String(k.dropFirst(prefix.count)), v) : nil
        })
    }
}

private extension View {
    /// The count as VoiceOver reads it and the UI tests find it ("lobby.count").
    func countElement(_ count: LobbyCount) -> some View {
        accessibilityElement(children: .ignore)
            .accessibilityLabel(count.spoken)
            .accessibilityIdentifier("lobby.count")
    }

    /// Records this part's frame for LobbyHeaderProbe (fixture mode only; only the form shown).
    @ViewBuilder
    func headerProbe(_ key: String, _ shown: LobbyHeaderView.Form?, _ probe: LobbyHeaderFrames) -> some View {
        #if DEBUG
        if let shown, UIFixture.isActive {
            let id = "\(shown.rawValue)/\(key)"
            onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(LobbyHeaderProbe.space)) }) { probe.all[id] = $0 }
                .onDisappear { probe.all[id] = nil }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// The "lobby.headerCheck" probe's rules: "<form> ok", or what is wrong ("stacked: count.0 cut
/// off (150 of 182 pt)"). One form shows; every part is inside the header and overlaps no other;
/// the count (and a one-line title) is at its full width.
enum LobbyHeaderProbe {
    static let space = "lobbyHeader"

    static func check(_ frames: [String: CGRect], container: CGRect) -> String {
        let forms = frames.keys.filter { $0.hasPrefix("form.") }.map { String($0.dropFirst(5)) }.sorted()
        let form = forms.isEmpty ? "none" : forms.joined(separator: "+")
        var bad: [String] = []
        if forms.count != 1 { bad.append("\(forms.count) forms") }
        let parts = frames.filter { k, _ in k == "leave" || k == "title" || k == "mic" || k.hasPrefix("count.") }
            .sorted { $0.key < $1.key }
        if !parts.contains(where: { $0.key.hasPrefix("count.") }) { bad.append("no count") }
        let inside = container.insetBy(dx: -0.5, dy: -0.5)
        for (key, f) in parts where !inside.contains(f) {
            bad.append("\(key) outside \(f.integral)")
        }
        for (a, ra) in parts.enumerated() {
            for rb in parts[(a + 1)...] where ra.value.insetBy(dx: 0.5, dy: 0.5).intersects(rb.value.insetBy(dx: 0.5, dy: 0.5)) {
                bad.append("\(ra.key) overlaps \(rb.key)")
            }
        }
        for (key, f) in parts where key.hasPrefix("count.") {
            if let ideal = frames["countIdeal." + key.dropFirst(6)], ideal.width > f.width + 0.5 {
                bad.append("\(key) cut off (\(Int(f.width)) of \(Int(ideal.width)) pt)")
            }
        }
        if form != "wrapped", let title = frames["title"], let ideal = frames["titleIdeal"], ideal.width > title.width + 0.5 {
            bad.append("title cut off (\(Int(title.width)) of \(Int(ideal.width)) pt)")
        }
        return bad.isEmpty ? "\(form) ok" : "\(form): " + bad.joined(separator: "; ")
    }
}

#if DEBUG
/// The "lobby.headerCheck" probe for XCUITest (fixture mode), 1x1 and nearly transparent.
private struct LobbyHeaderProbeView: View {
    let check: String

    var body: some View {
        Rectangle()
            .fill(Color.black)
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityLabel("lobby.headerCheck")
            .accessibilityIdentifier("lobby.headerCheck")
            .accessibilityValue(check)
    }
}
#endif
