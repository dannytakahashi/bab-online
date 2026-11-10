/**
 * Resizing a Phaser shape in place (item 17 relayout).
 *
 * Phaser 3.55's Rectangle.setSize updates the width, the geometry and the
 * path, but not the display origin: the shape keeps origin x its FIRST size
 * and draws off-centre after a resize (the trump box drifted ~31 px right
 * and down going from a phone-sized table to 1440x790). Every relayout that
 * resizes a shape goes through here.
 *
 * @param {Phaser.GameObjects.Shape} shape
 * @param {number} w
 * @param {number} h
 * @returns the shape
 */
export function resizeShape(shape, w, h) {
  if (!shape) return shape;
  shape.setSize?.(w, h);
  shape.updateDisplayOrigin?.();
  return shape;
}
