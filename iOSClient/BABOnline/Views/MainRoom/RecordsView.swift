import SwiftUI

/// The Stats sheet's Records tab: the web RecordsPage (the total game count, then All Time,
/// This Year and This Month, each with highest / lowest score, biggest win and most / least
/// bags; same labels, tones and lines; "No games yet" for an empty period or record). The
/// periods are cards on surface.s1 in an adaptive grid: three across where they fit (the
/// iPad). Where only one fits (phones, the closed Duo) a segmented All Time / This Year /
/// This Month control shows one card at a time, so This Month is one tap away rather than
/// two cards down; at accessibility sizes (where three segments cannot be read) the cards
/// stack.
struct RecordsView: View {
    @EnvironmentObject var state: RecordsState
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var cardMinWidth: CGFloat = 230

    var body: some View {
        GeometryReader { geo in
            content(height: geo.size.height, columns: columns(for: geo.size.width))
        }
        .onAppear { state.request() }
        .onChange(of: state.scope) { state.request() }
    }

    @ViewBuilder
    private func content(height: CGFloat, columns: Int) -> some View {
        switch state.load.display {
        case .loading:
            StatsLoadingView(label: "Loading records")
        case .failed(let f):
            ScrollView {
                StatsMessageView.failure(f, what: "Records") { state.request() }
                    .frame(minHeight: height)
            }
            .refreshable { await state.refresh() }
        case .content:
            ScrollView {
                VStack(spacing: Theme.Space.s4) {
                    if let failure = state.load.failure, !state.load.isLoading {
                        StatsRefreshBanner(failure: failure) { state.request() }
                    }
                    if let records = state.load.value {
                        if let total = records.totalGames { totalLine(total) }
                        if state.scope != .human, records.isEmpty { botsNote }
                        // not lazy: every card shown is in the accessibility tree
                        let picks = columns == 1 && !typeSize.isAccessibilitySize
                        let periods = picks ? [state.period] : GameRecords.Period.allCases
                        if picks { periodPicker }
                        VStack(spacing: Theme.Space.s4) {
                            ForEach(Array(stride(from: 0, to: periods.count, by: columns)), id: \.self) { start in
                                HStack(alignment: .top, spacing: Theme.Space.s4) {
                                    ForEach(periods[start..<min(start + columns, periods.count)]) { period in
                                        PeriodCard(period: period, records: records.periods[period])
                                    }
                                    // a short last row keeps the cards' width
                                    ForEach(0..<max(0, start + columns - periods.count), id: \.self) { _ in
                                        Color.clear.frame(maxWidth: .infinity, maxHeight: 0)
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(Theme.Space.s4)
                .frame(maxWidth: 1000)
                .frame(maxWidth: .infinity)
            }
            .refreshable { await state.refresh() }
            .accessibilityIdentifier("records.list")
        }
    }

    /// One period at a time (one card across, standard type sizes); kept for the session.
    private var periodPicker: some View {
        Picker("Period", selection: $state.period) {
            ForEach(GameRecords.Period.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("records.periods")
        .sensoryFeedback(.selection, trigger: state.period)
    }

    /// Bots or All with no game yet: the server counts games with bots from its update on.
    private var botsNote: some View {
        Text(StatsScope.botsFromNowNote)
            .font(.footnote)
            .foregroundStyle(Theme.textSecondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("records.botsNote")
    }

    /// One, two or three cards across: as many as fit at their minimum width.
    private func columns(for width: CGFloat) -> Int {
        let usable = min(width, 1000) - Theme.Space.s4 * 2
        return max(1, min(3, Int((usable + Theme.Space.s4) / (cardMinWidth + Theme.Space.s4))))
    }

    /// "1,234 games played" (the web's toLocaleString count in bold).
    private func totalLine(_ total: Int) -> some View {
        (Text(total.formatted()).bold().foregroundColor(Theme.textPrimary)
            + Text(total == 1 ? " game played" : " games played").foregroundColor(Theme.textSecondary))
            .font(.subheadline)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("records.total")
    }
}

/// One period's box (the web's .records-box).
private struct PeriodCard: View {
    let period: GameRecords.Period
    let records: GameRecords.PeriodRecords?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s3) {
            Text(period.title)
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .center)
                .accessibilityAddTraits(.isHeader)
            Divider().background(Theme.divider)
            if let records {
                ForEach(RecordRow.rows(records)) { row in
                    RecordEntry(row: row)
                }
            } else {
                Text("No games yet")
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, Theme.Space.s2)
            }
        }
        .padding(Theme.Space.s4)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).stroke(Theme.divider, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("records.period.\(period.rawValue)")
    }
}

/// One record (the web's .record): the label in its tone, the value, the lines under it.
private struct RecordEntry: View {
    let row: RecordRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.label)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(tone)
            if let value = row.value {
                Text(value)
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                ForEach(Array(row.lines.enumerated()), id: \.offset) { _, line in
                    lineText(line)
                }
            } else {
                Text("No games yet")
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(Theme.textDim)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.spoken)
        .accessibilityIdentifier("records.\(row.label)")
    }

    private var tone: Color {
        switch row.tone {
        case .success: return Theme.success
        case .danger: return Theme.error
        case .warning: return Theme.warning
        case .neutral: return Theme.textSecondary
        }
    }

    private func lineText(_ line: RecordRow.Line) -> some View {
        let (text, color): (String, Color) = {
            switch line {
            case .plain(let s): return (s, Theme.textSecondary)
            case .winner(let s): return (s, Theme.success)
            case .loser(let s): return (s, Theme.error)
            }
        }()
        return Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }
}
