import SwiftUI

/// VoiceOver for the seat eyes the scene draws (WatchChipNode, TableLayout+Watchers.swift): one
/// element over each watched seat's eye, "Zach is watching Alice's hand" / "Zach and Yan are
/// watching your hand" (WatchingList.watchLabel), for players and spectators alike; taps go
/// through to the table. Nothing at all while no spectator entry carries `shoulder`.
struct SeatWatchAccessibility: View {
    let state: TableState
    let layout: TableLayout

    var body: some View {
        let model = TableRenderModel(state)
        let bySeat = model.watching.watchersBySeat
        let me = state.table.me.username
        Group {
            if !bySeat.isEmpty {
                ForEach(model.opponents, id: \.position) { o in
                    if let names = bySeat[o.position] {
                        element(layout.watchChip(o.rel, count: names.count, spectating: model.hand == nil), seat: o.position,
                                label: WatchingList.watchLabel(names, player: o.name, me: me, mine: false))
                    }
                }
                // the scene's bottom eye (GameSKScene.placeMyWatchers): a watcher's only while
                // someone else watches that hand too ("yan and You are watching Alice's hand")
                let names = model.bottomWatchers
                if !names.isEmpty {
                    element(layout.myWatchChip(handCount: model.hand?.cards.count ?? 0, count: names.count), seat: model.viewPosition,
                            label: WatchingList.watchLabel(names, player: state.players.name(model.viewPosition), me: me,
                                                           mine: state.table.viewer.holdsSeat))
                }
            }
        }
    }

    private func element(_ chip: CGRect, seat: Int, label: String) -> some View {
        let rect = layout.window(chip)
        return Color.clear
            .frame(width: rect.width, height: rect.height)
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityIdentifier("watch.\(seat)")
            .allowsHitTesting(false)
            .offset(x: rect.minX, y: rect.minY)
    }
}
