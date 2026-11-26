import SwiftUI

/// Floating pill that shows reconnection status after the app foregrounds, and
/// "Restarting for an update…" from the server's serverShutdown until the socket is back.
/// Also "Reconnecting..." while a retryable restore failure is retried (AuthState.restoreRetrying).
struct ConnectionStatusToast: View {
    @EnvironmentObject var socketService: SocketService
    @EnvironmentObject var authState: AuthState
    @ObservedObject private var restart = RestartNotices.shared
    @State private var wasDisconnected = false
    @State private var showToast = false
    @State private var isReconnected = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func text(reconnected: Bool, restarting: Bool) -> String {
        if reconnected { return "Connected!" }
        return restarting ? RestartNotices.restartingText : "Reconnecting..."
    }

    /// What the pill shows. A restore retry shows "Reconnecting..." for as long as it lasts,
    /// read from AuthState rather than an onChange: the toast is often inserted with the flag
    /// already true (cold launch), and the 2 s "Connected!" hide can land mid-retry.
    static func display(showToast: Bool, isReconnected: Bool, restoreRetrying: Bool) -> (visible: Bool, reconnected: Bool) {
        (showToast || restoreRetrying, isReconnected && !restoreRetrying)
    }

    var body: some View {
        let shown = Self.display(showToast: showToast, isReconnected: isReconnected, restoreRetrying: authState.restoreRetrying)
        VStack {
            if shown.visible {
                HStack(spacing: Theme.Space.s2) {
                    if shown.reconnected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(Theme.success)
                            .accessibilityHidden(true)
                    } else {
                        ProgressView()
                            .tint(Theme.warning)
                            .accessibilityHidden(true)
                    }
                    Text(Self.text(reconnected: shown.reconnected, restarting: restart.isRestarting))
                        .font(.callout.bold())
                        .foregroundColor(Theme.textPrimary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("connectionToast")
                .padding(.horizontal, Theme.Space.s4)
                .padding(.vertical, 10)
                .background(Theme.surface)
                .clipShape(Capsule())
                .elevation(Theme.Elevation.e2)
                .transition(.motion(.move(edge: .top).combined(with: .opacity), reduceMotion: reduceMotion))
                .padding(.top, Theme.Space.s2)
            }
            Spacer()
        }
        // The screen's width, not the pill's: the server-error toast below is an overlay of
        // this stack, and while the pill is hidden the stack held only a Spacer (no width),
        // so the error toast got none and showed a tall, empty capsule (owner, 2026-11-16)
        .frame(maxWidth: .infinity)
        .animation(.easeInOut(duration: 0.3), value: authState.restoreRetrying)
        .overlay(alignment: .top) {
            ServerErrorToast()
        }
        // the voice panel tip shows where this pill does: it waits while the pill is up
        .onChange(of: shown.visible, initial: true) { _, visible in
            VoicePanelTip.shared.cover(.connection, visible)
            BadgeAwards.shared.cover(.connection, visible)
        }
        .onDisappear {
            VoicePanelTip.shared.cover(.connection, false)
            BadgeAwards.shared.cover(.connection, false)
        }
        // the notice comes ~1 s before the server closes the socket: show it at once
        .onChange(of: restart.isRestarting) { _, restarting in
            if restarting {
                withAnimation(.easeInOut(duration: 0.3)) {
                    isReconnected = false
                    showToast = true
                }
            } else if socketService.isConnected && !wasDisconnected {
                // the server never closed the socket after all
                withAnimation(.easeInOut(duration: 0.3)) { showToast = false }
            }
        }
        .onChange(of: socketService.isConnected) { _, connected in
            if !connected {
                wasDisconnected = true
                withAnimation(.easeInOut(duration: 0.3)) {
                    isReconnected = false
                    showToast = true
                }
            } else if wasDisconnected {
                withAnimation(.easeInOut(duration: 0.3)) {
                    isReconnected = true
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        showToast = false
                    }
                    wasDisconnected = false
                }
            }
        }
    }
}

/// Floating pill for user-facing server errors ('error' events), auto-dismissed.
struct ServerErrorToast: View {
    /// How long a notice stays up; UI fixtures keep it longer so a test can measure it.
    static var visibleSeconds: Double = 3.0

    @EnvironmentObject var socketService: SocketService
    @State private var notice: ServerErrorNotice?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack {
            if let notice {
                HStack(spacing: Theme.Space.s2) {
                    Image(systemName: notice.kind == .info ? "info.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundColor(notice.kind == .info ? Theme.teamA : Theme.warning)
                        .accessibilityHidden(true)
                    Text(notice.message)
                        .font(.callout.bold())
                        .foregroundColor(Theme.textPrimary)
                        .multilineTextAlignment(.leading)
                        // a long message wraps at the screen's width, never per glyph
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(notice.kind == .info ? "infoToast" : "serverErrorToast")
                .padding(.horizontal, Theme.Space.s4)
                .padding(.vertical, 10)
                .background(Theme.surface)
                // a capsule on one line; two lines keep rounded corners, not half-circles
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .elevation(Theme.Elevation.e2)
                .transition(.motion(.move(edge: .top).combined(with: .opacity), reduceMotion: reduceMotion))
                .padding(.top, Theme.Space.s2)
                .padding(.horizontal, Theme.Space.s4)
                .onTapGesture {
                    withAnimation(.easeInOut(duration: 0.3)) { self.notice = nil }
                }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
        // the voice panel tip shows in this spot: it waits while a notice is up (and comes back
        // after one that arrived while it showed)
        // the badge toast too
        .onChange(of: notice == nil) { _, none in
            VoicePanelTip.shared.cover(.notice, !none)
            BadgeAwards.shared.cover(.notice, !none)
        }
        .onDisappear {
            VoicePanelTip.shared.cover(.notice, false)
            BadgeAwards.shared.cover(.notice, false)
        }
        .onChange(of: socketService.serverError) { _, newNotice in
            guard let newNotice else { return }
            show(newNotice)
        }
        // mounted just after a notice was posted (the sign-in's layer after forceLogout replaces
        // the signed-in one in the same update): it still shows
        .onAppear {
            if notice == nil, let n = socketService.serverError, Self.fresh(n) { show(n) }
        }
    }

    /// A notice this recent still shows in a toast layer that has just mounted.
    static func fresh(_ n: ServerErrorNotice, now: Date = Date()) -> Bool { now.timeIntervalSince(n.at) < 1.5 }

    private func show(_ newNotice: ServerErrorNotice) {
        withAnimation(.easeInOut(duration: 0.3)) {
            notice = newNotice
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.visibleSeconds) {
            // Only hide if a newer error hasn't replaced this one
            guard notice?.id == newNotice.id else { return }
            withAnimation(.easeInOut(duration: 0.3)) {
                notice = nil
            }
        }
    }
}
