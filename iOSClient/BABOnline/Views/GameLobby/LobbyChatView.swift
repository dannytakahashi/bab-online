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
                        .foregroundColor(Theme.textPrimary)
                    Spacer()
                }
                .padding(.horizontal)
                .frame(height: titleHeight)
            }

            Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.Space.s1) {
                        let dividers = ChatTimestamps.dividerIndices(lobbyState.messages.map(\.timestamp))
                        ForEach(Array(lobbyState.messages.enumerated()), id: \.element.id) { i, msg in
                            ChatBubbleView(message: msg)
                                .id(msg.id)
                                .reportBlockMenu(for: msg, currentUsername: authState.username, reportTarget: $reportTarget)
                                .chatTimeDivider(dividers.contains(i), date: msg.timestamp)
                        }
                    }
                    .padding(.horizontal, Theme.Space.s3)
                    .padding(.vertical, 6)
                }
                .scrollDismissesKeyboard(.interactively)
                .followsNewestMessage(proxy, lastID: lobbyState.messages.last?.id, count: lobbyState.messages.count)
            }

            Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Input
            HStack(spacing: Theme.Space.s2) {
                TextField("Chat...", text: $message)
                    .textFieldStyle(BABTextFieldStyle())
                    .onSubmit(sendMessage)
                    .accessibilityIdentifier("lobbyChatField")

                Button(action: sendMessage) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundColor(message.isEmpty ? Theme.textDim : Theme.primary)
                }
                .disabled(message.isEmpty)
                .accessibilityLabel("Send")  // not the symbol's "Arrow Up Circle"
            }
            .padding(Theme.Space.s2)
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
