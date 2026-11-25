#if os(iOS)
import SpriteKit
import UIKit

/// The touches as `TableInput` (GameSKScene+Input.swift): a seat tap is one touch that went
/// down on the scene and lifted with a tap count of 1.
extension GameSKScene {
    open override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        if touches.count == 1, let touch = touches.first {
            handle(.down(touch.location(in: self), id: ObjectIdentifier(touch)))
        } else {
            handle(.cancel)
        }
    }

    open override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        handle(.cancel)
    }

    open override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        if touches.count == 1, let touch = touches.first {
            handle(.up(touch.location(in: self), id: ObjectIdentifier(touch), clicks: touch.tapCount))
        } else {
            handle(.cancel)
        }
    }
}
#endif
