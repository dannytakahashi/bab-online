import SpriteKit

extension SKLabelNode {
    /// SpriteKit rasterizes a label at its font size and the screen scale, so a zoomed table's
    /// camera (TableLayout.zoom, up to 1.4 on an iPad) would upscale that bitmap and soften the
    /// text. This draws the text `CardTextureGenerator.textureZoom` times larger and scales the
    /// node back by as much: the same size in scene units (its `frame` is unchanged up to font
    /// rounding), crisp at any zoom up to the device's largest. On a phone the factor is 1 and
    /// nothing changes. Call it after the font size and wrap width are set, before measuring.
    func drawForTableZoom() {
        let k = CardTextureGenerator.textureZoom
        guard k != 1 else { return }
        fontSize *= k
        preferredMaxLayoutWidth *= k
        setScale(1 / k)
    }
}
