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

    /// Get the three opponent/partner positions relative to my position.
    /// Returns (partner, opp1, opp2) where opp1 is left, opp2 is right.
    static func getRelativePositions(myPos: Int) -> (partner: Int, opp1: Int, opp2: Int) {
        let partner = team(myPos)
        let opp1 = rotate(myPos)
        let opp2 = rotate(rotate(rotate(myPos)))
        return (partner, opp1, opp2)
    }
}
