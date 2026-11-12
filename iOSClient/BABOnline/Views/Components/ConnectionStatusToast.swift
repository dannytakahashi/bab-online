import SwiftUI

/// Floating pill that shows reconnection status after the app foregrounds.
struct ConnectionStatusToast: View {
    @EnvironmentObject var socketService: SocketService
    @State private var wasDisconnected = false
    @State private var showToast = false
    @State private var isReconnected = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack {
            if showToast {
                HStack(spacing: Theme.Space.s2) {
                    if isReconnected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(Theme.success)
                    } else {
                        ProgressView()
                            .tint(Theme.warning)
                    }
                    Text(isReconnected ? "Connected!" : "Reconnecting...")
                        .font(.callout.bold())
                        .foregroundColor(Theme.textPrimary)
                }
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
