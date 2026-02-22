import SpriteKit

/// Displays an opponent's name label, turn glow, avatar, and bid bubble.
/// Card-back fans are removed; opponents are lightweight anchors.
class OpponentHandNode: SKNode {
    let relativePosition: Positions.RelativePosition

    private let nameLabel: SKLabelNode
    private var turnGlow: SKShapeNode?
    private var avatarNode: SKShapeNode?
    private var avatarSprite: SKSpriteNode?
    private let avatarRadius: CGFloat = 20

    init(position: Positions.RelativePosition, username: String, pic: String? = nil) {
        self.relativePosition = position

        nameLabel = SKLabelNode(text: username)
        nameLabel.fontName = "Helvetica-Bold"
        nameLabel.fontSize = 14
        nameLabel.fontColor = .white

        super.init()

        self.name = "opponent_\(position.rawValue)"

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
        nameLabel.text = name
    }

    // MARK: - Turn Glow

    func showTurnGlow() {
        guard turnGlow == nil else { return }
        let glow = SKShapeNode(circleOfRadius: 30)
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

    func updatePic(_ pic: String) {
        guard let circle = avatarNode else { return }
        // Remove existing avatar content (initial letter or crop node)
        circle.childNode(withName: "avatar_initial")?.removeFromParent()
        for child in circle.children {
            if child is SKCropNode {
                child.removeFromParent()
            }
        }
        avatarSprite = nil
        loadProfilePic(pic)
    }

    func cleanup() {
        turnGlow?.removeFromParent()
        turnGlow = nil
    }

    // MARK: - Profile Pic

    private func loadProfilePic(_ pic: String) {
        // Base64 custom pic
        if pic.starts(with: "data:image"), let commaIndex = pic.firstIndex(of: ",") {
            let base64 = String(pic[pic.index(after: commaIndex)...])
            if let data = Data(base64Encoded: base64), let image = UIImage(data: data) {
                applyAvatarImage(image)
            }
            return
        }

        // Numbered pic — load from server
        if let picNum = Int(pic) {
            #if targetEnvironment(simulator)
            let baseURL = "http://localhost:3000"
            #else
            let baseURL = "https://babonline.io"
            #endif
            guard let url = URL(string: "\(baseURL)/assets/profile\(picNum).png") else { return }

            URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                guard let data, let image = UIImage(data: data) else { return }
                DispatchQueue.main.async {
                    self?.applyAvatarImage(image)
                }
            }.resume()
        }
    }

    private func applyAvatarImage(_ image: UIImage) {
        guard let circle = avatarNode else { return }

        // Remove initial letter
        circle.childNode(withName: "avatar_initial")?.removeFromParent()

        // Create texture and crop to circle
        let texture = SKTexture(image: image)
        let sprite = SKSpriteNode(texture: texture, size: CGSize(width: avatarRadius * 2, height: avatarRadius * 2))
        sprite.position = .zero

        // Use a crop node for circular masking
        let mask = SKShapeNode(circleOfRadius: avatarRadius)
        mask.fillColor = .white
        let crop = SKCropNode()
        crop.maskNode = mask
        crop.addChild(sprite)
        circle.addChild(crop)
        avatarSprite = sprite
    }
}
