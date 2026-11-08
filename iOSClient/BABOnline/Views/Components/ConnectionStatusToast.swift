import SwiftUI

/// Floating pill that shows reconnection status after the app foregrounds.
struct ConnectionStatusToast: View {
    @EnvironmentObject var socketService: SocketService
    @State private var wasDisconnected = false
    @State private var showToast = false
    @State private var isReconnected = false

    var body: some View {
        VStack {
            if showToast {
                HStack(spacing: 8) {
                    if isReconnected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(Color.Theme.success)
                    } else {
                        ProgressView()
                            .tint(Color.Theme.warning)
                    }
                    Text(isReconnected ? "Connected!" : "Reconnecting...")
                        .font(.callout.bold())
                        .foregroundColor(Color.Theme.textPrimary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.Theme.surface)
                .clipShape(Capsule())
                .shadow(color: .black.opacity(0.4), radius: 8, y: 4)
                .transition(.move(edge: .top).combined(with: .opacity))
                .padding(.top, 8)
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

    var body: some View {
        VStack {
            if let notice {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundColor(Color.Theme.warning)
                    Text(notice.message)
                        .font(.callout.bold())
                        .foregroundColor(Color.Theme.textPrimary)
                        .multilineTextAlignment(.leading)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.Theme.surface)
                .clipShape(Capsule())
                .shadow(color: .black.opacity(0.4), radius: 8, y: 4)
                .transition(.move(edge: .top).combined(with: .opacity))
                .padding(.top, 8)
                .padding(.horizontal, 16)
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
