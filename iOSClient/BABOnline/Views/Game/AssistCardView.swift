import SwiftUI

/// The /help card (help plan 4.5; the web's ui/components/AssistCard.js; words and rules in
/// State/Table/AssistHint.swift): my private answer to /help (s2c assistHint), drawn over the
/// table just above my hand, or above the bid panel while I bid (GameContainerView places it
/// from TableLayout, so on the Duo it follows the hand's container below the fold). Only I see it.
///
///   the confidence chip ("Clear choice") and the close button ("Dismiss suggestion")
///   the headline ("Bid 4", "Lead A♣")
///   up to 2 reasons
///   the note (amber): the warning on the last free use, or "This game now counts as
///     bot-assisted for you."
///   "Why?" and up to 4 details
///   the footer: "What our strongest bot would play · Help 2 of 3 free" (in a game with a
///     native bot seat just "What our strongest bot would play", and no note: AssistRules.footer)
///
/// A status reply (off turn, a refusal) is the same card with the headline only. VoiceOver hears
/// the headline and the main reason once (TableEffect.announce); the card never takes focus.
struct AssistCardView: View {
    let hint: AssistHint
    /// My tutorial is on: a /help answer then is never counted (AssistRules.footer).
    var tutorialOn = false
    /// A watched seat's hint (the over-the-shoulder view, assistHint `watched`): the name of the
    /// player whose hand it is. The card then says whose it is ("Alice's advice") and shows no
    /// count, no "Not counted", no bot-assisted words and no note (AssistRules.watchedFooter);
    /// VoiceOver "Suggestion for Alice". nil: my own answer, drawn exactly as before.
    var watchedName: String? = nil
    /// The close (×). For a watched card it must only take the card down (nothing is sent).
    var onClose: () -> Void

    @State private var showsWhy = false

    private var isStatus: Bool { hint.kind == .status }
    private var isWatched: Bool { watchedName != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s1) {
            if isWatched {
                watchedTopRows
            } else {
                HStack(spacing: Theme.Space.s2) {
                    bulb
                    confidenceChip
                    Spacer(minLength: Theme.Space.s2)
                    closeButton
                }
            }
            Text(hint.headline)
                .font(isStatus ? .subheadline.weight(.medium) : .headline)
                .foregroundColor(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("assist.headline")
                // the column scrolls this into sight when it is short (GameContainerView.assistColumn)
                .id(AssistLayout.adviceHeadId)
            if !isStatus {
                ForEach(Array(hint.reasons.enumerated()), id: \.offset) { _, reason in
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s1) {
                        Text("\u{2022}").accessibilityHidden(true)
                        Text(reason).fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.footnote)
                    .foregroundColor(Theme.textPrimary)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("assist.reason")
                }
            }
            if !isWatched, let note = hint.note {
                Text(note)
                    .font(.footnote.weight(.semibold))
                    .foregroundColor(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Theme.Space.s1)
                    .accessibilityIdentifier("assist.note")
            }
            if !isStatus && !hint.details.isEmpty {
                Button(action: { withAnimation(.easeInOut(duration: 0.2)) { showsWhy.toggle() } }) {
                    HStack(spacing: 2) {
                        Text(AssistRules.whyLabel)
                        Image(systemName: showsWhy ? "chevron.down" : "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .accessibilityHidden(true)
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundColor(Theme.gold)
                    .frame(minHeight: 28)
                    .contentShape(Rectangle())
                }
                .accessibilityIdentifier("assist.why")
                .accessibilityValue(showsWhy ? "Expanded" : "Collapsed")
                if showsWhy {
                    ForEach(Array(hint.details.enumerated()), id: \.offset) { _, detail in
                        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s1) {
                            Text("\u{2022}").accessibilityHidden(true)
                            Text(detail).fixedSize(horizontal: false, vertical: true)
                        }
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("assist.detail")
                    }
                }
            }
            if let footer = isWatched ? AssistRules.watchedFooter(hint) : AssistRules.footer(hint, tutorial: tutorialOn) {
                Text(footer)
                    .font(.caption)
                    .foregroundColor(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Theme.Space.s1)
                    .accessibilityIdentifier("assist.footer")
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
                .strokeBorder(isStatus ? Theme.inputBorder : Theme.gold.opacity(0.55), lineWidth: 1)
        )
        // over the table: a few lines at most at the largest sizes (as the disconnect banner)
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(isWatched ? AssistRules.watchedLabel(watchedName) : "Suggestion")
        .accessibilityIdentifier("assistCard")
        // a new answer starts with its details closed
        .onChange(of: hint) { showsWhy = false }
    }

    private var bulb: some View {
        Image(systemName: "lightbulb.fill")
            .foregroundColor(Theme.gold)
            .accessibilityHidden(true)
    }

    @ViewBuilder private var confidenceChip: some View {
        if let label = AssistRules.confidenceLabel(hint) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundColor(hint.confidence == "quick" ? Theme.warning : Theme.gold)
                .padding(.horizontal, Theme.Space.s2)
                .padding(.vertical, 1)
                .background(Capsule().fill((hint.confidence == "quick" ? Theme.warning : Theme.gold).opacity(0.18)))
                .accessibilityIdentifier("assist.confidence")
        }
    }

    private var closeButton: some View {
        Button(action: onClose) {
            Image(systemName: "xmark")
                .font(.footnote.weight(.semibold))
                .foregroundColor(Theme.textSecondary)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle().inset(by: -8))  // a 44 pt target
        }
        .accessibilityLabel(AssistRules.dismissLabel)
        .accessibilityIdentifier("assist.close")
    }

    /// A watched card's first rows: "Alice's advice" beside the chip where both fit whole on one
    /// line, else the heading on a full-width line of its own (its name cut with "…" only where
    /// even that is short, never its "'s advice") over the card's own row, chip and close whole.
    @ViewBuilder private var watchedTopRows: some View {
        if let name = AssistRules.watchedHeadingName(watchedName) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.Space.s2) {
                    bulb
                    WatchedHeading(name: name, suffix: AssistRules.watchedSuffix, id: "assist.watched", fits: true)
                    confidenceChip.fixedSize()
                    Spacer(minLength: Theme.Space.s2)
                    closeButton
                }
                VStack(alignment: .leading, spacing: Theme.Space.s1) {
                    WatchedHeading(name: name, suffix: AssistRules.watchedSuffix, id: "assist.watched")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, Theme.Space.s1)
                    ownTopRow
                }
            }
        } else {
            ownTopRow
        }
    }

    private var ownTopRow: some View {
        HStack(spacing: Theme.Space.s2) {
            bulb
            confidenceChip
            Spacer(minLength: Theme.Space.s2)
            closeButton
        }
    }
}

/// A watched card's heading (AssistCardView, TutorialTipHead): the player's name and the words
/// after it ("'s advice", "'s tip") on one line. `fits`: drawn at its full width (a
/// ViewThatFits candidate); else the name gives way with "…" and the words always show.
/// VoiceOver reads it as one text, "Alice's advice".
struct WatchedHeading: View {
    let name: String
    let suffix: String
    let id: String
    var fits = false

    var body: some View {
        HStack(spacing: 0) {
            Text(name)
                .lineLimit(1)
                .truncationMode(.tail)
                .fixedSize(horizontal: fits, vertical: false)
            Text(suffix)
                .lineLimit(1)
                .fixedSize()
        }
        .font(.footnote.weight(.semibold))
        .foregroundColor(Theme.textSecondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name + suffix)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier(id)
    }
}

/// The lightbulb by my hand (the web's "?"): on my own bid or play turn at my seat while no
/// answer is up or on its way (AssistRules.showsAsk); a tap sends /help (ActionCoordinator.askHelp).
struct AssistAskButton: View {
    var size: CGFloat = 36
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "lightbulb.fill")
                .font(.system(size: size * 0.48, weight: .semibold))
                .foregroundColor(Theme.gold)
                .frame(width: size, height: size)
                .background(Circle().fill(Theme.surface.opacity(0.9)))
                .overlay(Circle().strokeBorder(Theme.gold.opacity(0.7), lineWidth: 1))
                .elevation(Theme.Elevation.e1)
                .frame(width: max(size, Theme.hitTarget), height: max(size, Theme.hitTarget))
                .contentShape(Rectangle())
        }
        .accessibilityLabel(AssistRules.askLabel)
        .accessibilityHint("Sends /help. Only you see the answer; the table sees that you asked.")
        .accessibilityIdentifier("assist.ask")
        .accessibilityShowsLargeContentViewer()
    }
}
