import XCTest
import CoreGraphics

/// A node position against a layout point. SKNode keeps positions as Float, and a zoomed
/// table's scene units (the pane / TableLayout.zoom: an iPad) are fractions a Float cannot
/// hold exactly, so the comparison allows its rounding (a zoom-1 phone layout is exact).
func XCTAssertNear(_ a: CGPoint, _ b: CGPoint, _ message: @autoclosure () -> String = "", accuracy: CGFloat = 0.001,
                   file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(a.x, b.x, accuracy: accuracy, "x \(message())", file: file, line: line)
    XCTAssertEqual(a.y, b.y, accuracy: accuracy, "y \(message())", file: file, line: line)
}
