import SwiftUI

struct MainRoomChatView: View {
    @EnvironmentObject var mainRoomState: MainRoomState
    @State private var message = ""

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Chat")
                    .font(.headline)
                    .foregroundColor(Color.Theme.textPrimary)
                Spacer()
            }
            .padding(.horizontal)
            .padding(.vertical, 10)

            Divider().background(Color.Theme.inputBorder)

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(mainRoomState.messages) { msg in
                            ChatBubbleView(message: msg)
                                .id(msg.id)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                }
                .onChange(of: mainRoomState.messages.count) {
                    if let last = mainRoomState.messages.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            Divider().background(Color.Theme.inputBorder)

            // Input
            HStack(spacing: 8) {
                TextField("Type a message...", text: $message)
                    .textFieldStyle(BABTextFieldStyle())
                    .onSubmit(sendMessage)

                Button(action: sendMessage) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundColor(message.isEmpty ? Color.Theme.textDim : Color.Theme.primary)
                }
                .disabled(message.isEmpty)
            }
            .padding(10)
        }
    }

    private func sendMessage() {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        LobbyEmitter.mainRoomChat(message: text)
        message = ""
    }
}

// MARK: - Chat Bubble

struct ChatBubbleView: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            if message.type == .system {
                Text(message.message)
                    .font(.caption)
                    .foregroundColor(Color.Theme.textDim)
                    .italic()
            } else {
                Text(message.username)
                    .font(.caption.bold())
                    .foregroundColor(usernameColor)
                Text(message.message)
                    .font(.caption)
                    .foregroundColor(Color.Theme.textPrimary)
            }
        }
    }

    private var usernameColor: Color {
        if message.type == .spectator {
            return Color.Theme.textDim
        }
        return UsernameColor.color(for: message.username)
    }
}
