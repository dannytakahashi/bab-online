#if DEBUG
import SwiftUI
import UIKit
import SpriteKit

/// Fixture mode (roadmap item 26), DEBUG builds only: `-uiFixture <name>`
/// (read through UserDefaults' argument domain) seeds the app from a contract
/// v2 snapshot (`v2/<name>.json`, bundled in Debug only) or from the
/// `UI_FIXTURE_SNAPSHOT` environment JSON, and the app never connects (no
/// socket, no voice, avatars show initials). Screen fixtures (`main-room`,
/// `game-lobby`, `tournament-lobby`, `sign-in`) seed static rows instead.
/// `-uiFold book|tabletop` simulates a fold region (FoldReader) for screenshots.
enum UIFixture {
    static let name: String? = UserDefaults.standard.string(forKey: "uiFixture")
    static var isActive: Bool { name != nil }

    enum Fold: String { case book, tabletop }
    /// Synthetic 20 pt division at the window center (screenshots only; the real API is FoldReader's).
    static let fold: Fold? = UserDefaults.standard.string(forKey: "uiFold").flatMap(Fold.init(rawValue:))

    static let screenFixtures: Set<String> = ["main-room", "game-lobby", "tournament-lobby", "sign-in"]

    @MainActor
    static func seed(_ store: GameState, _ appState: AppState, mainRoom: MainRoomState, lobby: LobbyState,
                     tournament: TournamentState, auth: AuthState) {
        guard let name else { return }
        OpponentHandNode.avatarLoader = FixtureAvatarLoader()
        if screenFixtures.contains(name) {
            seedScreen(name, appState, mainRoom: mainRoom, lobby: lobby, tournament: tournament, auth: auth)
            print("[UIFixture] seeded screen \(name)")
            return
        }
        do {
            let file = name == "game-end" ? "hand-resolving" : name
            let snapDict: [String: Any]
            if let env = ProcessInfo.processInfo.environment["UI_FIXTURE_SNAPSHOT"] {
                snapDict = try JSONSerialization.jsonObject(with: Data(env.utf8)) as? [String: Any] ?? [:]
            } else {
                guard let url = Bundle.main.url(forResource: file, withExtension: "json", subdirectory: "v2") else {
                    print("[UIFixture] missing v2/\(file).json"); return
                }
                let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
                snapDict = raw?["snapshot"] as? [String: Any] ?? [:]
            }
            let snap = try TableSnapshot.decode(snapDict, strict: true)
            let me = snap.seats.first { $0.position == snap.viewer.position }?.username
            store.apply(.local(.identity(username: me ?? "viewer", playerId: "ui-fixture")))
            auth.username = me ?? "viewer"
            store.apply(.snapshot(snap, .rejoin, hints: nil))
            if name == "game-end" {
                var stats: [String: Any] = [:]
                for seat in snap.seats { stats[String(seat.position)] = ["username": seat.username ?? "P\(seat.position)"] }
                store.apply(serverEvent: "gameEnd", payload: [[
                    "score": ["team1": 312, "team2": 287], "playerStats": stats, "tournamentId": NSNull(), "seq": snap.seq + 1,
                ] as [String: Any]])
            }
            appState.screen = .game
            print("[UIFixture] seeded \(name): phase \(store.phase)")
        } catch {
            print("[UIFixture] \(name): \(error)")
        }
    }

    private static func messages(_ lines: [(String, String)]) -> [ChatMessage] {
        lines.map { ChatMessage(username: $0.0, message: $0.1, type: $0.0 == "System" ? .system : .player) }
    }

    @MainActor
    private static func seedScreen(_ name: String, _ appState: AppState, mainRoom: MainRoomState, lobby: LobbyState,
                                   tournament: TournamentState, auth: AuthState) {
        auth.username = "ivy"
        let chat = messages([
            ("System", "Welcome to Back Alley Bridge!"), ("kim", "anyone up for a game?"), ("hal", "sure, joining the queue"),
            ("jon", "gg last round"), ("ivy", "that 4B was wild"), ("kim", "rematch?"),
        ])
        func player(_ u: String, ready: Bool = false, bot: Bool = false) -> LobbyPlayer {
            LobbyPlayer(id: "sid-\(u)", username: u, pic: nil, isReady: ready, isBot: bot)
        }
        switch name {
        case "main-room":
            mainRoom.lobbies = [
                Lobby(id: "l1", name: "Friday night", players: [player("kim"), player("hal")], playerCount: 2),
                Lobby(id: "l2", name: "Bots welcome", players: [player("jon")], playerCount: 1),
            ]
            mainRoom.inProgressGames = [
                Lobby(id: "g1", name: "ora & pat vs max & ned", players: [player("ora"), player("max"), player("pat"), player("ned")],
                      playerCount: 4, isInProgress: true),
            ]
            mainRoom.messages = chat
            mainRoom.onlineCount = 7
            mainRoom.onlineUsers = ["ivy", "kim", "hal", "jon", "ora", "max", "pat"]
            mainRoom.tournaments = [TournamentSummary(id: "t1", name: "Sunday Cup", playerCount: 6, phase: "lobby", currentRound: 0,
                                                      totalRounds: 4, creatorUsername: "kim")]
            appState.screen = .mainRoom
        case "game-lobby":
            lobby.lobbyId = "l1"
            lobby.lobbyName = "Friday night"
            lobby.players = [player("ivy", ready: true), player("kim", ready: true), player("hal"), player("Mary", ready: true, bot: true)]
            lobby.messages = chat
            appState.screen = .gameLobby
        case "tournament-lobby":
            tournament.tournamentId = "t1"
            tournament.name = "Sunday Cup"
            tournament.phase = "lobby"
            tournament.creatorUsername = "kim"
            tournament.players = ["kim", "ivy", "hal", "jon", "ora", "max"].enumerated().map {
                TournamentPlayer(id: "sid-\($0.element)", username: $0.element, pic: nil, isReady: $0.offset % 2 == 0,
                                 isCreator: $0.element == "kim", connected: true)
            }
            tournament.messages = chat
            appState.screen = .tournamentLobby
        default:
            appState.screen = .signIn
        }
    }
}

/// No network in fixture mode: every avatar shows its initial.
struct FixtureAvatarLoader: AvatarLoading {
    func load(_ picNumber: Int, completion: @escaping (UIImage?) -> Void) { completion(nil) }
}

/// What the fixture UI tests read through accessibility probes:
/// "ui.pose", "table.layoutCheck", "table.state".
@MainActor
final class TableDebugProbe: ObservableObject {
    static let shared = TableDebugProbe()

    @Published var window: CGSize = .zero
    @Published var insets = TableInsets.zero
    @Published var chrome = TableChrome()
    @Published var layoutCheck = "-"
    @Published var tableState = "-"

    var pose: String {
        let i = insets
        let fold = chrome.fold.map { "\(Int($0.width))x\(Int($0.height))@\(Int($0.minX)),\(Int($0.minY))" } ?? "-"
        return "\(Int(window.width))x\(Int(window.height)) \(Int(i.top))/\(Int(i.left))/\(Int(i.bottom))/\(Int(i.right)) "
            + "topBar \(Int(chrome.topBar)) fold \(fold) occlusions \(chrome.occlusions.count)"
    }

    /// The scene after a render or relayout: are the stable nodes inside the safe rect?
    func update(scene: GameSKScene) {
        let L = scene.layout
        let safe = L.safeRect.insetBy(dx: -1, dy: -1)
        var bad: [String] = []
        if scene.lastModel?.showsTable == true {
            var nodes: [SKNode] = Array(scene.opponentManager.nodes.values) + scene.bidsLayer.children
            nodes += scene.trickArea.cardSprites.filter { !$0.hasActions() }.map { $0 as SKNode }
            if !scene.handNode.sprites.isEmpty { nodes.append(scene.handNode) }
            if !scene.trickManager.trickHistory.children.isEmpty { nodes.append(scene.trickManager.trickHistory) }
            for n in nodes {
                let f = n.calculateAccumulatedFrame()
                let r: CGRect
                if let p = n.parent, p !== scene {
                    let a = p.convert(CGPoint(x: f.minX, y: f.minY), to: scene), b = p.convert(CGPoint(x: f.maxX, y: f.maxY), to: scene)
                    r = CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
                } else {
                    r = f
                }
                if !safe.contains(r) { bad.append("\(n.name ?? "?") \(r.integral)") }
            }
        }
        let check = bad.isEmpty ? "ok" : bad.joined(separator: "; ")
        let lifted = scene.handNode.liftedCardId ?? "-"
        let state = "lifted=\(lifted) hand=\(scene.handNode.sprites.count) trick=\(scene.trickArea.cardCount) didMove=\(scene.didMoveCount)"
        if check != layoutCheck { layoutCheck = check }
        if state != tableState { tableState = state }
    }
}

/// The three probes, 1x1 and nearly transparent, readable by XCUITest.
struct FixtureProbes: View {
    @ObservedObject var probe = TableDebugProbe.shared

    var body: some View {
        VStack(spacing: 0) {
            dot("ui.pose", probe.pose)
            dot("table.layoutCheck", probe.layoutCheck)
            dot("table.state", probe.tableState)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .allowsHitTesting(false)
    }

    private func dot(_ id: String, _ value: String) -> some View {
        Rectangle()
            .fill(Color.black)
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .accessibilityElement()
            .accessibilityLabel(id)
            .accessibilityIdentifier(id)
            .accessibilityValue(value)
    }
}

/// Measures the window (size + safe-area insets) for "ui.pose".
struct FixtureWindowProbe: View {
    var body: some View {
        GeometryReader { p in
            let i = p.safeAreaInsets
            let full = CGSize(width: p.size.width + i.leading + i.trailing, height: p.size.height + i.top + i.bottom)
            Color.clear
                .onChange(of: full, initial: true) { _, s in TableDebugProbe.shared.window = s }
                .onChange(of: TableInsets(top: i.top, left: i.leading, bottom: i.bottom, right: i.trailing), initial: true) { _, v in
                    TableDebugProbe.shared.insets = v
                }
        }
        .allowsHitTesting(false)
    }
}
#endif
