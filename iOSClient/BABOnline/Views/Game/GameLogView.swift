import SwiftUI

/// Slash command definition
private struct SlashCommand {
    let command: String
    let description: String
}

/// The game log drawer (iPhone portrait, iPad): the log panel floating at the
/// trailing edge, closed with its button.
struct GameLogView: View {
    @Binding var isShowing: Bool

    var body: some View {
        GeometryReader { geo in
            HStack {
                Spacer()

                GameLogPanel(style: .drawer, onClose: { withAnimation { isShowing = false } })
                    .frame(width: min(320, geo.size.width * 0.8))
                    .background(Theme.surface.opacity(0.95))
                    .cornerRadius(Theme.Radius.md)
                    .elevation(Theme.Elevation.e3)
                    .padding(.trailing, Theme.Space.s2)
                    .padding(.vertical, 60)
            }
        }
    }
}

/// Game log + chat: the drawer's content, or a side panel docked beside the
/// table (the Duo's inner display in landscape or book pose, item 27-4).
struct GameLogPanel: View {
    enum Style { case drawer, docked }

    @EnvironmentObject var gameState: GameState
    var style: Style = .drawer
    var onClose: (() -> Void)?
    @State private var chatMessage = ""
    @State private var showAutocomplete = false
    @State private var reportTarget: String?

    private static let allCommands: [SlashCommand] = [
        SlashCommand(command: "/lazy", description: "Bot plays for you"),
        SlashCommand(command: "/active", description: "Take back control"),
        SlashCommand(command: "/leave", description: "Leave the game (bot finishes for you)"),
    ]

    private var availableCommands: [SlashCommand] {
        // Pure spectators (not lazy) only see /leave
        if gameState.isSpectator && !gameState.isLazy {
            return Self.allCommands.filter { $0.command == "/leave" }
        }
        return Self.allCommands
    }

    private var filteredCommands: [SlashCommand] {
        guard chatMessage.hasPrefix("/") else { return [] }
        let query = chatMessage.lowercased()
        return availableCommands.filter { $0.command.hasPrefix(query) }
    }

    var body: some View {
                VStack(spacing: 0) {
                    // Header
                    HStack {
                        Text("Game Log")
                            .font(.headline)
                            .foregroundColor(Theme.textPrimary)
                        Spacer()
                        if style == .drawer {
                            Button(action: { onClose?() }) {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(Theme.textDim)
                            }
                        }
                    }
                    .padding(Theme.Space.s3)

                    Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: [])  // not into the vertical bar

                    // Messages
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: Theme.Space.s1) {
                                let dividers = ChatTimestamps.dividerIndices(gameState.gameLog.map(\.timestamp))
                                ForEach(Array(gameState.gameLog.enumerated()), id: \.element.id) { i, entry in
                                    GameLogEntryView(entry: entry)
                                        .id(entry.id)
                                        .reportBlockMenu(for: entry, currentUsername: gameState.username ?? "", reportTarget: $reportTarget)
                                        .chatTimeDivider(dividers.contains(i), date: entry.timestamp)
                                }
                            }
                            .padding(.horizontal, Theme.Space.s3)
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

                    Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: [])  // not into the vertical bar

                    // Slash command autocomplete
                    if showAutocomplete && !filteredCommands.isEmpty {
                        VStack(spacing: 0) {
                            ForEach(filteredCommands, id: \.command) { cmd in
                                Button(action: { submitCommand(cmd.command) }) {
                                    HStack(spacing: Theme.Space.s2) {
                                        Text(cmd.command)
                                            .font(.footnote.bold().monospaced())
                                            .foregroundColor(Theme.success)
                                        Text(cmd.description)
                                            .font(.caption)
                                            .foregroundColor(Theme.textDim)
                                        Spacer()
                                    }
                                    .padding(.horizontal, Theme.Space.s3)
                                    .padding(.vertical, Theme.Space.s2)
                                }
                            }
                        }
                        .background(Theme.surface, ignoresSafeAreaEdges: .bottom)
                    }

                    // Chat input
                    HStack(spacing: Theme.Space.s2) {
                        TextField("Chat...", text: $chatMessage)
                            .textFieldStyle(BABTextFieldStyle())
                            .onChange(of: chatMessage) {
                                showAutocomplete = chatMessage.hasPrefix("/")
                                gameState.chatDraft = chatMessage
                            }
                            .onAppear { if chatMessage.isEmpty { chatMessage = gameState.chatDraft } }
                            .onSubmit(sendChat)

                        Button(action: sendChat) {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.title3)
                                .foregroundColor(chatMessage.isEmpty ? Theme.textDim : Theme.primary)
                        }
                        .disabled(chatMessage.isEmpty)
                    }
                    .padding(Theme.Space.s2)
                }
        // docked and visible: what it shows is read
        .onAppear { if style == .docked { gameState.apply(.local(.chatRead)) } }
        .onChange(of: gameState.gameLog.count) { if style == .docked { gameState.apply(.local(.chatRead)) } }
        .safetyAlerts(reportTarget: $reportTarget, reportContext: "game chat")
    }

    private func sendChat() {
        let text = chatMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        // Slash command: auto-submit if single match
        if text.hasPrefix("/") {
            let matches = filteredCommands
            if matches.count == 1 {
                submitCommand(matches[0].command)
            }
            return
        }

        ChatEmitter.sendMessage(text)
        chatMessage = ""
        gameState.chatDraft = ""
        showAutocomplete = false
    }

    private func submitCommand(_ command: String) {
        ChatEmitter.sendMessage(command)
        chatMessage = ""
        gameState.chatDraft = ""
        showAutocomplete = false
    }
}

struct GameLogEntryView: View {
    let entry: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s1) {
            if entry.type == .system {
                Text(entry.message)
                    .font(.caption2)
                    .foregroundColor(Theme.textDim)
                    .italic()
            } else {
                Text("\(entry.username):")
                    .font(.caption2.bold())
                    .foregroundColor(usernameColor)
                Text(entry.message)
                    .font(.caption2)
                    .foregroundColor(Theme.textPrimary)
            }
        }
    }

    private var usernameColor: Color {
        if entry.type == .spectator {
            return Theme.textDim
        }
        // Use team-based color if position is available
        if let position = entry.position {
            return UsernameColor.teamColor(for: position)
        }
        // Fall back to username-based color
        return UsernameColor.color(for: entry.username)
    }
}
