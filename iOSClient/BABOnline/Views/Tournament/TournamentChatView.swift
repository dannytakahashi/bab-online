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
                        .foregroundColor(Color.Theme.textSecondary)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, 12)
                .padding(.bottom, 4)
            }

            Divider().background(Color.Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(tournamentState.messages) { msg in
                            ChatBubbleView(message: msg)
                                .id(msg.id)
                                .reportBlockMenu(for: msg, currentUsername: authState.username, reportTarget: $reportTarget)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: tournamentState.messages.count) {
                    if let last = tournamentState.messages.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            Divider().background(Color.Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

            // Input
            HStack(spacing: 8) {
                TextField("Chat...", text: $message)
                    .textFieldStyle(BABTextFieldStyle())
                    .onSubmit(sendMessage)
                    .accessibilityIdentifier("tournamentChatField")

                Button(action: sendMessage) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundColor(message.isEmpty ? Color.Theme.textDim : Color.Theme.primary)
                }
                .disabled(message.isEmpty)
            }
            .padding(8)
        }
        .safetyAlerts(reportTarget: $reportTarget, reportContext: "tournament chat")
        .onAppear { if message.isEmpty { message = tournamentState.chatDraft } }
        .onChange(of: message) { tournamentState.chatDraft = message }
    }

    private func sendMessage() {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        TournamentEmitter.tournamentChat(message: text)
        message = ""
        tournamentState.chatDraft = ""
    }
}
