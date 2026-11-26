import SwiftUI

/// The full-screen update screen (s2c `updateRequired`, `UpdateRequiredState`): over every
/// screen, the server's message and Open the App Store (`AppStoreLink`, the url the server
/// sent). No dismiss: everything this build sends gets the update message only. The saved
/// session is kept, so the updated app opens signed in.
struct UpdateRequiredView: View {
    let notice: UpdateRequiredNotice
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            GeometryReader { geo in
                ScrollView {
                    VStack(spacing: Theme.Space.s5) {
                        Image(systemName: "arrow.down.app.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(Theme.primary)
                            .accessibilityHidden(true)
                        Text("Update BAB Online")
                            .themeFont(Theme.TypeScale.xl, weight: Theme.Weight.bold, relativeTo: .title2)
                            .foregroundColor(Theme.textPrimary)
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)
                        Text(notice.message)
                            .font(.body)
                            .foregroundColor(Theme.textSecondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("updateRequired.message")
                        Button(action: { openURL(notice.url) }) {
                            Text("Open the App Store")
                                .font(.body.bold())
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(Theme.buttonBackground)
                                .foregroundColor(Theme.buttonForeground)
                                .cornerRadius(Theme.Radius.md)
                        }
                        .accessibilityIdentifier("updateRequired.appStore")
                    }
                    .padding(.vertical, Theme.Space.s6)
                    .padding(.horizontal, Theme.Space.s5)
                    .background(RoundedRectangle(cornerRadius: Theme.Radius.lg).fill(Theme.surface))
                    .frame(maxWidth: 420)
                    .padding(Theme.Space.s4)
                    .frame(maxWidth: .infinity, minHeight: geo.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("updateRequired")
    }
}
