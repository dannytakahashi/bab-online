import SwiftUI

/// Slash command definition
struct SlashCommand: Equatable {
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
    /// "Unknown command: /x" over the command list, until the field changes (ChatCommand).
    @State private var commandHint: String?
    @State private var reportTarget: String?

    private var availableCommands: [SlashCommand] {
        Self.commands(pureSpectator: gameState.isSpectator && !gameState.isLazy, leave: gameState.leaveOutcome,
                      help: gameState.helpDescription)
    }

    /// The command list: a pure spectator (not lazy) only has /leave, which exits spectating;
    /// at a seat /leave says what it will do (LeaveOutcome) and /help how many free uses are
    /// spent (`help`: AssistRules.helpDescription; nil leaves it out).
    static func commands(pureSpectator: Bool, leave: LeaveOutcome, help: String? = nil) -> [SlashCommand] {
        if pureSpectator {
            return [SlashCommand(command: "/leave", description: "Exit spectating")]
        }
        var list = [
            SlashCommand(command: "/lazy", description: "Bot plays for you"),
            SlashCommand(command: "/active", description: "Take back control"),
            SlashCommand(command: "/leave", description: leave.commandHelp),
        ]
        if let help { list.append(SlashCommand(command: AssistRules.command, description: help)) }
        return list
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
                        SoundToggleButton()
                        if style == .drawer {
                            Button(action: { onClose?() }) {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(Theme.textDim)
                            }
                            .accessibilityLabel("Close game log")
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

                    // Slash command autocomplete; after an unknown command, why nothing was sent
                    // and every command (the web gets the server's "Unknown command: /x")
                    if showAutocomplete && (!filteredCommands.isEmpty || commandHint != nil) {
                        VStack(spacing: 0) {
                            if let hint = commandHint {
                                HStack(spacing: Theme.Space.s2) {
                                    Image(systemName: "exclamationmark.circle.fill")
                                        .foregroundColor(Theme.warning)
                                        .accessibilityHidden(true)
                                    Text(hint)
                                        .font(.caption.bold())
                                        .foregroundColor(Theme.textPrimary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, Theme.Space.s3)
                                .padding(.vertical, Theme.Space.s2)
                                .accessibilityElement(children: .combine)
                                .accessibilityIdentifier("chat.commandHint")
                            }
                            ForEach(commandHint != nil ? availableCommands : filteredCommands, id: \.command) { cmd in
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
                                commandHint = nil
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
                        .accessibilityLabel("Send")  // not the symbol's "Arrow Up Circle"
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

        // Slash command: a unique prefix is sent as its command (the web's rule); anything
        // else starting with "/" is not sent and says so, with the commands, in place
        if text.hasPrefix("/") {
            switch ChatCommand.resolve(text, commands: availableCommands.map(\.command)) {
            case .send(let command): submitCommand(command)
            case .unknown(let word):
                commandHint = "Unknown command: \(word)"
                showAutocomplete = true  // a draft with a leading space has no list up yet
                AccessibilityNotification.Announcement("Unknown command \(word). Commands: \(availableCommands.map(\.command).joined(separator: ", "))").post()
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
        commandHint = nil
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
                    // a row only I see (my /help answer): dim, in the suggestion's gold
                    .foregroundColor(entry.isPrivate ? Theme.gold.opacity(0.75) : Theme.textDim)
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

/// What a chat line starting with "/" does (the web GameLog.submitChat rule, with the
/// server's "Unknown command: /x" answered in place: a spectator's or a watching owner's
/// unknown command gets no answer from the server at all). A deliberate difference from the
/// web, which sends every line and shows the server's reply.
enum ChatCommand {
    enum Resolution: Equatable {
        /// Send this command (the line was it, or its unique prefix).
        case send(String)
        /// Not a command: its first word, for "Unknown command: /x".
        case unknown(String)
    }

    /// Commands the server answers from anyone (server/socket/chatHandlers.js spectatorCommand):
    /// typed in full they are sent whatever the list shows. A spectator recorded as a seat's
    /// owner takes it back with `/active`, though a spectator's list shows only `/leave`.
    /// `/help` too (the server answers a spectator "/help is for players only.").
    static let server = ["/active", "/leave", "/help"]

    static func resolve(_ text: String, commands: [String]) -> Resolution {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let query = line.lowercased()
        if server.contains(query) { return .send(query) }
        if query != "/" {
            let matches = commands.filter { $0.hasPrefix(query) }
            if matches.count == 1 { return .send(matches[0]) }
        }
        return .unknown(String(line.split(separator: " ").first ?? "/"))
    }
}
