import SwiftUI

/// A rule tip of the tutorial (assistHint kind `tip`; State/Table/Tutorial.swift), in a neutral
/// style so it never reads as a suggestion (AssistCardView keeps the gold): its title, its text
/// and a close button ("Close tip"). The welcome tip (T.welcome) adds Keep and Turn off.
/// GameContainerView stacks it above the /help card (AssistLayout), so the first decision's tip
/// and advice never push the welcome away. VoiceOver hears each tip once (TableEffect.announce);
/// the card never takes focus.
struct TutorialTipView: View {
    let tip: AssistHint
    var onClose: () -> Void
    var onKeep: () -> Void = {}
    var onTurnOff: () -> Void = {}

    private var isWelcome: Bool { TutorialRules.isWelcome(tip) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s1) {
            HStack(spacing: Theme.Space.s2) {
                Image(systemName: "graduationcap.fill")
                    .font(.footnote)
                    .foregroundColor(Theme.textSecondary)
                    .accessibilityHidden(true)
                Text(tip.headline)
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("tip.title")
                Spacer(minLength: Theme.Space.s2)
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundColor(Theme.textSecondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle().inset(by: -8))  // a 44 pt target
                }
                .accessibilityLabel(TutorialRules.closeLabel)
                .accessibilityIdentifier("tip.close")
            }
            if let text = tip.reasons.first {
                Text(text)
                    .font(.footnote)
                    .foregroundColor(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("tip.text")
            }
            if isWelcome && !tip.actions.isEmpty {
                HStack(spacing: Theme.Space.s2) {
                    Spacer(minLength: 0)
                    if tip.actions.contains("off") {
                        Button(action: onTurnOff) {
                            Text(TutorialRules.offLabel)
                                .font(.footnote.weight(.semibold))
                                .foregroundColor(Theme.textPrimary)
                                .padding(.horizontal, Theme.Space.s3)
                                .frame(minHeight: 32)
                                .background(Capsule().strokeBorder(Theme.inputBorder, lineWidth: 1))
                                .contentShape(Capsule())
                        }
                        .accessibilityIdentifier("tip.off")
                    }
                    if tip.actions.contains("keep") {
                        Button(action: onKeep) {
                            Text(TutorialRules.keepLabel)
                                .font(.footnote.weight(.semibold))
                                .foregroundColor(Theme.buttonForeground)
                                .padding(.horizontal, Theme.Space.s4)
                                .frame(minHeight: 32)
                                .background(Capsule().fill(Theme.primary))
                                .contentShape(Capsule())
                        }
                        .accessibilityIdentifier("tip.keep")
                    }
                }
                .padding(.top, Theme.Space.s1)
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
        .accessibilityLabel(isWelcome ? TutorialRules.chipText : "Tip")
        .accessibilityIdentifier(isWelcome ? "tutorialWelcome" : "tutorialTip")
    }
}

/// "Tutorial on" with a small off switch, over the table at my seat while my tutorial is on
/// (GameState.showsTutorialChip): at the leading foot of the tutorial's column, above my hand or
/// the bid panel (AssistLayout keeps it off my bid clock, my seat's row, the lightbulb and the
/// fold). A tap sends /tutorial off (ActionCoordinator.tutorialOff); the switch shows off until
/// the server answers. VoiceOver: a toggle "Tutorial", "On".
struct TutorialChipView: View {
    /// /tutorial off is on its way.
    var switchingOff = false
    var action: () -> Void

    private var on: Bool { !switchingOff }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Space.s2) {
                Image(systemName: "graduationcap.fill")
                    .font(.caption)
                    .foregroundColor(Theme.textSecondary)
                    .accessibilityHidden(true)
                Text(TutorialRules.chipText)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(Theme.textPrimary)
                    .lineLimit(1)
                // the switch: a small track with its knob (on: the primary green)
                ZStack(alignment: on ? .trailing : .leading) {
                    Capsule()
                        .fill(on ? Theme.primary : Theme.textDim.opacity(0.5))
                        .frame(width: 30, height: 18)
                    Circle()
                        .fill(Color.white)
                        .frame(width: 14, height: 14)
                        .padding(2)
                }
                .accessibilityHidden(true)
            }
            .padding(.leading, Theme.Space.s3)
            .padding(.trailing, Theme.Space.s1)
            .frame(height: 30)
            .background(Capsule().fill(Theme.surface.opacity(0.92)))
            .overlay(Capsule().strokeBorder(Theme.inputBorder, lineWidth: 1))
            .elevation(Theme.Elevation.e1)
            .frame(minHeight: Theme.hitTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(switchingOff)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .animation(.easeInOut(duration: 0.15), value: switchingOff)
        .accessibilityLabel(TutorialRules.chipLabel)
        .accessibilityValue(on ? "On" : "Off")
        .accessibilityHint(TutorialRules.chipHint)
        .accessibilityAddTraits(.isToggle)
        .accessibilityIdentifier("tutorial.chip")
        .accessibilityShowsLargeContentViewer()
    }
}
