import Foundation

/// One badge a player has EARNED (contract `$defs.earnedBadge` {id, name, description, at?}):
/// the profile replies' `badges` and s2c `badgesAwarded.badges`, sent only because this
/// build's clientHello carries the cap `badges` (`Badges.cap`).
///
/// The app holds NO catalog (owner 2026-11-25: unearned badges are a surprise): it only ever
/// draws the badges the server sent for a player who earned them. The art is the asset
/// `Badges/<id>` (Misc.xcassets, the web's client/assets/badges/<id>.svg copied with its
/// vector data); an id this build has no art for (a badge added on the server later) shows
/// its name and description without a picture.
struct EarnedBadge: Equatable, Hashable, Identifiable {
    let id: String
    let name: String
    let description: String
}

/// The badge rules the web's client/src/ui/components/Badges.js has, held to its words.
enum Badges {
    /// The clientHello capability that asks the server for badges (ServerConfig `ClientHello.caps`).
    static let cap = "badges"
    /// `$defs.earnedBadge.id` maxLength.
    static let maxIdLength = 40
    /// At most this many pictures in one toast (the web's TOAST_ART_MAX; the words name every one).
    static let toastArtMax = 4

    /// A badge id is a file name: lower-case words (a-z, 0-9) joined by single hyphens.
    static func isId(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= maxIdLength else { return false }
        let words = id.split(separator: "-", omittingEmptySubsequences: false)
        return words.allSatisfy { w in
            !w.isEmpty && w.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
        }
    }

    /// The entries worth drawing (the web's cleanBadges): a file-safe id and a non-empty name,
    /// each id once, in the server's order (oldest first). Anything else, or a missing field,
    /// is no badges: never fails the reply.
    static func clean(_ wire: Any?) -> [EarnedBadge] {
        guard let list = wire as? [Any] else { return [] }
        var seen = Set<String>()
        var out: [EarnedBadge] = []
        for item in list {
            guard let b = item as? [String: Any], let id = b["id"] as? String, isId(id),
                  let name = b["name"] as? String, !name.isEmpty, !seen.contains(id) else { continue }
            seen.insert(id)
            out.append(EarnedBadge(id: id, name: name, description: b["description"] as? String ?? ""))
        }
        return out
    }

    /// The toast's words (the web's badgesEarnedText): "Badge earned: <name>" /
    /// "Badges earned: <name>, <name>"; "" for none.
    static func earnedText(_ badges: [EarnedBadge]) -> String {
        let names = badges.map(\.name)
        guard !names.isEmpty else { return "" }
        return "\(names.count == 1 ? "Badge earned" : "Badges earned"): \(names.joined(separator: ", "))"
    }

    /// The asset catalog name of a badge's art.
    static func artName(_ id: String) -> String { "Badges/\(id)" }
}
