/**
 * scripts/check-apple-platform.js: no UIKit or AppKit in a shared Swift file of the Apple app
 * (iOSClient/CLAUDE.md, "iOS project": the platform rules). The checkout passes, and the
 * rule's cases hold.
 */

const { checkSource, checkApp } = require('../../scripts/check-apple-platform');

describe('Apple platform rule', () => {
    test('the checkout has no UIKit or AppKit outside its platform files', () => {
        expect(checkApp()).toEqual([]);
    });

    test('UIKit and UIApplication only in a whole-file #if os(iOS) file', () => {
        expect(checkSource('Views/Foo.swift', 'import SwiftUI\nimport UIKit\n')).toEqual([
            { line: 2, what: 'import UIKit', os: 'iOS' },
        ]);
        expect(checkSource('State/Foo.swift', 'let s = UIApplication.shared\n')).toEqual([
            { line: 1, what: 'UIApplication', os: 'iOS' },
        ]);
        expect(checkSource('Views/Foo+iOS.swift', '// iOS only\n\n#if os(iOS)\nimport UIKit\nlet s = UIApplication.shared\n#endif\n')).toEqual([]);
        // an in-file block is not a whole-file iOS file
        expect(checkSource('Views/Foo.swift', 'import SwiftUI\n#if os(iOS)\nimport UIKit\n#endif\n')).toHaveLength(1);
        // a macOS file may not use UIKit either
        expect(checkSource('Views/Foo+macOS.swift', '#if os(macOS)\nimport UIKit\n#endif\n')).toHaveLength(1);
    });

    test('AppKit and NSApp only in a whole-file #if os(macOS) file', () => {
        expect(checkSource('App/Foo.swift', 'import AppKit\nlet w = NSApp.keyWindow\n')).toEqual([
            { line: 1, what: 'import AppKit', os: 'macOS' },
            { line: 2, what: 'NSApp', os: 'macOS' },
        ]);
        expect(checkSource('App/Foo+macOS.swift', '#if os(macOS)\nimport AppKit\nlet w = NSApp.keyWindow\n#endif\n')).toEqual([]);
        expect(checkSource('App/Foo.swift', 'let a = NSApplication.shared\n')).toEqual([
            { line: 1, what: 'NSApplication', os: 'macOS' },
        ]);
        expect(checkSource('App/Foo.swift', 'let a = NSApplicationMain\n')).toEqual([]);
    });

    test('a scoped import is an import of the module', () => {
        expect(checkSource('Views/Foo.swift', 'import class UIKit.UIImage\n')).toEqual([
            { line: 1, what: 'import UIKit', os: 'iOS' },
        ]);
        expect(checkSource('Views/Foo.swift', '@preconcurrency import struct AppKit.NSEdgeInsets\n')).toEqual([
            { line: 1, what: 'import AppKit', os: 'macOS' },
        ]);
    });

    test('Platform/ may hold both halves', () => {
        expect(checkSource('Platform/PlatformTypes.swift', 'import SwiftUI\n#if os(iOS)\nimport UIKit\n#endif\nlet w = NSApp\n')).toEqual([]);
    });

    test('comments, strings and longer names are not uses', () => {
        const source = [
            'import SwiftUI',
            '/// Set from UIApplication\'s notifications (not import UIKit)',
            '/* NSApp.keyWindow /* nested */ import AppKit */',
            'let s = "UIApplication.shared"',
            'let t = """',
            'import UIKit',
            '"""',
            '@UIApplicationDelegateAdaptor(AppDelegate.self) var d',
        ].join('\n');
        expect(checkSource('BABOnlineApp.swift', source)).toEqual([]);
    });
});
