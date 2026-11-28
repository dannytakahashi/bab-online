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
/// Width: the columns fit a 375 pt phone at the default text size. The Hand column is fixed; the
/// Dealer column is never narrower than its "Dealer" heading, each Score column gets its pair's
/// measured names (over two lines, "ivy &" / "hal", where one line does not fit) before the
/// players give up `playerComfortW`, and the Dealer column grows to the dealers' names where the
/// players keep it (`ScorecardWidths.solve`); the players share the rest. Where even the minimums do not fit (the accessibility
/// sizes) the Hand column stays pinned and the rest scrolls sideways at full widths; never
/// clipped. Long names end in "…".
/// VoiceOver: the drawn table is hidden; each row is one element over it reading the row's
/// sentence ("Hand 12, hearts. Dealer kim. ivy bid 3, took 3. ...", `scorecard.row.<handNo>`).
struct ScorecardTable: View {
    let model: Scorecard.Model

    @ScaledMetric(relativeTo: .footnote) private var handW: CGFloat = 34
    @ScaledMetric(relativeTo: .footnote) private var dealerMinW: CGFloat = 36
    @ScaledMetric(relativeTo: .footnote) private var dealerMaxW: CGFloat = 84
    @ScaledMetric(relativeTo: .footnote) private var playerMinW: CGFloat = 44
    @ScaledMetric(relativeTo: .footnote) private var playerComfortW: CGFloat = 48
    @ScaledMetric(relativeTo: .footnote) private var scoreMinW: CGFloat = 44
    @ScaledMetric(relativeTo: .footnote) private var rowH: CGFloat = 38
    @ScaledMetric(relativeTo: .caption) private var pairH: CGFloat = 20
    @ScaledMetric(relativeTo: .caption) private var pairTwoH: CGFloat = 34
    @ScaledMetric(relativeTo: .caption) private var headH: CGFloat = 22
    @State private var width: CGFloat = 0
    /// Natural (one-line) widths of the headers and dealer names, by `MeasureKey`.
    @State private var measured: [String: CGFloat] = [:]
    #if DEBUG
    /// The drawn "Hand" and "Dealer" headings' frames in the table (the probe's `head=`).
    @State private var drawnHeads: [String: CGRect] = [:]
    #endif
    private static let space = "scorecard.table"
    /// The table's widest (any width, but `-uiScorecardWidth <pt>` in fixture mode).
    private static var maxWidth: CGFloat {
        #if DEBUG
        if let w = UIFixture.scorecardWidth { return w }
        #endif
        return .infinity
    }

    private enum Col: Hashable { case hand, dealer, player(Int), score(Int) }

    private var nPlayers: Int { model.players.count }
    private var nScores: Int { model.scoreColumns.count }

    private var dealerNames: [String] { Array(Set(model.rows.map(\.dealer).filter { !$0.isEmpty })).sorted() }

    /// The widths for the width offered (ScorecardWidths.solve over the measured labels).
    private var widths: ScorecardWidths {
        let m = { (k: String) in measured[k] ?? 0 }
        let dealerWant = ([m("dealer.head")] + dealerNames.map { m("dealer.\($0)") }).max() ?? 0
        return ScorecardWidths.solve(.init(
            width: width, hand: handW, dealerMin: dealerMinW, dealerMax: dealerMaxW, dealerWant: dealerWant,
            playerMin: playerMinW, playerComfort: playerComfortW, scoreMin: scoreMinW,
            one: model.scoreColumns.indices.map { m("score.\($0).one") },
            two: model.scoreColumns.indices.map { i in model.scoreColumns[i].lines.indices.map { m("score.\(i).line\($0)") }.max() ?? 0 },
            players: nPlayers, twoLineAllowed: !model.solo,
            pairs: model.pairs.indices.map { m("pair.\($0)") },
            dealerNames: dealerNames.map { m("dealer.\($0)") }.max() ?? 0, dealerHead: m("dealer.head")))
    }
    private var topH: CGFloat { widths.twoLine ? pairTwoH : pairH }
    private var tableH: CGFloat { topH + headH + rowH * CGFloat(model.rows.count) }

    var body: some View {
        let wd = widths
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
                        table(wd)
                        spokenRows
                    }
                    .frame(width: geo.size.width, alignment: .topLeading)
                    .coordinateSpace(.named(Self.space))
                    .onAppear { width = geo.size.width }
                    .onChange(of: geo.size.width) { _, w in width = w }
                }
                .frame(height: tableH)
                .background(alignment: .topLeading) { measurer }
            }
        }
        .frame(maxWidth: Self.maxWidth)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("scorecard")
        #if DEBUG
        .accessibilityValue(Self.layoutProbe(wd) + " " + headProbe)
        #endif
    }

    #if DEBUG
    /// "fits|scrolls labels=one|two|cut dealer=whole|cut" (the UI tests' reading of the layout;
    /// `dealer=` is the dealers' names against their column).
    static func layoutProbe(_ w: ScorecardWidths) -> String {
        "\(w.fits ? "fits" : "scrolls") labels=\(w.labelsCut ? "cut" : w.twoLine ? "two" : "one") dealer=\(w.dealerCut ? "cut" : "whole")"
    }

    /// The "Dealer" heading as drawn: "head=whole|cut|- gap=<pt>": whole when the drawn word is as
    /// wide as its natural width (a truncated "Dea…" or a shrunk word is narrower), and the gap
    /// from the drawn "Hand" to it ("HandDealer" at AX5, review of PR #455). "-" before both
    /// are measured.
    private var headProbe: String {
        guard let head = drawnHeads["dealer"], let hand = drawnHeads["hand"], let natural = measured["dealer.head"], natural > 0 else {
            return "head=- gap=-"
        }
        let whole = ceil(head.width) + 0.5 >= natural
        return "head=\(whole ? "whole" : "cut") gap=\(Int((head.minX - hand.maxX).rounded(.down)))"
    }
    #endif

    /// The labels' natural widths (never drawn; in the fonts the table uses).
    private var measurer: some View {
        ZStack(alignment: .topLeading) {
            measure("dealer.head", "Dealer", .caption.weight(.semibold))
            ForEach(model.pairs.indices, id: \.self) { measure("pair.\($0)", model.pairs[$0].label, .caption.weight(.semibold)) }
            ForEach(dealerNames, id: \.self) { measure("dealer.\($0)", $0, .caption) }
            ForEach(model.scoreColumns.indices, id: \.self) { i in
                measure("score.\(i).one", model.scoreColumns[i].label, .caption.weight(.semibold))
                ForEach(model.scoreColumns[i].lines.indices, id: \.self) { l in
                    measure("score.\(i).line\(l)", model.scoreColumns[i].lines[l], .caption.weight(.semibold))
                }
            }
        }
        .frame(width: 0, height: 0, alignment: .topLeading)
        .hidden()
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }

    private func measure(_ key: String, _ text: String, _ font: Font) -> some View {
        Text(text).font(font).lineLimit(1).fixedSize()
            .onGeometryChange(for: CGFloat.self, of: { ceil($0.size.width) }) { measured[key] = $0 }
    }

    private var allCols: [Col] {
        [.hand, .dealer] + model.players.indices.map { .player($0) } + model.scoreColumns.indices.map { .score($0) }
    }

    @ViewBuilder
    private func table(_ wd: ScorecardWidths) -> some View {
        if wd.fits {
            columns(allCols, wd).accessibilityHidden(true)
        } else {
            HStack(alignment: .top, spacing: 0) {
                columns([.hand], wd)
                ScrollView(.horizontal, showsIndicators: true) {
                    columns(Array(allCols.dropFirst()), wd)
                }
                .frame(width: max(0, width - handW))
                .accessibilityIdentifier("scorecard.scroll")
            }
            .accessibilityHidden(true)
        }
    }

    private func w(_ c: Col, _ wd: ScorecardWidths) -> CGFloat {
        switch c {
        case .hand: return handW
        case .dealer: return wd.dealer
        case .player: return wd.player
        case .score(let i): return wd.scores.indices.contains(i) ? wd.scores[i] : scoreMinW
        }
    }

    /// The header and every row over the given columns (both halves of a pinned table share it).
    private func columns(_ cols: [Col], _ wd: ScorecardWidths) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            pairRow(cols, wd)
            headRow(cols, wd)
            ForEach(model.rows) { row in
                HStack(spacing: 0) {
                    ForEach(cols, id: \.self) { c in cell(c, row).frame(width: w(c, wd), height: rowH) }
                }
                .background(row.current ? Theme.textPrimary.opacity(0.06) : Color.clear)
                .overlay(alignment: .top) { Rectangle().fill(Theme.divider).frame(height: 1) }
            }
        }
    }

    /// The pairs' names over their two players (underlined in the pair's colour), and over each
    /// Score column its pair's names (one line, or two: "ivy &" / "hal"); in Get Your Bid each
    /// player's name over their Score column (the players' own names head their bid columns).
    private func pairRow(_ cols: [Col], _ wd: ScorecardWidths) -> some View {
        HStack(alignment: .bottom, spacing: 0) {
            ForEach(cols, id: \.self) { c in
                switch c {
                case .hand, .dealer:
                    Color.clear.frame(width: w(c, wd), height: topH)
                case .player(let i):
                    if model.solo {
                        Color.clear.frame(width: wd.player, height: topH)
                    } else if i % 2 == 0, model.pairs.indices.contains(i / 2) {
                        // the pair's label spans its two players: drawn by its first column
                        let pair = model.pairs[i / 2]
                        headText(pair.label, colour: Theme.team(pair.colour), weight: .semibold)
                            .frame(width: wd.player * 2 - 4, height: pairH - 2)
                            .overlay(alignment: .bottom) { Rectangle().fill(Theme.team(pair.colour)).frame(height: 2) }
                            .frame(width: wd.player * 2, height: topH, alignment: .bottom)
                    }
                case .score(let i):
                    let col = model.scoreColumns[i]
                    VStack(spacing: 0) {
                        if wd.twoLine {
                            ForEach(col.lines.indices, id: \.self) { l in
                                headText(col.lines[l], colour: Theme.team(col.colour), weight: .semibold)
                            }
                        } else {
                            headText(col.label, colour: Theme.team(col.colour), weight: .semibold)
                        }
                    }
                    .frame(width: w(c, wd), height: topH, alignment: .bottom)
                }
            }
        }
    }

    private func headRow(_ cols: [Col], _ wd: ScorecardWidths) -> some View {
        HStack(spacing: 0) {
            ForEach(cols, id: \.self) { c in
                Group {
                    switch c {
                    case .hand:
                        headText("Hand", colour: Theme.textDim, report: "hand").frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 2)
                    case .dealer: headText("Dealer", colour: Theme.textDim, report: "dealer").padding(.leading, ScorecardWidths.dealerGap)
                    case .player(let i):
                        let p = model.players[i]
                        headText(p.name, colour: Theme.team(p.colour), weight: p.mine ? .bold : .semibold)
                    case .score:
                        // "Score" under every Score column's names, both modes
                        headText("Score", colour: Theme.textDim)
                    }
                }
                .frame(width: w(c, wd), height: headH)
            }
        }
    }

    /// `report`: the drawn text's frame goes to the DEBUG probe under that key (the word itself,
    /// before its padding).
    private func headText(_ s: String, colour: Color, weight: Font.Weight = .semibold, report: String? = nil) -> some View {
        Text(s)
            .font(.caption.weight(weight))
            .foregroundColor(colour)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .truncationMode(.tail)
            #if DEBUG
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(Self.space)) }) { f in
                if let report { drawnHeads[report] = f }
            }
            #endif
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
                .padding(.leading, ScorecardWidths.dealerGap)
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
    /// The UI tests' reading of a row: each cell "<role>[+]:<text>[~forbidden]@<took ink>" (+ = gold
    /// took; the took number's colour: plain / gold / red / green), then each score
    /// "<delta>/<total>" ("-" none; "=total" with no delta line).
    static func probe(_ row: Scorecard.Row) -> String {
        let cells = row.cells.map { c -> String in
            let role: String
            switch c.role {
            case .plain: role = "plain"
            case .fault: role = "fault"
            case .bore: role = "bore"
            case .boreSet: role = "boreSet"
            }
            return "\(role)\(c.extra ? "+" : ""):\(c.text)\(c.forbidden.map { "~\($0)" } ?? "")@\(c.tookInk.rawValue)"
        }
        let scores = row.scores.map { $0.map { $0.showDelta ? "\(Scorecard.signed($0.delta))/\($0.total)" : "=\($0.total)" } } ?? ["-"]
        return (cells + scores).joined(separator: " ")
    }
    #endif
}

/// The column widths for a width (pure; `ScorecardTable` measures the labels it passes in).
/// Priority where the table fits: the Dealer column never narrower than its "Dealer" heading
/// (`dealerHead`, the gap after Hand included: review of PR #455, "Dea…" on the narrowest game
/// end card, the closed Duo's ~350 pt table, where the column fell to `dealerMin`), then the
/// Score columns their pair's name on one line, else on two lines (the base game), with the
/// players at `playerComfort` each, else with the players down to `playerMin`, else what is left
/// shared by need (`labelsCut`); then the Dealer column grows to its widest name while the
/// players keep their comfort; the players take the rest. Where the minimums (the heading's
/// width for the Dealer column) do not fit, the table scrolls and every column gets its full want.
struct ScorecardWidths: Equatable {
    var fits: Bool
    var dealer: CGFloat
    var player: CGFloat
    var scores: [CGFloat]
    var twoLine: Bool
    var labelsCut: Bool
    var dealerCut: Bool
    /// the Dealer column narrower than its heading (never once the heading is measured: the
    /// solver's own reading; the DEBUG probe's `head=` measures the drawn word)
    var headCut: Bool = false

    struct Input {
        var width: CGFloat
        var hand: CGFloat
        var dealerMin: CGFloat
        var dealerMax: CGFloat
        /// the widest of "Dealer" and the dealers' names (0 before measuring)
        var dealerWant: CGFloat
        var playerMin: CGFloat
        var playerComfort: CGFloat
        var scoreMin: CGFloat
        /// each Score column's label on one line, and its widest line of two
        var one: [CGFloat]
        var two: [CGFloat]
        var players: Int
        var twoLineAllowed: Bool
        /// each pair's label over its two players (the base game; used where the table scrolls)
        var pairs: [CGFloat] = []
        /// the widest dealer's name alone (`dealerCut`: the cells have no scale factor)
        var dealerNames: CGFloat = 0
        /// the "Dealer" heading's natural width (the column's floor where the table fits; 0
        /// before measuring)
        var dealerHead: CGFloat = 0
    }

    /// A label's room beyond its text (the header's 1 pt padding each side, and a hair).
    static let pad: CGFloat = 6
    /// The Dealer column's leading gap, so "Hand" and "Dealer" never touch (review of PR #455:
    /// "HandDealer" at AX5).
    static let dealerGap: CGFloat = 4

    /// A dealer's name longer than its column (its 1 pt padding each side and the gap).
    private static func namesCut(_ i: Input, _ dealer: CGFloat) -> Bool { i.dealerNames > 0 && i.dealerNames + 2 + dealerGap > dealer + 0.5 }
    /// The width the "Dealer" heading needs whole: the word, its 1 pt padding each side, the gap
    /// after Hand and a hair (it is drawn with no scale factor below 1 at that width).
    static func headWidth(_ head: CGFloat) -> CGFloat { head > 0 ? head + 2 + dealerGap + 1 : 0 }
    private static func headCut(_ i: Input, _ dealer: CGFloat) -> Bool { i.dealerHead > 0 && headWidth(i.dealerHead) > dealer + 0.5 }

    static func solve(_ i: Input) -> ScorecardWidths {
        let n = CGFloat(max(i.players, 1))
        let nS = CGFloat(i.one.count)
        let floor = max(i.dealerMin, headWidth(i.dealerHead))
        let wantDealer = max(floor, min(i.dealerMax, i.dealerWant > 0 ? i.dealerWant + pad + dealerGap : 0))
        let wantOne = i.one.map { max(i.scoreMin, $0 > 0 ? $0 + pad : 0) }
        let wantTwo = i.two.map { max(i.scoreMin, $0 > 0 ? $0 + pad : 0) }
        let minTotal = i.hand + floor + i.scoreMin * nS + i.playerMin * n
        if i.width > 0, minTotal > i.width + 0.5 {
            // scrolls: nothing need be squeezed (a dealer past the cap still ends in "…"); the
            // players as wide as half their pair's label
            let pairHalf = ((i.pairs.max() ?? 0) + pad) / 2
            return ScorecardWidths(fits: false, dealer: wantDealer, player: max(i.playerMin, i.playerComfort, pairHalf), scores: wantOne,
                                   twoLine: false, labelsCut: false, dealerCut: namesCut(i, wantDealer), headCut: headCut(i, wantDealer))
        }
        guard i.width > 0 else {
            return ScorecardWidths(fits: true, dealer: i.dealerMin, player: i.playerMin, scores: i.one.map { _ in i.scoreMin },
                                   twoLine: false, labelsCut: false, dealerCut: false)
        }
        let rest = i.width - i.hand
        // the Score columns' room with the Dealer column at its heading: the players at their
        // comfort, else down to their minimum, before any pair's names are cut
        let comfortBudget = rest - floor - i.playerComfort * n
        let minBudget = rest - floor - i.playerMin * n
        let fitsIn = { (w: [CGFloat], b: CGFloat) in w.reduce(0, +) <= b + 0.5 }
        var scores = wantOne, twoLine = false, cut = false
        if fitsIn(wantOne, comfortBudget) {
        } else if i.twoLineAllowed, fitsIn(wantTwo, comfortBudget) {
            scores = wantTwo; twoLine = true
        } else if fitsIn(wantOne, minBudget) {
        } else if i.twoLineAllowed, fitsIn(wantTwo, minBudget) {
            scores = wantTwo; twoLine = true
        } else {
            let base = i.twoLineAllowed ? wantTwo : wantOne
            twoLine = i.twoLineAllowed
            let budget = max(i.scoreMin * nS, comfortBudget)
            let need = base.map { $0 - i.scoreMin }.reduce(0, +)
            let extra = max(0, budget - i.scoreMin * nS)
            scores = base.map { need > 0 ? i.scoreMin + extra * ($0 - i.scoreMin) / need : i.scoreMin }
            cut = true
        }
        let dealer = min(wantDealer, max(floor, rest - scores.reduce(0, +) - i.playerComfort * n))
        let player = max(i.playerMin, (rest - dealer - scores.reduce(0, +)) / n)
        return ScorecardWidths(fits: true, dealer: dealer, player: player, scores: scores, twoLine: twoLine, labelsCut: cut,
                               dealerCut: namesCut(i, dealer), headCut: headCut(i, dealer))
    }
}

/// One player's "bid → took" (the arrow muted; the took number gold for extra tricks, else the
/// cell's colour), in its role's dress: a red pill at fault, a green outline for a bore, both red
/// for a set bore. Get Your Bid's Forbidden Bid goes under it, small, muted and struck.
struct ScorecardCellView: View {
    let cell: Scorecard.Cell

    var body: some View {
        if let bid = cell.bid {
            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 1) {
                    Text(bid)
                    Text("\u{2192}").font(.caption2).foregroundColor(arrow)
                    Text(cell.took.map(String.init) ?? "\u{2013}")
                        .foregroundColor(Self.colour(cell.tookInk))
                        .fontWeight(cell.extra ? .semibold : nil)
                }
                .font(.footnote.monospacedDigit().weight(bore ? .semibold : .regular))
                .foregroundColor(Self.colour(cell.ink))
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 6).fill(fill))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(stroke, lineWidth: 1.5))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                if let f = cell.forbidden {
                    // Get Your Bid: the last bidder's Forbidden Bid, struck as on the bid sheet,
                    // muted (red is the fault's) and under the cell (never read as a took digit)
                    Text("\(f)").font(.caption2.monospacedDigit()).strikethrough().foregroundColor(Theme.textDim)
                        .lineLimit(1)
                }
            }
        } else {
            Text("\u{2013}").font(.footnote).foregroundColor(Theme.textDim)
        }
    }

    /// The Theme colour of an ink (the only colours a cell's text takes).
    static func colour(_ ink: Scorecard.Ink) -> Color {
        switch ink {
        case .plain: return Theme.textPrimary
        case .gold: return Theme.gold
        case .red: return Theme.error
        case .green: return Theme.primary
        }
    }

    private var bore: Bool { cell.role == .bore || cell.role == .boreSet }
    private var arrow: Color { cell.role == .plain ? Theme.textDim : Self.colour(cell.ink).opacity(0.8) }
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
