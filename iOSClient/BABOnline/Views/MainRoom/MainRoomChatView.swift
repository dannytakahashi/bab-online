import SwiftUI

struct MainRoomChatView: View {
    /// The online count beside the title: the main room's header row is not
    /// shown in the vertical bar, whose Online button shows a symbol only.
    var showsOnlineCount = false

    @EnvironmentObject var mainRoomState: MainRoomState
    @EnvironmentObject var authState: AuthState
    @State private var message = ""
    @State private var reportTarget: String?

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Chat")
                    .font(.headline)
                    .foregroundColor(Theme.textPrimary)
                Spacer()
                if showsOnlineCount {
                    Text("\(mainRoomState.onlineCount) online")
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundColor(Theme.textSecondary)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 10)

            Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        let dividers = ChatTimestamps.dividerIndices(mainRoomState.messages.map(\.timestamp))
                        ForEach(Array(mainRoomState.messages.enumerated()), id: \.element.id) { i, msg in
                            ChatBubbleView(message: msg)
                                .id(msg.id)
                                .reportBlockMenu(for: msg, currentUsername: authState.username, reportTarget: $reportTarget)
                                .chatTimeDivider(dividers.contains(i), date: msg.timestamp)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, Theme.Space.s2)
                }
                .scrollDismissesKeyboard(.interactively)
                .followsNewestMessage(proxy, lastID: mainRoomState.messages.last?.id, count: mainRoomState.messages.count)
            }

            Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Input
            HStack(spacing: Theme.Space.s2) {
                TextField("Type a message...", text: $message)
                    .textFieldStyle(BABTextFieldStyle())
                    .accessibilityIdentifier("mainRoomChatField")
                    .onSubmit(sendMessage)

                Button(action: sendMessage) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundColor(message.isEmpty ? Theme.textDim : Theme.primary)
                }
                .disabled(message.isEmpty)
                .accessibilityLabel("Send")  // not the symbol's "Arrow Up Circle"
            }
            .padding(10)
        }
        .safetyAlerts(reportTarget: $reportTarget, reportContext: "main room chat")
        // the draft lives in the store: a rotation or fold that rebuilds this view keeps it
        .onAppear { if message.isEmpty { message = mainRoomState.chatDraft } }
        .onChange(of: message) { mainRoomState.chatDraft = message }
    }

    private func sendMessage() {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        LobbyEmitter.mainRoomChat(message: text)
        message = ""
        mainRoomState.chatDraft = ""
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
                    .foregroundColor(Theme.textDim)
                    .italic()
            } else {
                Text(message.username)
                    .font(.caption.bold())
                    .foregroundColor(usernameColor)
                Text(message.message)
                    .font(.caption)
                    .foregroundColor(Theme.textPrimary)
            }
        }
    }

    private var usernameColor: Color {
        if message.type == .spectator {
            return Theme.textDim
        }
        return UsernameColor.color(for: message.username)
    }
}
