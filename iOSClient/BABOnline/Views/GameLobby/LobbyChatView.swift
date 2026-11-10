import SwiftUI

struct LobbyChatView: View {
    /// A "Chat" title row of this height above the messages (the wide lobby's
    /// right column, level with the header beside it); nil: none.
    var titleHeight: CGFloat? = nil

    @EnvironmentObject var lobbyState: LobbyState
    @EnvironmentObject var authState: AuthState
    @State private var message = ""
    @State private var reportTarget: String?

    var body: some View {
        VStack(spacing: 0) {
            if let titleHeight {
                HStack {
                    Text("Chat")
                        .font(.headline)
                        .foregroundColor(Color.Theme.textPrimary)
                    Spacer()
                }
                .padding(.horizontal)
                .frame(height: titleHeight)
            }

            Divider().background(Color.Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(lobbyState.messages) { msg in
                            ChatBubbleView(message: msg)
                                .id(msg.id)
                                .reportBlockMenu(for: msg, currentUsername: authState.username, reportTarget: $reportTarget)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .scrollDismissesKeyboard(.interactively)
                .followsNewestMessage(proxy, lastID: lobbyState.messages.last?.id, count: lobbyState.messages.count)
            }

            Divider().background(Color.Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Input
            HStack(spacing: 8) {
                TextField("Chat...", text: $message)
                    .textFieldStyle(BABTextFieldStyle())
                    .onSubmit(sendMessage)
                    .accessibilityIdentifier("lobbyChatField")

                Button(action: sendMessage) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundColor(message.isEmpty ? Color.Theme.textDim : Color.Theme.primary)
                }
                .disabled(message.isEmpty)
            }
            .padding(8)
        }
        .safetyAlerts(reportTarget: $reportTarget, reportContext: "lobby chat")
        .onAppear { if message.isEmpty { message = lobbyState.chatDraft } }
        .onChange(of: message) { lobbyState.chatDraft = message }
    }

    private func sendMessage() {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        LobbyEmitter.lobbyChat(message: text)
        message = ""
        lobbyState.chatDraft = ""
    }
}
