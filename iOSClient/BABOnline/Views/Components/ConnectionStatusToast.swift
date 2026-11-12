import SwiftUI

/// Floating pill that shows reconnection status after the app foregrounds, and
/// "Restarting for an update…" from the server's serverShutdown until the socket is back.
struct ConnectionStatusToast: View {
    @EnvironmentObject var socketService: SocketService
    @ObservedObject private var restart = RestartNotices.shared
    @State private var wasDisconnected = false
    @State private var showToast = false
    @State private var isReconnected = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func text(reconnected: Bool, restarting: Bool) -> String {
        if reconnected { return "Connected!" }
        return restarting ? RestartNotices.restartingText : "Reconnecting..."
    }

    var body: some View {
        VStack {
            if showToast {
                HStack(spacing: Theme.Space.s2) {
                    if isReconnected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(Theme.success)
                            .accessibilityHidden(true)
                    } else {
                        ProgressView()
                            .tint(Theme.warning)
                            .accessibilityHidden(true)
                    }
                    Text(Self.text(reconnected: isReconnected, restarting: restart.isRestarting))
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
        .overlay(alignment: .top) {
            ServerErrorToast()
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
private struct ServerErrorToast: View {
    @EnvironmentObject var socketService: SocketService
    @State private var notice: ServerErrorNotice?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack {
            if let notice {
                HStack(spacing: Theme.Space.s2) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundColor(Theme.warning)
                        .accessibilityHidden(true)
                    Text(notice.message)
                        .font(.callout.bold())
                        .foregroundColor(Theme.textPrimary)
                        .multilineTextAlignment(.leading)
                }
                .padding(.horizontal, Theme.Space.s4)
                .padding(.vertical, 10)
                .background(Theme.surface)
                .clipShape(Capsule())
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
        .onChange(of: socketService.serverError) { _, newNotice in
            guard let newNotice else { return }
            withAnimation(.easeInOut(duration: 0.3)) {
                notice = newNotice
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                // Only hide if a newer error hasn't replaced this one
                guard notice?.id == newNotice.id else { return }
                withAnimation(.easeInOut(duration: 0.3)) {
                    notice = nil
                }
            }
        }
    }
}
