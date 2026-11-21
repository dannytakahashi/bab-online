import SwiftUI

/// A rule tip of the tutorial (assistHint kind `tip`; State/Table/Tutorial.swift), in a neutral
/// style so it never reads as a suggestion (AssistCardView keeps the gold): its title, its text
/// and a close button ("Close tip"). GameContainerView stacks it above the /help card
/// (AssistLayout). The welcome tip (T.welcome) is no card on iOS (owner 2026-11-21: the
/// tutorial's button says it is on and turns it off): its text goes to the log
/// (TableReducer.tutorialTip). VoiceOver hears each tip once (TableEffect.announce);
/// the card never takes focus.
struct TutorialTipView: View {
    let tip: AssistHint
    /// A watched seat's tip (the over-the-shoulder view, assistHint `watched`): the name of the
    /// player whose hand it is ("Alice's tip" over the title; VoiceOver "Tip for Alice"). nil: my
    /// own tip, drawn exactly as before.
    var watchedName: String? = nil
    /// The close (×). For a watched tip it must only take the card down (nothing is sent).
    var onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s1) {
            TutorialTipHead(tip: tip, watchedName: watchedName, onClose: onClose)
            if let text = tip.reasons.first {
                Text(text)
                    .font(.footnote)
                    .foregroundColor(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("tip.text")
            }
        }
        .padding(.horizontal, Theme.Space.s3)
        .padding(.top, Theme.Space.s1)
        .padding(.bottom, Theme.Space.s3)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.surface.opacity(0.96))
                .elevation(Theme.Elevation.e2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .strokeBorder(Theme.inputBorder, lineWidth: 1)
        )
        // over the table: a few lines at most at the largest sizes (as AssistCardView)
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(watchedName == nil ? "Tip" : TutorialRules.watchedLabel(watchedName))
        .accessibilityIdentifier("tutorialTip")
    }
}

/// A tip's title row: the cap, its title and its close (×). TutorialTipView's first row, and
/// the row a short column pins at its top while the tip is scrolled up to keep the advice in
/// sight (GameContainerView.pinnedTipHead; the web's sticky .assist-tip__top).
struct TutorialTipHead: View {
    let tip: AssistHint
    /// A watched seat's tip (TutorialTipView.watchedName): "Alice's tip" on a full-width line of
    /// its own (the name cut with "…" only where even that is short, never "'s tip") over
    /// today's row. nil: today's one row.
    var watchedName: String? = nil
    var onClose: () -> Void
    /// The pinned copy (identifiers "tip.pinned…": the card's own row is still in the tree,
    /// scrolled up).
    var pinned = false

    var body: some View {
        if let name = watchedName.flatMap(AssistRules.watchedHeadingName) {
            VStack(alignment: .leading, spacing: Theme.Space.s1) {
                WatchedHeading(name: name, suffix: TutorialRules.watchedSuffix, id: pinned ? "tip.pinnedWatched" : "tip.watched")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Theme.Space.s1)
                ownRow
            }
        } else {
            ownRow
        }
    }

    private var ownRow: some View {
        HStack(spacing: Theme.Space.s2) {
            cap
            title
            Spacer(minLength: Theme.Space.s2)
            closeButton
        }
    }

    private var cap: some View {
        Image(systemName: "graduationcap.fill")
            .font(.footnote)
            .foregroundColor(Theme.textSecondary)
            .accessibilityHidden(true)
    }

    private var title: some View {
        Text(tip.headline)
            .font(.subheadline.weight(.semibold))
            .foregroundColor(Theme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(pinned ? "tip.pinnedTitle" : "tip.title")
    }

    private var closeButton: some View {
        Button(action: onClose) {
            Image(systemName: "xmark")
                .font(.footnote.weight(.semibold))
                .foregroundColor(Theme.textSecondary)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle().inset(by: -8))  // a 44 pt target
        }
        .accessibilityLabel(TutorialRules.closeLabel)
        .accessibilityIdentifier(pinned ? "tip.pinnedClose" : "tip.close")
    }
}

/// The tutorial's switch in the table's top trailing corner, under the game log's button (owner
/// 2026-11-21: "a tutorial button on regular iPhone and iPad, below game log button"), for my
/// own seat the whole game, on or off (GameState.showsAssistBarItem), as the iPhone Duo's
/// vertical bar item (GameContainerView.tutorialBarToggle). The log button's round shape; while
/// on, the cap and a ring in the primary green. A tap off -> on asks first where the game would
/// count as bot-assisted (TutorialRules.needsConfirm), on -> off sends /tutorial off; it shows
/// off and waits while an off is on its way (on likewise). VoiceOver: a toggle "Tutorial",
/// value "On" / "Off" (the Duo's bar item, which keeps no value, says the state in its label).
struct TutorialCornerButton: View {
    /// The tutorial is on (the server's word, or an on on its way) and no off is on its way.
    let on: Bool
    var disabled = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "graduationcap.fill")
                .font(.title2)
                .foregroundColor(on ? Theme.primary : Theme.textSecondary)
                .modifier(CornerGlyphBox())
                .padding(Theme.Space.s3)
                .background(Theme.surface.opacity(0.8))
                .clipShape(Circle())
                // on: the green cap in a green ring (a solid green disc outshouted the log's button)
                .overlay(Circle().strokeBorder(on ? Theme.primary : .clear, lineWidth: 2))
                .opacity(disabled ? 0.6 : 1)
        }
        .disabled(disabled)
        .animation(.easeInOut(duration: 0.15), value: on)
        .accessibilityLabel(TutorialRules.chipLabel)
        .accessibilityValue(on ? "On" : "Off")
        .accessibilityHint(on ? TutorialRules.chipHint : TutorialRules.barOnHint)
        .accessibilityAddTraits(.isToggle)
        .accessibilityIdentifier("tutorial.chip")
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .accessibilityShowsLargeContentViewer()
    }
}

/// The corner's round buttons' glyph box (the game log's and the tutorial's): a square of
/// title2's size, scaled with Dynamic Type inside each button (which caps it at xxLarge), so
/// both circles are the same size and the log's does not change with its glyph (a padded
/// text.bubble.fill was 53 x 50 pt, xmark.circle.fill smaller).
struct CornerGlyphBox: ViewModifier {
    @ScaledMetric(relativeTo: .title2) private var side: CGFloat = 26
    func body(content: Content) -> some View {
        content.frame(width: side, height: side)
    }
}
