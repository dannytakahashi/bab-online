import Foundation

/// Position and team utilities for the 4-player game.
/// Teams: Positions 1 & 3 vs Positions 2 & 4
/// Rotation: Clockwise 1 → 2 → 3 → 4 → 1
enum Positions {
    /// Get partner position. Teams: 1 & 3, 2 & 4
    static func team(_ position: Int) -> Int {
        switch position {
        case 1: return 3
        case 2: return 4
        case 3: return 1
        case 4: return 2
        default: return 0
        }
    }

    /// Rotate to next position clockwise: 1 → 2 → 3 → 4 → 1
    static func rotate(_ position: Int) -> Int {
        (position % 4) + 1
    }

    /// Check if two positions are on the same team.
    static func isSameTeam(_ pos1: Int, _ pos2: Int) -> Bool {
        team(pos1) == pos2
    }

    /// Get team number: Team 1 = positions 1 & 3, Team 2 = positions 2 & 4
    static func getTeamNumber(_ position: Int) -> Int {
        (position == 1 || position == 3) ? 1 : 2
    }

    /// Get relative position from viewer's perspective.
    /// Maps absolute positions to: bottom (me), left, top, right
    enum RelativePosition: String {
        case bottom, left, top, right
    }

    static func getRelative(target: Int, from myPos: Int) -> RelativePosition {
        let offset = (target - myPos + 4) % 4
        switch offset {
        case 0: return .bottom
        case 1: return .left
        case 2: return .top
        case 3: return .right
        default: return .bottom
        }
    }

    // MARK: - Seat count aware (Get Your Bid: three seats, no teams; the web's utils/positions.js)

    /// The next seat in turn at a table of `seats` (3 at a Get Your Bid table).
    static func rotate(_ position: Int, seats: Int) -> Int {
        seats == 4 ? rotate(position) : (position % seats) + 1
    }

    /// Where `target` sits as `myPos` sees the table. At three seats the next in turn is on my
    /// left, the one after on my right, and nobody sits across (`.top` is never used).
    static func getRelative(target: Int, from myPos: Int, seats: Int) -> RelativePosition {
        guard seats == 3 else { return getRelative(target: target, from: myPos) }
        switch (target - myPos + 3) % 3 {
        case 1: return .left
        case 2: return .right
        default: return .bottom
        }
    }

    /// The other seats as `me` sees them: the partner across (none at three seats), opp1 the
    /// next in turn (left), opp2 the other opponent (right).
    static func around(_ me: Int, seats: Int) -> (partner: Int?, opp1: Int, opp2: Int) {
        guard seats == 3 else {
            let r = getRelativePositions(myPos: me)
            return (r.partner, r.opp1, r.opp2)
        }
        let opp1 = rotate(me, seats: 3)
        return (nil, opp1, rotate(opp1, seats: 3))
    }

    /// Are two seats opponents? Every other seat at a three-seat table (no teams); seat
    /// parity at four (the HI joker rule, the over-trump effect).
    static func areOpponents(_ a: Int, _ b: Int, seats: Int) -> Bool {
        seats == 3 ? a != b : a % 2 != b % 2
    }

    /// A seat's colour as a team number for Theme.team: 1 / 2 by team at four seats; at three,
    /// each seat its own (1 blue, 2 coral, 3 gold: the web's seatLetter a / b / c).
    static func colour(_ position: Int, seats: Int) -> Int {
        seats == 3 ? ((1...3).contains(position) ? position : 1) : getTeamNumber(position)
    }

    /// Get the three opponent/partner positions relative to my position.
    /// Returns (partner, opp1, opp2) where opp1 is left, opp2 is right.
    static func getRelativePositions(myPos: Int) -> (partner: Int, opp1: Int, opp2: Int) {
        let partner = team(myPos)
        let opp1 = rotate(myPos)
        let opp2 = rotate(rotate(rotate(myPos)))
        return (partner, opp1, opp2)
    }
}
