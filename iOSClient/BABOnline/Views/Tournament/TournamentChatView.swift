import SwiftUI

struct TournamentChatView: View {
    /// A "Chat" section title above the messages, styled like "Players" and
    /// "Scoreboard" (the wide lobby's right column).
    var showsTitle = false

    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var authState: AuthState
    @State private var message = ""
    @State private var reportTarget: String?

    var body: some View {
        VStack(spacing: 0) {
            if showsTitle {
                HStack {
                    Text("Chat")
                        .font(.caption.bold())
                        .foregroundColor(Theme.textSecondary)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, Theme.Space.s3)
                .padding(.bottom, Theme.Space.s1)
            }

            Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.Space.s1) {
                        let dividers = ChatTimestamps.dividerIndices(tournamentState.messages.map(\.timestamp))
                        // distinct name colours, as the web's chats (generateDistinctColor)
                        let hues = UsernameColor.distinctHues(for: tournamentState.messages)
                        ForEach(Array(tournamentState.messages.enumerated()), id: \.element.id) { i, msg in
                            ChatBubbleView(message: msg, hue: hues[msg.username])
                                .id(msg.id)
                                .reportBlockMenu(for: msg, currentUsername: authState.username, reportTarget: $reportTarget)
                                .chatTimeDivider(dividers.contains(i), date: msg.timestamp)
                        }
                    }
                    .padding(.horizontal, Theme.Space.s3)
                    .padding(.vertical, 6)
                }
                .scrollDismissesKeyboard(.interactively)
                .followsNewestMessage(proxy, lastID: tournamentState.messages.last?.id, count: tournamentState.messages.count)
            }

            Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Input
            HStack(spacing: Theme.Space.s2) {
                TextField("Chat...", text: $message)
                    .textFieldStyle(BABTextFieldStyle())
                    .onSubmit(sendMessage)
                    .accessibilityIdentifier("tournamentChatField")

                Button(action: sendMessage) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundColor(message.isEmpty || rejoining ? Theme.textDim : Theme.primary)
                }
                .disabled(message.isEmpty || rejoining)
                .accessibilityLabel("Send")  // not the symbol's "Arrow Up Circle"
            }
            .padding(Theme.Space.s2)
        }
        .safetyAlerts(reportTarget: $reportTarget, reportContext: "tournament chat")
        .onAppear { if message.isEmpty { message = tournamentState.chatDraft } }
        .onChange(of: message) { tournamentState.chatDraft = message }
    }

    /// The restore's joinTournament unanswered: the server drops a chat line from a socket
    /// in no tournament without a word, so the line stays in the field.
    private var rejoining: Bool { tournamentState.rejoiningTournamentId != nil }

    private func sendMessage() {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !rejoining else { return }
        TournamentEmitter.tournamentChat(message: text)
        message = ""
        tournamentState.chatDraft = ""
    }
}
