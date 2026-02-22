import SwiftUI

/// Collapsible game log + chat panel.
struct GameLogView: View {
    @EnvironmentObject var gameState: GameState
    @Binding var isShowing: Bool
    @State private var chatMessage = ""

    var body: some View {
        GeometryReader { geo in
            HStack {
                Spacer()

                VStack(spacing: 0) {
                    // Header
                    HStack {
                        Text("Game Log")
                            .font(.headline)
                            .foregroundColor(Color.Theme.textPrimary)
                        Spacer()
                        Button(action: { withAnimation { isShowing = false } }) {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundColor(Color.Theme.textDim)
                        }
                    }
                    .padding(12)

                    Divider().background(Color.Theme.inputBorder)

                    // Messages
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 4) {
                                ForEach(gameState.gameLog) { entry in
                                    GameLogEntryView(entry: entry)
                                        .id(entry.id)
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                        }
                        .onAppear {
                            if let last = gameState.gameLog.last {
                                proxy.scrollTo(last.id, anchor: .bottom)
                            }
                        }
                        .onChange(of: gameState.gameLog.count) {
                            if let last = gameState.gameLog.last {
                                withAnimation(.easeOut(duration: 0.2)) {
                                    proxy.scrollTo(last.id, anchor: .bottom)
                                }
                            }
                        }
                    }

                    Divider().background(Color.Theme.inputBorder)

                    // Chat input
                    HStack(spacing: 8) {
                        TextField("Chat...", text: $chatMessage)
                            .textFieldStyle(BABTextFieldStyle())
                            .onSubmit(sendChat)

                        Button(action: sendChat) {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.title3)
                                .foregroundColor(chatMessage.isEmpty ? Color.Theme.textDim : Color.Theme.primary)
                        }
                        .disabled(chatMessage.isEmpty)
                    }
                    .padding(8)
                }
                .frame(width: min(320, geo.size.width * 0.8))
                .background(Color.Theme.surface.opacity(0.95))
                .cornerRadius(12)
                .shadow(color: .black.opacity(0.5), radius: 10)
                .padding(.trailing, 8)
                .padding(.vertical, 60)
            }
        }
    }

    private func sendChat() {
        let text = chatMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // Ignore slash commands — not yet supported on iOS
        guard !text.hasPrefix("/") else {
            chatMessage = ""
            return
        }
        ChatEmitter.sendMessage(text)
        chatMessage = ""
    }
}

struct GameLogEntryView: View {
    let entry: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            if entry.type == .system {
                Text(entry.message)
                    .font(.system(size: 11))
                    .foregroundColor(Color.Theme.textDim)
                    .italic()
            } else {
                Text("\(entry.username):")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(usernameColor)
                Text(entry.message)
                    .font(.system(size: 11))
                    .foregroundColor(Color.Theme.textPrimary)
            }
        }
    }

    private var usernameColor: Color {
        if entry.type == .spectator {
            return Color.Theme.textDim
        }
        // Use team-based color if position is available
        if let position = entry.position {
            return UsernameColor.teamColor(for: position)
        }
        // Fall back to username-based color
        return UsernameColor.color(for: entry.username)
    }
}
