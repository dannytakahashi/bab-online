import SwiftUI

/// The app's App Store page (the web phone gate's link, client/src/boot/deviceGate.js
/// APP_STORE_URL: storefront-neutral, so Apple sends each player to their own store).
enum AppStoreLink {
    static let appId = "6759510890"
    static let url = URL(string: "https://apps.apple.com/app/id\(appId)")!
}

enum UnreadableTableLeave {
    /// How long Leave waits for the server's leftGame before leaving on its own.
    static let fallback: TimeInterval = 3
}

/// Over the table while a snapshot could not be shown (TableSlice.snapshotTrouble): "reloading"
/// during the bounded retries, then "update the app". No dismiss, since the table under it is
/// not the server's, but always a way out: Leave Game, and the App Store once retries are spent.
struct UnreadableTableView: View {
    let trouble: SnapshotTrouble
    let onLeave: () -> Void
    @Environment(\.openURL) private var openURL

    /// The message once retries are spent (pinned by UnreadableSnapshotTests).
    static let updateMessage = "This version of the app can't show this table. Update BAB Online from the App Store."

    var body: some View {
        ZStack {
            Theme.scrim.ignoresSafeArea()
            GeometryReader { geo in
                ScrollView {
                    card
                        .frame(maxWidth: 420)
                        .padding(Theme.Space.s4)
                        .frame(maxWidth: .infinity, minHeight: geo.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("unreadableTable")
    }

    private var card: some View {
        VStack(spacing: Theme.Space.s5) {
            if trouble == .unreadable {
                Text("Update BAB Online")
                    .themeFont(Theme.TypeScale.xl, weight: Theme.Weight.bold, relativeTo: .title2)
                    .foregroundColor(Theme.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(Self.updateMessage)
                    .font(.body)
                    .foregroundColor(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: { openURL(AppStoreLink.url) }) {
                    Text("Open the App Store")
                        .font(.body.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Theme.buttonBackground)
                        .foregroundColor(Theme.buttonForeground)
                        .cornerRadius(Theme.Radius.md)
                }
                .accessibilityIdentifier("unreadableTable.appStore")
            } else {
                ProgressView()
                    .tint(Theme.textSecondary)
                Text("Reloading the table…")
                    .font(.body)
                    .foregroundColor(Theme.textSecondary)
            }
            Button(action: onLeave) {
                Text("Leave Game")
                    .font(.body.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .secondaryButtonStyle(radius: Theme.Radius.md)
            }
            .accessibilityIdentifier("unreadableTable.leave")
        }
        .padding(.vertical, Theme.Space.s6)
        .padding(.horizontal, Theme.Space.s5)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.lg).fill(Theme.surface))
    }
}
