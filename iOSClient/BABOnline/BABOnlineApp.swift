import SwiftUI

@main
struct BABOnlineApp: App {
    #if os(iOS)
    /// Orientation policy per window scene (item 27-1).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif
    /// The state objects and the socket's wiring (App/AppGraph.swift).
    @StateObject private var graph: AppGraph
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // made here, as the state objects were made in this init before AppGraph
        let graph = AppGraph()
        _graph = StateObject(wrappedValue: graph)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .inject(graph)
                .onAppear {
                    graph.setupSocket()
                }
                #if os(iOS)
                // the background keep-alive, the mic and the connection check (AppPresence+iOS)
                .onChange(of: scenePhase) { _, newPhase in
                    AppPresence.shared.handleScenePhase(newPhase)
                }
                #endif
                // a profile sheet of the screen that went away no longer holds the Safety alerts back
                .onChange(of: graph.appState.screen) { _, _ in ProfileSheets.shared.screenChanged() }
        }
    }
}
