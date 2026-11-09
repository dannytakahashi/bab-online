import SpriteKit

/// Loads numbered avatars (stubbed in tests so a render is deterministic).
protocol AvatarLoading {
    func load(_ picNumber: Int, completion: @escaping (UIImage?) -> Void)
}

struct HTTPAvatarLoader: AvatarLoading {
    func load(_ picNumber: Int, completion: @escaping (UIImage?) -> Void) {
        #if targetEnvironment(simulator)
        let baseURL = "http://localhost:3000"
        #else
        let baseURL = "https://babonline.io"
        #endif
        guard let url = URL(string: "\(baseURL)/assets/profile\(picNumber).png") else { return completion(nil) }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            let image = data.flatMap { UIImage(data: $0) }
            DispatchQueue.main.async { completion(image) }
        }.resume()
    }
}

/// Displays an opponent's name label, turn glow, avatar, and bid bubble.
/// Card-back fans are removed; opponents are lightweight anchors.
class OpponentHandNode: SKNode {
    let relativePosition: Positions.RelativePosition

    private let nameLabel: SKLabelNode
    private var turnGlow: SKShapeNode?
    private var speakingGlow: SKShapeNode?
    private var avatarNode: SKShapeNode?
    private var avatarSprite: SKSpriteNode?
    private let avatarRadius: CGFloat = AvatarTextureCache.diameter / 2
    /// Bumped by every picture change: a load that answers for an older picture is dropped.
    private var avatarGeneration = 0
    private(set) var pic: String?
    /// The untruncated username (the label shows at most TableLayout.nameMaxWidth).
    private(set) var fullName: String
    static var avatarLoader: AvatarLoading = HTTPAvatarLoader()

    init(position: Positions.RelativePosition, username: String, pic: String? = nil) {
        self.relativePosition = position

        nameLabel = SKLabelNode(text: username)
        nameLabel.fontName = "Helvetica-Bold"
        nameLabel.fontSize = 14
        nameLabel.fontColor = .white
        fullName = username

        super.init()
        Self.fit(nameLabel, username)

        self.name = "seat.\(position.rawValue)"
        self.pic = pic

        // Avatar circle
        let circle = SKShapeNode(circleOfRadius: avatarRadius)
        circle.fillColor = UIColor(red: 0.2, green: 0.3, blue: 0.2, alpha: 1)
        circle.strokeColor = UIColor(white: 0.4, alpha: 1)
        circle.lineWidth = 1.5
        circle.position = .zero
        addChild(circle)
        avatarNode = circle

        // Initial letter fallback
        let initial = SKLabelNode(text: String(username.prefix(1)).uppercased())
        initial.fontName = "Helvetica-Bold"
        initial.fontSize = avatarRadius * 0.9
        initial.fontColor = .white
        initial.verticalAlignmentMode = .center
        initial.horizontalAlignmentMode = .center
        initial.name = "avatar_initial"
        circle.addChild(initial)

        // Position name label below avatar
        nameLabel.position = CGPoint(x: 0, y: -(avatarRadius + 16))
        addChild(nameLabel)

        // Load profile pic async
        if let pic = pic {
            loadProfilePic(pic)
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    func updateUsername(_ name: String) {
        guard fullName != name else { return }
        fullName = name
        Self.fit(nameLabel, name)
        (avatarNode?.childNode(withName: "avatar_initial") as? SKLabelNode)?.text = String(name.prefix(1)).uppercased()
    }

    /// The name, truncated with "…" to TableLayout.nameMaxWidth (the layout reserves that width).
    static func fit(_ label: SKLabelNode, _ name: String) {
        label.text = name
        guard label.frame.width > TableLayout.nameMaxWidth else { return }
        var chars = Array(name)
        while !chars.isEmpty {
            chars.removeLast()
            label.text = String(chars).trimmingCharacters(in: .whitespaces) + "\u{2026}"
            if label.frame.width <= TableLayout.nameMaxWidth { return }
        }
    }

    /// In-place update from the model (22.8): the avatar reloads only when the picture changes.
    func update(name: String, pic newPic: String?, isTurn: Bool) {
        updateUsername(name)
        if newPic != pic {
            pic = newPic
            if let p = newPic { updatePic(p) } else { clearPic(initial: name) }
        }
        if isTurn { showTurnGlow() } else { hideTurnGlow() }
    }

    private func clearPic(initial name: String) {
        avatarGeneration += 1
        guard let circle = avatarNode else { return }
        removeAvatarImage(from: circle)
        if circle.childNode(withName: "avatar_initial") == nil {
            let initial = SKLabelNode(text: String(name.prefix(1)).uppercased())
            initial.fontName = "Helvetica-Bold"
            initial.fontSize = avatarRadius * 0.9
            initial.fontColor = .white
            initial.verticalAlignmentMode = .center
            initial.horizontalAlignmentMode = .center
            initial.name = "avatar_initial"
            circle.addChild(initial)
        }
    }

    var hasTurnGlow: Bool { turnGlow != nil }

    // MARK: - Turn Glow

    func showTurnGlow() {
        guard turnGlow == nil else { return }
        let glow = SKShapeNode(circleOfRadius: 30)
        glow.name = "glow.turn"
        glow.fillColor = UIColor(red: 0.2, green: 0.8, blue: 0.4, alpha: 0.5)
        glow.strokeColor = .clear
        glow.zPosition = -1
        glow.run(CardAnimations.pulseGlow())
        addChild(glow)
        turnGlow = glow
    }

    func hideTurnGlow() {
        turnGlow?.removeFromParent()
        turnGlow = nil
    }

    // MARK: - Speaking Glow

    func showSpeakingGlow() {
        guard speakingGlow == nil else { return }
        let glow = SKShapeNode(circleOfRadius: 28)
        glow.name = "glow.speaking"
        glow.fillColor = UIColor(red: 0.1, green: 0.9, blue: 0.3, alpha: 0.4)
        glow.strokeColor = UIColor(red: 0.1, green: 0.9, blue: 0.3, alpha: 0.7)
        glow.lineWidth = 1.5
        glow.zPosition = -2
        glow.run(CardAnimations.pulseGlow())
        addChild(glow)
        speakingGlow = glow
    }

    func hideSpeakingGlow() {
        speakingGlow?.removeFromParent()
        speakingGlow = nil
    }

    func updatePic(_ pic: String) {
        // Back to the initial letter (as a new node starts) until the new picture loads
        clearPic(initial: fullName)
        loadProfilePic(pic)
    }

    func cleanup() {
        turnGlow?.removeFromParent()
        turnGlow = nil
        speakingGlow?.removeFromParent()
        speakingGlow = nil
    }

    // MARK: - Profile Pic

    /// Shows `pic` from AvatarTextureCache: at once when it is cached (or a data URL),
    /// else when its load answers, unless the seat's picture changed meanwhile.
    private func loadProfilePic(_ pic: String) {
        avatarGeneration += 1
        let generation = avatarGeneration
        AvatarTextureCache.texture(for: pic, loader: Self.avatarLoader) { [weak self] texture in
            guard let self, let texture, self.avatarGeneration == generation, self.pic == pic else { return }
            self.applyAvatar(texture)
        }
    }

    /// The avatar sprite off the circle.
    private func removeAvatarImage(from circle: SKShapeNode) {
        circle.children.filter { $0.name == Self.avatarImageName }.forEach { $0.removeFromParent() }
        avatarSprite = nil
    }

    static let avatarImageName = "avatar.image"

    /// One pre-cut circular sprite per seat: any earlier one is replaced.
    private func applyAvatar(_ texture: SKTexture) {
        guard let circle = avatarNode else { return }
        removeAvatarImage(from: circle)
        circle.childNode(withName: "avatar_initial")?.removeFromParent()
        let sprite = SKSpriteNode(texture: texture, size: CGSize(width: avatarRadius * 2, height: avatarRadius * 2))
        sprite.name = Self.avatarImageName
        sprite.position = .zero
        circle.addChild(sprite)
        avatarSprite = sprite
    }

    #if DEBUG
    /// Tests: avatar images and crop nodes on this seat (never more than one image, no crop node).
    var avatarImageCount: Int { avatarNode?.children.filter { $0.name == Self.avatarImageName }.count ?? 0 }
    var avatarCropNodeCount: Int { avatarNode?.children.filter { $0 is SKCropNode }.count ?? 0 }
    var avatarTexture: SKTexture? { avatarSprite?.texture }
    #endif
}

