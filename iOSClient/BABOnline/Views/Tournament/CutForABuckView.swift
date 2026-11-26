import SwiftUI

/// Cut for a buck on iOS 1.2.7 (41) (owner 2026-11-25; spec section 6; the web's
/// client/src/ui/cut/CutForABuck.js): the tournament lobby's main area while the cut runs
/// (TournamentLobbyView puts it where the players and the scoreboard go; the header with voice and
/// the chat stay).
///   - the ring (CutRing): me at 6 o'clock, then clockwise; avatars with the voice speaking ring,
///     names ("you" for me), captions; each player's cards on the inward ray, the newest in front,
///     up to 3 older ones behind it, then "+n"
///   - the deck: a face-down fan narrowing as it empties, one "Draw a card" element; the card under
///     the finger peeks up and its slot is what is sent (cutForABuckDraw {round, slot}); a
///     spectator's deck is not a button
///   - draws fly from the deck face down; at the reveal the cards flip together (0.3 s after, 0.4 s
///     each, 40 ms apart), the verdict at +1.2 s: the out players dim and grey with "Out · round 2"
///     and a danger outline on the losing card, and they KEEP watching every later round live (owner
///     2026-11-25); a reshuffle sends the table's cards back to the deck; the winner glides to the
///     centre at twice the size with the gold glow and the buck glyph
///   - the intro (CutIntro), Ring | List, VoiceOver (one ring container in ring order, me first;
///     one announcement per reveal, an urgent one for the winner), Dynamic Type capped on the ring
///     like the draw's, the list for the accessibility sizes
///   - the list instead of the ring whenever the ring cannot fit the stage (`CutRing.fits`: an
///     overlap, or avatars under 24 pt; owner 2026-11-25, the web's PR #422): the note "Too many
///     players to fit the ring on this screen." over the list and Ring unavailable, re-checked on
///     every size change (rotation, a Duo fold, Split View) and player change; the ring comes back
///     when it fits again and Ring is the choice
struct CutForABuckView: View {
    enum Part { case full, stage, controls }

    @ObservedObject var model: CutScreenModel
    var part: Part = .full

    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var authState: AuthState
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.horizontalSizeClass) private var hSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Ring or List as chosen (remembered on the device; fixture mode: `-uiCutView ring|list`, never saved).
    @State private var savedMode: String = CutForABuckView.storedMode
    /// The ring's stage as the screen gives it (the list's area too: the same frame).
    @State private var stageSize: CGSize = .zero
    /// Whether the ring fits that stage; nil until the stage is measured (nothing drawn there yet).
    @State private var ringFits: Bool?
    /// The name line plus its caption under each avatar, as `CutStageView` measures it.
    @ScaledMetric(relativeTo: .caption) private var nameBox: CGFloat = 30
    /// The accessibility sizes' ring height (one scroll; the stage is this tall).
    static let scrollingStageHeight: CGFloat = 460
    static let ringUnfitNote = "Too many players to fit the ring on this screen."

    static let modeKey = "bab.cutView"
    static var storedMode: String {
        #if DEBUG
        if UIFixture.isActive { return UserDefaults.standard.string(forKey: "uiCutView") ?? "" }
        #endif
        return UserDefaults.standard.string(forKey: modeKey) ?? ""
    }

    private func choose(_ m: String) {
        savedMode = m
        #if DEBUG
        if UIFixture.isActive { return }
        #endif
        UserDefaults.standard.set(m, forKey: Self.modeKey)
    }

    private var state: CutState? { tournamentState.cut }
    private var me: String? { tournamentState.isSpectator ? nil : authState.username }

    /// Ring or List as chosen: the saved choice, else the list at the accessibility sizes on a
    /// compact width and from 13 players there.
    private var chosenMode: String {
        if savedMode == "ring" || savedMode == "list" { return savedMode }
        let many = (state?.ringPlayers.count ?? 0) >= CutRing.denseFrom
        return hSize == .compact && (typeSize.isAccessibilitySize || many) ? "list" : "ring"
    }

    /// What shows: the choice, except the list while the ring cannot fit.
    private var mode: String {
        chosenMode == "ring" && ringFits == false ? "list" : chosenMode
    }

    private var ringUnfit: Bool { ringFits == false }

    private var scrolling: Bool { typeSize.isAccessibilitySize && part == .full }

    /// Re-checks the ring against the stage (size, players, text size).
    private func refit() {
        guard stageSize.width > 0, stageSize.height > 0 || scrolling else { return }
        let n = max(1, state?.ringPlayers.count ?? 0)
        let h = scrolling ? Self.scrollingStageHeight : stageSize.height
        let fits = CutRing.fits(w: stageSize.width, h: h, n: n, nameH: min(nameBox, 40))
        if fits != ringFits { ringFits = fits }
    }

    /// The ring or the list, the intro over either (a screen-level overlay: the title, and over the
    /// list the deck's riffle and fan too; the ring shuffles its own deck and slides its avatars in),
    /// and the intro's clock (whichever shows, so the list's intro runs its length and goes).
    private var stageOrList: some View {
        stageOrListContent
            .overlay(alignment: .top) {
                CutIntroOverlay(model: model, over: mode == "list" ? .list : .ring)
                    .frame(maxHeight: scrolling ? Self.scrollingStageHeight : .infinity)
            }
            .task(id: model.introStart) {
                // a held frame never ends; a cancelled task (this view rebuilt) ends nothing
                guard CutStageView.heldIntroFrame == nil else { return }
                await model.playIntro()
            }
    }

    @ViewBuilder
    private var stageOrListContent: some View {
        if ringFits == nil {
            // the stage's first measurement: neither drawn yet (no ring flashed before the list)
            Color.clear
        } else if mode == "list" {
            CutListView(model: model, scrolls: !scrolling, note: ringUnfit ? Self.ringUnfitNote : nil)
        } else {
            CutStageView(model: model)
        }
    }

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize && part == .full {
                // the accessibility sizes: one scroll (the bar and the status take most of a phone)
                ScrollView {
                    VStack(spacing: 0) {
                        bar
                        status
                        if mode == "list" || ringFits == nil {
                            stageOrList
                        } else {
                            stageOrList.frame(height: Self.scrollingStageHeight)
                        }
                    }
                    .onGeometryChange(for: CGSize.self, of: { $0.size }) { stageSize = CGSize(width: $0.width, height: Self.scrollingStageHeight); refit() }
                }
                .scrollBounceBehavior(.basedOnSize)
            } else {
                content
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("cut")
        .onChange(of: state?.ringPlayers.count ?? 0) { refit() }
        .onChange(of: nameBox) { refit() }
        .onChange(of: scrolling) { refit() }
        #if DEBUG
        .overlay(alignment: .topTrailing) {
            HStack(spacing: 0) {
                CutProbe(id: "cut.ringFit", value: "\(mode) fits=\(ringFits.map { $0 ? "yes" : "no" } ?? "-") stage=\(Int(stageSize.width))x\(Int(scrolling ? Self.scrollingStageHeight : stageSize.height))")
                if part != .controls { CutProbe(id: "cut.introCheck", value: introCheck) }
            }
        }
        #endif
        .onAppear { model.reduceMotion = reduceMotion || CutForABuckView.fixtureReduceMotion }
        .onChange(of: reduceMotion) { _, r in model.reduceMotion = r }
    }

    private var content: some View {
        VStack(spacing: 0) {
            if part != .controls { bar }
            if part != .stage { status }
            if part != .controls {
                stageOrList
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onGeometryChange(for: CGSize.self, of: { $0.size }) { stageSize = $0; refit() }
            }
            if part == .controls { drawButton.padding(Theme.Space.s3) }
        }
    }

    #if DEBUG
    /// The probe `cut.introCheck`: "playing over=<ring|list>", "ran <s>" (the last intro's
    /// length), or "-".
    private var introCheck: String {
        if model.introStart != nil { return "playing over=\(mode)" }
        return model.lastIntroLength.map { String(format: "ran %.2f", $0) } ?? "-"
    }
    #endif

    static var fixtureReduceMotion: Bool {
        #if DEBUG
        return UIFixture.splashReduceMotion
        #else
        return false
        #endif
    }

    // MARK: - Bar

    private var bar: some View {
        // a segmented control of our own: a system segmented Picker cannot disable one segment,
        // and Ring is unavailable while the ring cannot fit
        let picker = CutViewToggle(mode: mode, ringAvailable: !ringUnfit) { m in
            if m == "ring" && ringUnfit { return }
            choose(m)
        }
        .fixedSize()
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Space.s2) {
                titleBlock
                Spacer(minLength: Theme.Space.s2)
                picker
                SoundToggleButton()
            }
            VStack(alignment: .leading, spacing: Theme.Space.s1) {
                titleBlock
                HStack {
                    picker
                    Spacer()
                    SoundToggleButton()
                }
            }
        }
        .padding(.horizontal, Theme.Space.s3)
        .padding(.top, Theme.Space.s2)
        // the bar stays a bar at the largest sizes (the stage and the list get the room)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Theme.Space.s1) {
                Image(systemName: "dollarsign.circle.fill")
                    .foregroundStyle(Theme.gold)
                    .accessibilityHidden(true)
                Text(CutCopy.title)
                    .font(.headline)
                    .foregroundStyle(Theme.gold)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            let line = CutCopy.roundLine(state)
            if !line.isEmpty {
                Text(line)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .accessibilityIdentifier("cut.round")
            }
        }
    }

    // MARK: - Status

    private var status: some View {
        TimelineView(.periodic(from: .now, by: 0.25)) { _ in
            let st = CutCopy.forList(model.status(state), list: mode == "list" || part == .controls)
            VStack(spacing: 2) {
                Text(st.main)
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
                    .accessibilityIdentifier("cut.status")
                if !st.sub.isEmpty {
                    Text(st.sub)
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .accessibilityIdentifier("cut.statusSub")
                }
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, Theme.Space.s3)
            .padding(.vertical, Theme.Space.s2)
        }
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
    }

    // MARK: - Draw button (the tabletop's lower half)

    @ViewBuilder
    var drawButton: some View {
        if let s = state, s.stage == .drawing, s.isAlive(me) {
            CutDrawButton(model: model)
        }
    }
}

/// Ring | List: the system segmented control's look, with Ring disabled (dimmed, VoiceOver
/// "dimmed") while the ring cannot fit the stage. Each segment is a button with the selected
/// trait; id `cut.view`.
struct CutViewToggle: View {
    let mode: String
    let ringAvailable: Bool
    let choose: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            segment("Ring", "ring", enabled: ringAvailable)
            segment("List", "list", enabled: true)
        }
        .padding(2)
        .background(Capsule().fill(Theme.surfaceLight))
        .animation(.easeOut(duration: 0.15), value: mode)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Show the players as")
        .accessibilityIdentifier("cut.view")
    }

    private func segment(_ title: String, _ tag: String, enabled: Bool) -> some View {
        let on = mode == tag
        return Button { if !on { choose(tag) } } label: {
            Text(title)
                .font(.subheadline.weight(on ? .semibold : .medium))
                .lineLimit(1)
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, Theme.Space.s3)
                .frame(minHeight: 28)
                .background(Capsule().fill(on ? Theme.surfaceRaised : Color.clear))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityHint(enabled ? "" : CutForABuckView.ringUnfitNote)
    }
}

/// The full-width "Draw a card" (the list, and a tabletop's lower half): a random card (slot nil),
/// or, after the server drew for me, the tap that says I am back.
struct CutDrawButton: View {
    @ObservedObject var model: CutScreenModel
    @EnvironmentObject var tournamentState: TournamentState

    var body: some View {
        let s = tournamentState.cut
        let enabled = model.canDraw(s) || model.canSayBack(s)
        Button {
            if model.draw(s, slot: nil) { CutLocalDraw.mark(tournamentState, me: model.me, slot: nil) }
        } label: {
            Text(CutCopy.drawACard)
                .font(.title3.bold())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(enabled ? Theme.warning : Theme.buttonDisabled)
                .foregroundColor(enabled ? Theme.warningForeground : Theme.buttonDisabledForeground)
                .cornerRadius(Theme.Radius.md)
        }
        .disabled(!enabled)
        .accessibilityIdentifier("cut.listDraw")
    }
}

/// My draw shows as drawn at once (the server's cutForABuckDrew confirms it with the real slot).
enum CutLocalDraw {
    @MainActor
    static func mark(_ t: TournamentState, me: String?, slot: Int?) {
        guard let me, var cut = t.cut, cut.drawn[me] == nil else { return }
        cut.drawn[me] = CutState.Drawn(slot: slot ?? -1, auto: false, local: true)
        t.cut = cut
    }
}

// MARK: - The ring

/// The stage: the ring, the cards, the deck and the winner, in one GeometryReader.
struct CutStageView: View {
    @ObservedObject var model: CutScreenModel
    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var authState: AuthState
    @ObservedObject private var voice = VoiceChatManager.shared
    /// The name line plus its caption under each avatar.
    @ScaledMetric(relativeTo: .caption) private var nameBox: CGFloat = 30

    private var state: CutState? { tournamentState.cut }
    private var me: String? { tournamentState.isSpectator ? nil : authState.username }

    var body: some View {
        GeometryReader { geo in
            let order = CutOrder.ring(state?.ringPlayers ?? [], me: me)
            let layout = CutRing.layout(w: geo.size.width, h: geo.size.height, n: max(1, order.count), nameH: min(nameBox, 40))
            TimelineView(.animation(minimumInterval: 1.0 / 60, paused: model.introStart == nil)) { ctx in
                let intro = CutIntro(reduceMotion: model.reduceMotion)
                let t: TimeInterval? = model.introStart.map { CutStageView.heldIntroFrame ?? ctx.date.timeIntervalSince($0) }
                stage(layout: layout, order: order, intro: intro, t: t)
            }
            #if DEBUG
            .overlay(alignment: .topLeading) { CutProbeView(layout: layout, order: order, state: state) }
            #endif
        }
        .dynamicTypeSize(...DrawMetrics.nameTypeCap)
    }

    /// `-uiCutIntroFrame <seconds>` (fixture mode): the intro held at that moment.
    static var heldIntroFrame: TimeInterval? {
        #if DEBUG
        return UIFixture.cutIntroFrame
        #else
        return nil
        #endif
    }

    private var talking: Set<String> {
        var names = Set<String>()
        for sid in voice.speakingPeers {
            if sid == "self" { names.insert(authState.username) }
            else if let u = voice.peerInfos[sid]?.username { names.insert(u) }
        }
        if voice.isSelfSpeaking { names.insert(authState.username) }
        return names
    }

    @ViewBuilder
    private func stage(layout: CutRing.Layout, order: [String], intro: CutIntro, t: TimeInterval?) -> some View {
        let s = state
        let pending = model.verdictPending(s)
        let talk = talking
        let stageOpacity = t.map { intro.stageOpacity($0) } ?? 1
        ZStack(alignment: .topLeading) {
            // the cards under the seats' names, the deck in the middle
            ForEach(Array(order.enumerated()), id: \.element) { k, username in
                if k < layout.seats.count {
                    let seat = layout.seats[k]
                    let p = t.map { intro.seat(k, of: order.count, at: $0) } ?? 1
                    CutCardStack(model: model, username: username, seat: seat, layout: layout, verdictPending: pending)
                        .opacity(p >= 1 ? 1 : 0)
                }
            }
            CutDeckView(model: model, layout: layout, intro: intro, t: t)
                .frame(width: layout.deck.width, height: layout.deck.height)
                .position(x: layout.deck.midX, y: layout.deck.midY)
            CutGhosts(model: model, order: order, layout: layout)
            // the seats, one VoiceOver container in ring order (me first)
            ZStack(alignment: .topLeading) {
                ForEach(Array(order.enumerated()), id: \.element) { k, username in
                    if k < layout.seats.count {
                        let seat = layout.seats[k]
                        let p = t.map { intro.seat(k, of: order.count, at: $0) } ?? 1
                        CutSeatView(model: model, username: username, layout: layout, verdictPending: pending,
                                    talking: talk.contains(username))
                            .frame(width: layout.nameW)
                            .position(x: layout.cx + (seat.x - layout.cx) * p,
                                      y: layout.cy + (seat.avatar.minY + seatHeight(layout) / 2 - layout.cy) * p)
                            .opacity(p <= 0 ? 0 : min(1, Double(p) * 1.5))
                            .accessibilitySortPriority(Double(order.count - k))
                    }
                }
            }
            .frame(width: layout.w, height: layout.h, alignment: .topLeading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Players")
            .accessibilityIdentifier("cut.ring")
            if let w = model.winnerShown, let k = order.firstIndex(of: w), k < layout.seats.count {
                CutWinnerView(model: model, username: w, from: CGPoint(x: layout.seats[k].x, y: layout.seats[k].y), layout: layout)
                    .id(w)
            }
        }
        .opacity(stageOpacity)
        .frame(width: layout.w, height: layout.h, alignment: .topLeading)
    }

    private func seatHeight(_ layout: CutRing.Layout) -> CGFloat { layout.avatarD + 2 + layout.nameH }
}

/// The intro over whatever shows (owner 2026-11-25, "the intro when the cut starts"; iOS 1.2.7
/// (42)): the title, "Cut for a buck!", over the ring or the list; over the list (which has no deck
/// of its own: the ring fell back to it, or it was chosen) the deck's riffle and fan under the
/// title too, on a cover that hides the rows until the title goes (a crossfade with Reduce Motion).
/// The ring's own deck riffles and fans, and its avatars slide in (CutStageView). Same timeline
/// (CutIntro), never a hit target; VoiceOver reads the title as before, the deck is decoration.
struct CutIntroOverlay: View {
    enum Over { case ring, list }

    @ObservedObject var model: CutScreenModel
    let over: Over
    @EnvironmentObject var tournamentState: TournamentState

    var body: some View {
        if let start = model.introStart {
            TimelineView(.animation(minimumInterval: 1.0 / 60)) { ctx in
                let intro = CutIntro(reduceMotion: model.reduceMotion)
                let t = CutStageView.heldIntroFrame ?? ctx.date.timeIntervalSince(start)
                GeometryReader { geo in
                    ZStack {
                        if over == .list {
                            // to the screen's foot: the list scrolls under the home indicator
                            Theme.background
                                .opacity(intro.coverOpacity(t))
                                .ignoresSafeArea(.container, edges: .bottom)
                                .accessibilityHidden(true)
                        }
                        VStack(spacing: Theme.Space.s3) {
                            CutIntroTitle(intro: intro, t: t)
                            if over == .list {
                                let w = min(geo.size.width * 0.6, 220)
                                let h = min(w * 0.72, max(40, geo.size.height * 0.4))
                                CutIntroDeck(intro: intro, t: t, count: deckCount, deckSize: tournamentState.cut?.deckSize ?? CutState.deckSize)
                                    .frame(width: w, height: h)
                                    .opacity(intro.titleOpacity(t))
                                    .accessibilityHidden(true)
                            }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }
            .allowsHitTesting(false)
            .dynamicTypeSize(...DrawMetrics.nameTypeCap)
        }
    }

    private var deckCount: Int {
        guard let s = tournamentState.cut else { return CutState.deckSize }
        return s.stage == .drawing ? s.freeSlots.count : s.deckLeft
    }
}

/// The list's intro deck: the face-down fan riffling and spreading (CutIntro.riffle / fanSpread),
/// drawn as the ring's deck is.
struct CutIntroDeck: View {
    let intro: CutIntro
    let t: TimeInterval
    let count: Int
    let deckSize: Int

    var body: some View {
        GeometryReader { geo in
            let fan = CutFan(width: geo.size.width, height: geo.size.height, count: count, deckSize: deckSize)
            let back = CardTextureGenerator.cardBackImage(width: max(8, fan.cardW.rounded()), colour: .draw)
            Canvas { ctx, _ in
                CutFanDrawing.draw(in: ctx, fan: fan, back: back, count: count,
                                   spread: intro.fanSpread(t), riffle: intro.riffle(t), peek: nil)
            }
        }
    }
}

/// The face-down fan, drawn (the ring's deck and the list's intro deck).
enum CutFanDrawing {
    static func draw(in ctx: GraphicsContext, fan: CutFan, back: PlatformImage, count: Int,
                     spread: CGFloat, riffle: CGFloat, peek: Int?) {
        guard count > 0 else { return }
        let img = ctx.resolve(Image(platformImage: back).resizable())
        for i in 0..<count {
            var c = ctx
            let a = fan.angle(i, of: count) * spread
            let dx = (i % 2 == 0 ? -1 : 1) * riffle * fan.cardW * 0.6
            c.translateBy(x: fan.pivot.x + dx, y: fan.pivot.y)
            c.rotate(by: .radians(Double(a)))
            let up = peek == i ? fan.cardH * CutFan.lift : 0
            c.draw(img, in: CGRect(x: -fan.cardW / 2, y: -fan.cardH - up, width: fan.cardW, height: fan.cardH))
        }
    }
}

/// The intro's title, "Cut for a buck!", scaling in over the ring or the list.
struct CutIntroTitle: View {
    let intro: CutIntro
    let t: TimeInterval

    var body: some View {
        Text(CutCopy.introTitle)
            .themeFont(Theme.TypeScale.xxl, weight: Theme.Weight.bold, design: .rounded, relativeTo: .largeTitle)
            .foregroundStyle(Theme.gold)
            .shadow(color: Theme.gold.opacity(0.5), radius: 12)
            .multilineTextAlignment(.center)
            .minimumScaleFactor(0.5)
            .padding(.horizontal, Theme.Space.s4)
            .scaleEffect(intro.titleScale(t))
            .opacity(intro.titleOpacity(t))
            .allowsHitTesting(false)
            .accessibilityIdentifier("cut.intro")
    }
}

/// One player in the ring: the avatar (speaking ring, waiting pulse, winner glow), the name, the
/// caption; a tap shows their cards this deck and View Profile.
struct CutSeatView: View {
    @ObservedObject var model: CutScreenModel
    let username: String
    let layout: CutRing.Layout
    let verdictPending: Bool
    let talking: Bool

    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var authState: AuthState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.viewPlayerProfile) private var viewProfile
    @State private var pulse = false
    @State private var showsCards = false

    var body: some View {
        let me = tournamentState.isSpectator ? nil : authState.username
        let player = tournamentState.players.first { $0.username == username }
        let v = CutSeatView.look(tournamentState.cut, username, me: me, connected: player?.connected ?? true, talking: talking,
                                 verdictPending: verdictPending)
        let dimmed = v.look == .out || v.look == .left
        VStack(spacing: 2) {
            DrawAvatar(name: username, pictureKey: player?.pic, isLocal: username == me, diameter: layout.avatarD)
                .overlay {
                    if talking {
                        Circle().strokeBorder(Theme.success, lineWidth: 3).padding(-3)
                    } else if v.look == .waiting {
                        Circle().strokeBorder(Theme.gold, lineWidth: 2.5).padding(-3)
                            .opacity(reduceMotion ? 1 : (pulse ? 0.35 : 1))
                    } else if v.look == .winner {
                        Circle().strokeBorder(Theme.gold, lineWidth: 3).padding(-3)
                            .shadow(color: Theme.gold.opacity(0.8), radius: 8)
                    }
                }
                .onTapGesture { showsCards = true }
                .popover(isPresented: $showsCards) { cardsPopover(me: me).presentationCompactAdaptation(.popover) }
            Text(username == me ? "you" : username)
                .font(.caption.weight(.semibold))
                .foregroundStyle(username == me ? Theme.primary : Theme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .truncationMode(.tail)
            Text(v.caption.isEmpty ? " " : v.caption)
                .font(.caption2)
                .foregroundStyle(v.look == .winner ? Theme.gold : Theme.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .opacity(dimmed ? 0.4 : v.disconnected ? 0.6 : 1)
        .grayscale(dimmed ? 1 : 0)
        .animation(.easeInOut(duration: 0.3), value: dimmed)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(v.label)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Shows their cards this deck")
        .accessibilityAction { showsCards = true }
        .accessibilityIdentifier("cut.seat.\(username)")
        .accessibilityValue(v.look.rawValue)
    }

    static func look(_ s: CutState?, _ u: String, me: String?, connected: Bool, talking: Bool, verdictPending: Bool) -> CutSeatLook {
        CutSeatLook.of(s, u, me: me, connected: connected, talking: talking, verdictPending: verdictPending)
    }

    private func cardsPopover(me: String?) -> some View {
        let cards = tournamentState.cut?.table[username] ?? []
        return VStack(alignment: .leading, spacing: Theme.Space.s2) {
            Text(username == me ? "You" : username).font(.headline)
            Text(cards.isEmpty ? "No cards yet this deck" : "Cards this deck: \(cards.map(CutCopy.cardShort).joined(separator: ", "))")
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            if let viewProfile, username != me {
                Button("View Profile") {
                    showsCards = false
                    viewProfile(username)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(Theme.Space.s4)
        .frame(minWidth: 200, maxWidth: 300)
        .accessibilityIdentifier("cut.popover")
    }
}

/// A player's cards on the inward ray: the older ones behind the newest (up to 3, then "+n"); this
/// round's back while their draw is face down; the reveal's flip; the losing card's outline.
struct CutCardStack: View {
    @ObservedObject var model: CutScreenModel
    let username: String
    let seat: CutRing.Seat
    let layout: CutRing.Layout
    let verdictPending: Bool

    @EnvironmentObject var tournamentState: TournamentState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let s = tournamentState.cut
        let table = s?.table[username] ?? []
        let drawn = s?.stage == .drawing ? s?.drawn[username] : nil
        let total = table.count + (drawn == nil ? 0 : 1)
        let shown = min(total, CutRing.stackShown + 1)
        let hidden = total - shown
        let step = layout.dense ? CutRing.denseEdge : CutRing.stackOffset * layout.cardW
        let size = CGSize(width: layout.cardW, height: layout.cardH)
        let out = s?.out[username]
        let reveal = s?.lastReveal
        let revealIndex = reveal?.draws.firstIndex { $0.username == username }
        // the losing outline: only on a card that put its player out at the last reveal
        let lowRank = out != nil && out?.left != true && out?.round == reveal?.round && revealIndex != nil
            ? reveal.flatMap { CutSeatLook.lowestRank($0.draws.map(\.card)) } : nil
        ZStack(alignment: .topLeading) {
            ForEach(0..<shown, id: \.self) { vi in
                let i = hidden + vi
                let x = layout.stackW - CGFloat(shown - 1 - vi) * step
                Group {
                    if i < table.count {
                        let card = table[i]
                        let newest = i == table.count - 1
                        // the reveal's cards turn over while its verdict waits (a rejoin shows them face up)
                        let flips = newest && revealIndex != nil && verdictPending
                        let losing = newest && !verdictPending && lowRank != nil && CardConstants.rankValues[card.rank] == lowRank
                            && model.verdictRound == reveal?.round
                        CutRevealCard(card: card, size: size, flips: flips,
                                      delay: CutScreenModel.Timing.flipDelay + Double(revealIndex ?? 0) * CutScreenModel.Timing.flipStagger,
                                      flat: reduceMotion)
                            .overlay {
                                RoundedRectangle(cornerRadius: size.width * 0.08)
                                    .strokeBorder(Theme.danger, lineWidth: 2.5)
                                    .opacity(losing ? 1 : 0)
                            }
                            .id("\(username)-\(reveal?.round ?? 0)-\(i)-\(newest)")
                    } else {
                        CutFlyInCard(size: size, from: flightStart(username), reduce: reduceMotion)
                            .id("\(username)-back-\(s?.round ?? 0)")
                    }
                }
                .offset(x: x)
                .zIndex(Double(vi))
            }
            if hidden > 0 {
                Text("+\(hidden)")
                    .font(.caption2.bold())
                    .padding(.horizontal, 4)
                    .background(Capsule().fill(Theme.surface))
                    .foregroundStyle(Theme.textSecondary)
                    .offset(y: -6)
                    .zIndex(10)
            }
        }
        .frame(width: seat.stack.width, height: seat.stack.height, alignment: .topLeading)
        .position(x: seat.stack.midX, y: seat.stack.midY)
        .opacity(out != nil && !(verdictPending && out?.left != true && out?.round == reveal?.round) ? 0.55 : 1)
        .accessibilityHidden(true)
    }

    /// Where this player's face-down card starts: the touched card of the fan for mine, the deck's
    /// centre for anyone else (relative to the card's home).
    private func flightStart(_ u: String) -> CGSize {
        let from = (u == model.me ? model.myFlightFrom : nil) ?? CGPoint(x: layout.deck.midX, y: layout.deck.midY)
        let home = CGPoint(x: seat.card.midX, y: seat.card.midY)
        return CGSize(width: from.x - home.x, height: from.y - home.y)
    }
}

/// A revealed card: the face, or, for the reveal just in, the back turning over after `delay`.
struct CutRevealCard: View {
    let card: Card
    let size: CGSize
    let flips: Bool
    let delay: TimeInterval
    let flat: Bool
    @State private var angle: Double = 180

    var body: some View {
        FlipCard(angle: angle, face: CardTextureGenerator.image(for: card),
                 back: CardTextureGenerator.cardBackImage(width: size.width.rounded(), colour: .draw), size: size, flat: flat)
            .onAppear {
                guard flips else { return }
                angle = 0
                withAnimation(.easeInOut(duration: CutScreenModel.Timing.flip).delay(delay)) { angle = 180 }
            }
    }
}

/// A face-down card that flies in from `from` (offset from its home) after the lift.
struct CutFlyInCard: View {
    let size: CGSize
    let from: CGSize
    let reduce: Bool
    @State private var landed = false

    var body: some View {
        CardArtImage(image: CardTextureGenerator.cardBackImage(width: size.width.rounded(), colour: .draw), size: size)
            .offset(landed || reduce ? .zero : from)
            .opacity(reduce && !landed ? 0 : 1)
            .onAppear {
                withAnimation(reduce ? .easeIn(duration: 0.2)
                              : .timingCurve(0.2, 0, 0, 1, duration: CutScreenModel.Timing.flight).delay(CutScreenModel.Timing.lift)) {
                    landed = true
                }
            }
    }
}

/// The reshuffle: the table's cards fly back into the deck and fade.
struct CutGhosts: View {
    @ObservedObject var model: CutScreenModel
    let order: [String]
    let layout: CutRing.Layout

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(order.filter { (model.ghosts[$0] ?? 0) > 0 }, id: \.self) { u in
                if let k = order.firstIndex(of: u), k < layout.seats.count {
                    CutGhostCard(size: CGSize(width: layout.cardW, height: layout.cardH),
                                 from: CGPoint(x: layout.seats[k].card.midX, y: layout.seats[k].card.midY),
                                 to: CGPoint(x: layout.deck.midX, y: layout.deck.midY))
                        .id("\(u)-\(model.ghostSeq)")
                }
            }
        }
        .frame(width: layout.w, height: layout.h, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct CutGhostCard: View {
    let size: CGSize
    let from: CGPoint
    let to: CGPoint
    @State private var gone = false

    var body: some View {
        CardArtImage(image: CardTextureGenerator.cardBackImage(width: size.width.rounded(), colour: .draw), size: size)
            .scaleEffect(gone ? 0.6 : 1)
            .opacity(gone ? 0 : 1)
            .position(gone ? to : from)
            .onAppear { withAnimation(.easeIn(duration: CutScreenModel.Timing.reshuffle)) { gone = true } }
    }
}

/// The winner centre stage: twice the size, the gold glow, the buck glyph, gliding in from the seat.
struct CutWinnerView: View {
    @ObservedObject var model: CutScreenModel
    let username: String
    let from: CGPoint
    let layout: CutRing.Layout

    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var authState: AuthState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var arrived = false

    var body: some View {
        let size = min(layout.avatarD * 2, max(64, min(layout.deck.height * 1.1, 128)))
        let me = tournamentState.isSpectator ? nil : authState.username
        let pic = tournamentState.players.first { $0.username == username }?.pic
        VStack(spacing: Theme.Space.s2) {
            DrawAvatar(name: username, pictureKey: pic, isLocal: username == me, diameter: size)
                .overlay(Circle().strokeBorder(Theme.gold, lineWidth: 4).padding(-4))
                .shadow(color: Theme.gold.opacity(0.9), radius: 18)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "dollarsign.circle.fill")
                        .font(.system(size: size * 0.34))
                        .foregroundStyle(Theme.gold, Theme.background)
                        .background(Circle().fill(Theme.background).padding(2))
                        .offset(x: size * 0.06, y: size * 0.06)
                        .accessibilityHidden(true)
                }
                .scaleEffect(arrived || reduceMotion ? 1 : layout.avatarD / size)
                .offset(arrived || reduceMotion ? .zero : CGSize(width: from.x - layout.cx, height: from.y - layout.cy))
            Text(CutCopy.winnerLine(username, me: me))
                .font(.title3.bold())
                .foregroundStyle(Theme.gold)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Space.s3)
                .padding(.vertical, Theme.Space.s1)
                .background(Capsule().fill(Theme.surface.opacity(0.92)))
                .opacity(arrived ? 1 : 0)
        }
        .frame(maxWidth: layout.w)
        .position(x: layout.cx, y: layout.cy)
        .onAppear {
            withAnimation(reduceMotion ? .easeIn(duration: 0.3) : .spring(duration: CutScreenModel.Timing.winnerGlide, bounce: 0.2)) {
                arrived = true
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(CutCopy.winnerLine(username, me: me))
        .accessibilityIdentifier("cut.winner")
    }
}

// MARK: - The deck

/// The face-down fan: one draw target (at least 44 pt); the card under the finger peeks up and its
/// slot is what a release sends. Its caption: "37 cards left".
struct CutDeckView: View {
    @ObservedObject var model: CutScreenModel
    let layout: CutRing.Layout
    let intro: CutIntro
    let t: TimeInterval?

    @EnvironmentObject var tournamentState: TournamentState
    @State private var peek: Int?

    private static let captionH: CGFloat = 16

    var body: some View {
        let s = tournamentState.cut
        let free = s?.freeSlots ?? []
        let count = s?.stage == .drawing ? free.count : (s?.deckLeft ?? 0)
        let fanH = max(20, layout.deck.height - Self.captionH)
        let fan = CutFan(width: layout.deck.width, height: fanH, count: count, deckSize: s?.deckSize ?? CutState.deckSize)
        let can = model.canDraw(s)
        let spread = t.map { intro.fanSpread($0) } ?? 1
        let riffle = t.map { intro.riffle($0) } ?? 0
        let back = CardTextureGenerator.cardBackImage(width: max(8, fan.cardW.rounded()), colour: .draw)
        VStack(spacing: 0) {
            Canvas { ctx, _ in
                CutFanDrawing.draw(in: ctx, fan: fan, back: back, count: count,
                                   spread: spread, riffle: riffle, peek: can ? peek : nil)
            }
            .frame(width: layout.deck.width, height: fanH)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { g in
                    guard model.canDraw(tournamentState.cut) else { return }
                    let i = fan.index(at: g.location, of: count)
                    if i != peek { peek = i }
                }
                .onEnded { g in
                    let i = model.canDraw(tournamentState.cut) ? fan.index(at: g.location, of: count) : nil
                    draw(freeIndex: i, free: free, fan: fan, count: count)
                })
            Text(CutCopy.deckLine(s))
                .font(.caption2)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(height: Self.captionH)
                .accessibilityIdentifier("cut.deckCaption")
        }
        .shadow(color: can ? Theme.gold.opacity(0.55) : .clear, radius: 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(drawsHere ? CutCopy.drawACard : "Deck")
        .accessibilityValue(CutCopy.deckLine(s))
        .accessibilityAddTraits(drawsHere ? .isButton : [])
        .accessibilityAction { if drawsHere { draw(freeIndex: nil, free: free, fan: fan, count: count) } }
        .accessibilityIdentifier("cut.deck")
    }

    /// The deck is my draw target: a participant still in (or a candidate during the gather); for a
    /// spectator and a player who is out it is only the deck.
    private var drawsHere: Bool {
        guard !tournamentState.isSpectator, let s = tournamentState.cut else { return false }
        return s.stage == .gather ? s.isInCut(model.me) : s.isAlive(model.me)
    }

    private func draw(freeIndex: Int?, free: [Int], fan: CutFan, count: Int) {
        defer { peek = nil }
        guard !tournamentState.isSpectator else { return }
        let s = tournamentState.cut
        let slot = freeIndex.flatMap { $0 >= 0 && $0 < free.count ? free[$0] : nil }
        if model.canDraw(s) {
            let c = fan.centre(freeIndex ?? count / 2, of: count)
            model.myFlightFrom = CGPoint(x: layout.deck.minX + c.x, y: layout.deck.minY + c.y)
        }
        if model.draw(s, slot: slot) { CutLocalDraw.mark(tournamentState, me: model.me, slot: slot) }
    }
}

// MARK: - The list

/// Ring | List's list: a row a player in ring order (avatar, name, state, cards), with its own
/// Draw a card. The default at the accessibility text sizes on a compact width.
struct CutListView: View {
    @ObservedObject var model: CutScreenModel
    /// Its own scroll view (false: inside the accessibility sizes' one scroll).
    var scrolls = true
    /// Why the list shows instead of the ring (the ring cannot fit), over the rows.
    var note: String? = nil
    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var authState: AuthState

    var body: some View {
        let s = tournamentState.cut
        let me = tournamentState.isSpectator ? nil : authState.username
        let order = CutOrder.ring(s?.ringPlayers ?? [], me: me)
        let pending = model.verdictPending(s)
        let rows = VStack(spacing: Theme.Space.s2) {
                if let note {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("cut.listNote")
                }
                if let s, s.stage == .drawing, s.isAlive(me) {
                    CutDrawButton(model: model)
                }
                ForEach(order, id: \.self) { u in
                    let p = tournamentState.players.first { $0.username == u }
                    let v = CutSeatLook.of(s, u, me: me, connected: p?.connected ?? true, verdictPending: pending)
                    HStack(spacing: Theme.Space.s2) {
                        DrawAvatar(name: u, pictureKey: p?.pic, isLocal: u == me, diameter: 32)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(u == me ? "you" : u)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(u == me ? Theme.primary : Theme.textPrimary)
                            let caption = v.caption.isEmpty ? (v.look == .waiting ? "To draw" : (v.look == .drawn ? "Drew" : "")) : v.caption
                            if !caption.isEmpty {
                                Text(caption).font(.caption).foregroundStyle(Theme.textSecondary)
                            }
                        }
                        Spacer(minLength: Theme.Space.s2)
                        Text(v.cards.map(CutCopy.cardShort).joined(separator: " "))
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(Theme.textPrimary)
                            .multilineTextAlignment(.trailing)
                    }
                    .padding(.horizontal, Theme.Space.s3)
                    .padding(.vertical, Theme.Space.s2)
                    .background(RoundedRectangle(cornerRadius: Theme.Radius.sm).fill(Theme.surface.opacity(0.6)))
                    .opacity(v.look == .out || v.look == .left ? 0.45 : 1)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(v.label)
                    .accessibilityIdentifier("cut.row.\(u)")
                }
            }
            .padding(Theme.Space.s3)
        Group {
            if scrolls { ScrollView { rows } } else { rows }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("cut.list")
    }
}

#if DEBUG
/// A probe for XCUITest (fixture mode): "cut.ringFit" ("<ring|list> fits=<yes|no|-> stage=<w>x<h>",
/// what shows, whether the ring fits the stage, and the stage measured) and "cut.introCheck"
/// (the intro over either).
private struct CutProbe: View {
    let id: String
    let value: String
    var body: some View {
        Rectangle()
            .fill(Color.black)
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityLabel(id)
            .accessibilityIdentifier(id)
            .accessibilityValue(value)
    }
}

/// The "cut.layoutCheck" probe for XCUITest (fixture mode): "ok n=12 f=1.00 d=40 card=30x44 deck=...",
/// or what is wrong (the ring's own check: bounds, overlaps, the deck's floor).
private struct CutProbeView: View {
    let layout: CutRing.Layout
    let order: [String]
    let state: CutState?

    var body: some View {
        let check = layout.ok
            ? String(format: "ok n=%d f=%.2f d=%.0f card=%.0fx%.0f deck=%.0fx%.0f stage=%.0fx%.0f", layout.n, layout.f, layout.avatarD,
                     layout.cardW, layout.cardH, layout.deck.width, layout.deck.height, layout.w, layout.h)
            : "bad \(layout.why ?? "?") n=\(layout.n)"
        probe("cut.layoutCheck", check)
    }

    private func probe(_ id: String, _ value: String) -> some View {
        Rectangle()
            .fill(Color.black)
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityLabel(id)
            .accessibilityIdentifier(id)
            .accessibilityValue(value)
    }
}
#endif
