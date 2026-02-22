import SwiftUI

struct LobbyChatView: View {
    @EnvironmentObject var lobbyState: LobbyState
    @State private var message = ""

    var body: some View {
        VStack(spacing: 0) {
            Divider().background(Color.Theme.inputBorder)

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(lobbyState.messages) { msg in
                            ChatBubbleView(message: msg)
                                .id(msg.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .onChange(of: lobbyState.messages.count) {
                    if let last = lobbyState.messages.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            Divider().background(Color.Theme.inputBorder)

            // Input
            HStack(spacing: 8) {
                TextField("Chat...", text: $message)
                    .textFieldStyle(BABTextFieldStyle())
                    .onSubmit(sendMessage)

                Button(action: sendMessage) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundColor(message.isEmpty ? Color.Theme.textDim : Color.Theme.primary)
                }
                .disabled(message.isEmpty)
            }
            .padding(8)
        }
    }

    private func sendMessage() {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        LobbyEmitter.lobbyChat(message: text)
        message = ""
    }
}
