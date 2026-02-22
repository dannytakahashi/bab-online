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
