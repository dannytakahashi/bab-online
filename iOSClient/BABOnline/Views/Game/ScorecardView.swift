import SwiftUI

/// The scorecard (owner 2026-11-27; the model is `Scorecard.model`, State/Table/Scorecard.swift):
/// one row per hand, "bid → took" per player under each pair's names, then each pair's score:
/// the hand's points small and muted ABOVE the new total (a ledger; none on the first hand).
///
/// Colours, and only for these: gold = extra tricks (`Theme.gold`, the over-trick pip's), a red
/// pill = the player at fault (`Theme.error` on its 18% tint), a green outline = a bore
/// (`Theme.primary`, the New Game spade's), red pill + red outline = a bore that was set; the
/// pairs' names and scores in their team's colour (`Theme.team`, the score bar's), the player
/// cells neutral.
///
/// Width: the columns fit a 375 pt phone at the default text size (the players share what the
/// Hand, Dealer and Score columns leave); where they do not (the accessibility sizes), the Hand
/// column stays pinned and the rest scrolls sideways; never clipped. Long names end in "…".
/// VoiceOver: the drawn table is hidden; each row is one element over it reading the row's
/// sentence ("Hand 12, hearts. Dealer kim. ivy bid 3, took 3. ...", `scorecard.row.<handNo>`).
struct ScorecardTable: View {
    let model: Scorecard.Model

    @ScaledMetric(relativeTo: .footnote) private var handW: CGFloat = 32
    @ScaledMetric(relativeTo: .footnote) private var dealerW: CGFloat = 36
    @ScaledMetric(relativeTo: .footnote) private var playerMinW: CGFloat = 44
    @ScaledMetric(relativeTo: .footnote) private var scoreW: CGFloat = 44
    @ScaledMetric(relativeTo: .footnote) private var rowH: CGFloat = 38
    @ScaledMetric(relativeTo: .caption) private var pairH: CGFloat = 20
    @ScaledMetric(relativeTo: .caption) private var headH: CGFloat = 22
    @State private var width: CGFloat = 0

    private enum Col: Hashable { case hand, dealer, player(Int), score(Int) }

    private var nPlayers: Int { model.players.count }
    private var nScores: Int { model.scoreColumns.count }
    private var fixedW: CGFloat { handW + dealerW + scoreW * CGFloat(nScores) }
    private var minW: CGFloat { fixedW + playerMinW * CGFloat(nPlayers) }
    /// Everything fits (or the width is not measured yet): one table, no sideways scroll.
    private var fits: Bool { width == 0 || minW <= width + 0.5 }
    private var playerW: CGFloat { fits && width > 0 ? max(playerMinW, (width - fixedW) / CGFloat(max(nPlayers, 1))) : playerMinW }
    private var topH: CGFloat { model.solo ? 0 : pairH }
    private var tableH: CGFloat { topH + headH + rowH * CGFloat(model.rows.count) }

    var body: some View {
        Group {
            if model.rows.isEmpty {
                Text("No hands played yet.")
                    .font(.subheadline)
                    .foregroundColor(Theme.textDim)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Space.s4)
                    .accessibilityIdentifier("scorecard.empty")
            } else {
                // the width offered, whatever the table's own (a GeometryReader takes exactly
                // the proposal; the table's height is known from its rows)
                GeometryReader { geo in
                    ZStack(alignment: .topLeading) {
                        table
                        spokenRows
                    }
                    .frame(width: geo.size.width, alignment: .topLeading)
                    .onAppear { width = geo.size.width }
                    .onChange(of: geo.size.width) { _, w in width = w }
                }
                .frame(height: tableH)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("scorecard")
        #if DEBUG
        .accessibilityValue(fits ? "fits" : "scrolls")
        #endif
    }

    private var allCols: [Col] {
        [.hand, .dealer] + model.players.indices.map { .player($0) } + model.scoreColumns.indices.map { .score($0) }
    }

    @ViewBuilder
    private var table: some View {
        if fits {
            columns(allCols).accessibilityHidden(true)
        } else {
            HStack(alignment: .top, spacing: 0) {
                columns([.hand])
                ScrollView(.horizontal, showsIndicators: true) {
                    columns(Array(allCols.dropFirst()))
                }
                .frame(width: max(0, width - handW))
                .accessibilityIdentifier("scorecard.scroll")
            }
            .accessibilityHidden(true)
        }
    }

    private func w(_ c: Col) -> CGFloat {
        switch c {
        case .hand: return handW
        case .dealer: return dealerW
        case .player: return playerW
        case .score: return scoreW
        }
    }

    /// The header and every row over the given columns (both halves of a pinned table share it).
    private func columns(_ cols: [Col]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !model.solo { pairRow(cols) }
            headRow(cols)
            ForEach(model.rows) { row in
                HStack(spacing: 0) {
                    ForEach(cols, id: \.self) { c in cell(c, row).frame(width: w(c), height: rowH) }
                }
                .background(row.current ? Theme.textPrimary.opacity(0.06) : Color.clear)
                .overlay(alignment: .top) { Rectangle().fill(Theme.divider).frame(height: 1) }
            }
        }
    }

    /// The pairs' names over their two players (underlined in the pair's colour), and over each
    /// Score column its pair's names.
    private func pairRow(_ cols: [Col]) -> some View {
        HStack(spacing: 0) {
            ForEach(cols, id: \.self) { c in
                switch c {
                case .hand, .dealer:
                    Color.clear.frame(width: w(c), height: pairH)
                case .player(let i):
                    // the pair's label spans its two players: drawn by its first column
                    if i % 2 == 0, model.pairs.indices.contains(i / 2) {
                        let pair = model.pairs[i / 2]
                        headText(pair.label, colour: Theme.team(pair.colour), weight: .semibold)
                            .frame(width: playerW * 2 - 4, height: pairH - 2)
                            .overlay(alignment: .bottom) { Rectangle().fill(Theme.team(pair.colour)).frame(height: 2) }
                            .frame(width: playerW * 2, height: pairH)
                    }
                case .score(let i):
                    headText(model.scoreColumns[i].label, colour: Theme.team(model.scoreColumns[i].colour), weight: .semibold)
                        .frame(width: scoreW, height: pairH)
                }
            }
        }
    }

    private func headRow(_ cols: [Col]) -> some View {
        HStack(spacing: 0) {
            ForEach(cols, id: \.self) { c in
                Group {
                    switch c {
                    case .hand: headText("Hand", colour: Theme.textDim).frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 2)
                    case .dealer: headText("Dealer", colour: Theme.textDim)
                    case .player(let i):
                        let p = model.players[i]
                        headText(p.name, colour: Theme.team(p.colour), weight: p.mine ? .bold : .semibold)
                    case .score(let i):
                        headText(model.solo ? model.scoreColumns[i].label : "Score",
                                 colour: model.solo ? Theme.team(model.scoreColumns[i].colour) : Theme.textDim)
                    }
                }
                .frame(width: w(c), height: headH)
            }
        }
    }

    private func headText(_ s: String, colour: Color, weight: Font.Weight = .semibold) -> some View {
        Text(s)
            .font(.caption.weight(weight))
            .foregroundColor(colour)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .truncationMode(.tail)
            .padding(.horizontal, 1)
    }

    @ViewBuilder
    private func cell(_ c: Col, _ row: Scorecard.Row) -> some View {
        switch c {
        case .hand:
            HStack(spacing: 3) {
                Text("\(row.hand.size)").foregroundColor(Theme.textDim)
                if !row.hand.symbol.isEmpty {
                    Text(row.hand.symbol)
                        .font(row.hand.joker ? .caption2.bold() : .footnote)
                        .foregroundColor(row.hand.red ? Theme.suitOnDark(.hearts) : Theme.textPrimary)
                }
            }
            .font(.footnote.monospacedDigit())
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 2)
        case .dealer:
            Text(row.dealer)
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.horizontal, 1)
        case .player(let i):
            ScorecardCellView(cell: row.cells[i])
        case .score(let i):
            if let scores = row.scores, scores.indices.contains(i) {
                let sc = scores[i]
                VStack(spacing: 0) {
                    if sc.showDelta {
                        Text(Scorecard.signed(sc.delta))
                            .font(.caption2.monospacedDigit())
                            .foregroundColor(Theme.textDim)
                    }
                    Text("\(sc.total)")
                        .font(.footnote.weight(.bold).monospacedDigit())
                        .foregroundColor(Theme.team(sc.colour))
                }
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            } else {
                Text("\u{2013}").font(.footnote).foregroundColor(Theme.textDim)
            }
        }
    }

    /// One VoiceOver element per row, over the drawn row (the table itself is hidden).
    private var spokenRows: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: topH + headH).accessibilityHidden(true)
            ForEach(model.rows) { row in
                Rectangle()
                    .fill(Color.white.opacity(0.001))
                    .frame(height: rowH)
                    .frame(maxWidth: .infinity)
                    .allowsHitTesting(false)
                    .accessibilityElement()
                    .accessibilityLabel(row.spoken)
                    .accessibilityIdentifier(row.current ? "scorecard.current" : "scorecard.row.\(row.handNo)")
                    #if DEBUG
                    .accessibilityValue(Self.probe(row))
                    #endif
            }
        }
    }

    #if DEBUG
    /// The UI tests' reading of a row: each cell "<role>[+]:<text>" (+ = gold took), then each
    /// score "<delta>/<total>" ("-" none; "=total" with no delta line).
    static func probe(_ row: Scorecard.Row) -> String {
        let cells = row.cells.map { c -> String in
            let role: String
            switch c.role {
            case .plain: role = "plain"
            case .fault: role = "fault"
            case .bore: role = "bore"
            case .boreSet: role = "boreSet"
            }
            return "\(role)\(c.extra ? "+" : ""):\(c.text)\(c.forbidden.map { "~\($0)" } ?? "")"
        }
        let scores = row.scores.map { $0.map { $0.showDelta ? "\(Scorecard.signed($0.delta))/\($0.total)" : "=\($0.total)" } } ?? ["-"]
        return (cells + scores).joined(separator: " ")
    }
    #endif
}

/// One player's "bid → took" (the arrow muted; the took number gold for extra tricks), in its
/// role's dress: a red pill at fault, a green outline for a bore, both red for a set bore.
struct ScorecardCellView: View {
    let cell: Scorecard.Cell

    var body: some View {
        if let bid = cell.bid {
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text(bid)
                Text("\u{2192}").font(.caption2).foregroundColor(arrow)
                Text(cell.took.map(String.init) ?? "\u{2013}")
                    .foregroundColor(cell.extra ? Theme.gold : nil)
                    .fontWeight(cell.extra ? .semibold : nil)
                if let f = cell.forbidden {
                    // Get Your Bid: the last bidder's Forbidden Bid, struck as on the bid sheet
                    Text("\(f)").font(.caption2).strikethrough().foregroundColor(Theme.error).padding(.leading, 2)
                }
            }
            .font(.footnote.monospacedDigit().weight(bore ? .semibold : .regular))
            .foregroundColor(text)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 6).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(stroke, lineWidth: 1.5))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        } else {
            Text("\u{2013}").font(.footnote).foregroundColor(Theme.textDim)
        }
    }

    private var bore: Bool { cell.role == .bore || cell.role == .boreSet }
    private var text: Color {
        switch cell.role {
        case .plain: return Theme.textPrimary
        case .fault, .boreSet: return Theme.error
        case .bore: return Theme.primary
        }
    }
    private var arrow: Color { cell.role == .plain ? Theme.textDim : text.opacity(0.8) }
    private var fill: Color { cell.role == .fault || cell.role == .boreSet ? Theme.error.opacity(0.18) : .clear }
    private var stroke: Color {
        switch cell.role {
        case .bore: return Theme.primary
        case .boreSet: return Theme.error
        default: return .clear
        }
    }
}

/// The mid-game scorecard: the score bar's tap opens it as a sheet (half height, can grow), the
/// hand in play as its last row (bids only, highlighted). It follows the table live.
struct ScorecardSheet: View {
    @EnvironmentObject var gameState: GameState

    var body: some View {
        VStack(spacing: Theme.Space.s2) {
            Text("Scorecard")
                .font(.headline)
                .foregroundColor(Theme.textPrimary)
                .padding(.top, Theme.Space.s5)
                .accessibilityAddTraits(.isHeader)
            ScrollView(.vertical) {
                ScorecardTable(model: gameState.scorecardModel())
                    .padding(.horizontal, Theme.Space.s2)
                    .padding(.bottom, Theme.Space.s4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.surface.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("scorecard.sheet")
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
