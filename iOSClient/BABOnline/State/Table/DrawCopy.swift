import Foundation
import CoreGraphics

/// A tournament table's planned teams (startDraw.teams, snapshot draw.teams; contract $defs
/// plannedTeamPlayer), as the web's state/drawTeams.js keeps them: exactly two teams of two
/// players, each with a non-empty username, else nil (the draw then shows as a casual one).
enum PlannedTeams {
    typealias Player = TableSnapshot.PlannedTeamPlayer

    static func valid(_ teams: [[Player]]?) -> [[Player]]? {
        guard let teams, teams.count == 2, teams.allSatisfy({ $0.count == 2 && $0.allSatisfy { !$0.username.isEmpty } }) else {
            return nil
        }
        return teams
    }
}

/// The draw's words (owner 2026-11-25), mirroring the web's client/src/ui/drawCopy.js (its
/// test, DrawFirstDealTests, reads that file, so change them there and here together): a casual
/// table's "Draw for Deal", where the two highest cards are partners, and a tournament table's
/// draw for first deal, whose teams the round's plan already set (the draw decides only the
/// seats and who deals first).
///
/// Teams are named by their players, never "Team 1" / "T1" / "Your Team" (owner rule): the
/// viewer's own team first as "You & <partner>", a spectator's in plan order with full names;
/// a bot keeps its persona name.
enum DrawCopy {
    struct Words: Equatable { let title: String; let rules: String }

    static let casual = Words(title: "Draw for Deal", rules: "The two highest cards are partners; the highest deals.")
    static let planned = Words(title: "Draw for First Deal", rules: "Partners are set for this round. The highest card deals first.")

    static func title(planned isPlanned: Bool) -> String { isPlanned ? planned.title : casual.title }
    static func rules(planned isPlanned: Bool) -> String { isPlanned ? planned.rules : casual.rules }

    /// One player in display order: `mine` is the viewer.
    struct Person: Equatable { let name: String; let mine: Bool }

    private static func nameOf(_ p: PlannedTeams.Player) -> String {
        let n = p.username.trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? "Player" : n
    }

    /// The teams in display order: the viewer's team first with the viewer first in it (`me`
    /// matches a non-bot player's username); otherwise plan order (the web's orderTeams).
    static func orderTeams(_ teams: [[PlannedTeams.Player]], me: String?) -> [[Person]] {
        let isMe = { (p: PlannedTeams.Player) in me.map { !$0.isEmpty && !p.isBot && nameOf(p) == $0 } ?? false }
        let at = teams.firstIndex { $0.contains(where: isMe) }
        let ordered: [[PlannedTeams.Player]]
        if let at, at > 0 {
            ordered = [teams[at]] + teams.enumerated().filter { $0.offset != at }.map(\.element)
        } else {
            ordered = teams
        }
        return ordered.map { team in
            let people = team.map { Person(name: nameOf($0), mine: isMe($0)) }
            return people.contains(where: \.mine) ? people.filter(\.mine) + people.filter { !$0.mine } : people
        }
    }

    /// One line: "You & Hannah vs Danny & Clara" (the viewer's team first), or "Hannah & Danny
    /// vs Clara & 🤖 Mary" for a spectator. "" without teams.
    static func teamsLine(_ teams: [[PlannedTeams.Player]]?, me: String?) -> String {
        guard let teams else { return "" }
        let ordered = orderTeams(teams, me: me)
        guard ordered.count == 2 else { return "" }
        return ordered.map { $0.map { $0.mine ? "You" : $0.name }.joined(separator: " & ") }.joined(separator: " vs ")
    }

    /// The line's parts for a view that cuts each name on its own (so "&" and "vs" always
    /// show): each team's display names ("You" for the viewer).
    static func teamsNames(_ teams: [[PlannedTeams.Player]]?, me: String?) -> [[String]] {
        guard let teams else { return [] }
        let ordered = orderTeams(teams, me: me)
        guard ordered.count == 2 else { return [] }
        return ordered.map { $0.map { $0.mine ? "You" : $0.name } }
    }

    /// The line `names` (teamsNames) makes in `width` points, `measure` giving a string's
    /// full-size width: the whole line when it fits at up to `minScale` (the Text shrinks it),
    /// else each name cut at its end into its share of the room the " & " / " vs " leave, so the
    /// separators always show (the score bar's `fittedNames` rule over four names). A name that
    /// fits its share keeps all of it and the rest share what is left.
    static func fittedLine(_ names: [[String]], width: CGFloat, minScale: CGFloat, measure: (String) -> CGFloat) -> String {
        guard names.count == 2, names.allSatisfy({ !$0.isEmpty }) else { return "" }
        let join = { (n: [[String]]) in n.map { $0.joined(separator: " & ") }.joined(separator: " vs ") }
        let whole = join(names)
        // a hair under the line, so the Text's own measure never truncates what is left
        let budget = max(0, width / max(minScale, 0.01) - 2)
        if measure(whole) <= budget { return whole }
        let flat = names.flatMap { $0 }
        let widths = flat.map(measure)
        var room = max(0, budget - (measure(whole) - widths.reduce(0, +)))
        var shares = [CGFloat](repeating: 0, count: flat.count)
        var left = Array(flat.indices).sorted { widths[$0] < widths[$1] }
        while let i = left.first, widths[i] <= room / CGFloat(left.count) {
            shares[i] = widths[i]
            room -= widths[i]
            left.removeFirst()
        }
        for i in left { shares[i] = room / CGFloat(left.count) }
        var k = 0
        let cutNames = names.map { team in
            team.map { name -> String in
                defer { k += 1 }
                return cut(name, to: shares[k], measure: measure)
            }
        }
        return join(cutNames)
    }

    /// `name` whole if it fits `width`, else its longest start that fits with "…" (at least one
    /// character and the "…").
    static func cut(_ name: String, to width: CGFloat, measure: (String) -> CGFloat) -> String {
        if measure(name) <= width { return name }
        let chars = Array(name)
        var k = chars.count - 1
        while k > 1 {
            let head = String(chars[..<k]).trimmingCharacters(in: .whitespaces)
            if !head.isEmpty, measure(head + "…") <= width { return head + "…" }
            k -= 1
        }
        return String(chars.prefix(1)) + "…"
    }

    /// What VoiceOver says for the line: "Partners: you and Hannah versus Danny and Clara".
    /// "" without teams.
    static func teamsSpoken(_ teams: [[PlannedTeams.Player]]?, me: String?) -> String {
        guard let teams else { return "" }
        let ordered = orderTeams(teams, me: me)
        guard ordered.count == 2 else { return "" }
        return "Partners: " + ordered.map { $0.map { $0.mine ? "you" : $0.name }.joined(separator: " and ") }.joined(separator: " versus ")
    }
}
