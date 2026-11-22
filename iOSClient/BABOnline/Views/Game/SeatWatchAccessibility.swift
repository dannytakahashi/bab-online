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
                // my own seat's eye only: a watcher's bottom seat (the watched player's) has none
                // (GameSKScene.placeMyWatchers); its own eye is the badge
                if let hand = model.hand, !hand.readOnly, let names = bySeat[model.viewPosition] {
                    element(layout.myWatchChip(handCount: hand.cards.count, count: names.count), seat: model.viewPosition,
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
