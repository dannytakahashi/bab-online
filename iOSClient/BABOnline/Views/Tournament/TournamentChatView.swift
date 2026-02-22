import SwiftUI

struct TournamentChatView: View {
    @EnvironmentObject var tournamentState: TournamentState
    @State private var message = ""

    var body: some View {
        VStack(spacing: 0) {
            Divider().background(Color.Theme.inputBorder)

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(tournamentState.messages) { msg in
                            ChatBubbleView(message: msg)
                                .id(msg.id)
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
        TournamentEmitter.tournamentChat(message: text)
        message = ""
    }
}
