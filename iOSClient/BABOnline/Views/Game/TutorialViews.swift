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
    var onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s1) {
            TutorialTipHead(tip: tip, onClose: onClose)
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
        .accessibilityLabel("Tip")
        .accessibilityIdentifier("tutorialTip")
    }
}

/// A tip's title row: the cap, its title and its close (×). TutorialTipView's first row, and
/// the row a short column pins at its top while the tip is scrolled up to keep the advice in
/// sight (GameContainerView.pinnedTipHead; the web's sticky .assist-tip__top).
struct TutorialTipHead: View {
    let tip: AssistHint
    var onClose: () -> Void
    /// The pinned copy (identifiers "tip.pinned…": the card's own row is still in the tree,
    /// scrolled up).
    var pinned = false

    var body: some View {
        HStack(spacing: Theme.Space.s2) {
            Image(systemName: "graduationcap.fill")
                .font(.footnote)
                .foregroundColor(Theme.textSecondary)
                .accessibilityHidden(true)
            Text(tip.headline)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier(pinned ? "tip.pinnedTitle" : "tip.title")
            Spacer(minLength: Theme.Space.s2)
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
    /// The log button's measured diameter, so the two match (nil: the glyph's own size).
    var diameter: CGFloat? = nil
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "graduationcap.fill")
                .font(.title2)
                .foregroundColor(on ? Theme.primary : Theme.textSecondary)
                .padding(Theme.Space.s3)
                .frame(width: diameter, height: diameter)
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
