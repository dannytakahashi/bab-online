import SwiftUI

/// Branded splash screen shown on app launch.
struct SplashView: View {
    @State private var showSymbols = false
    @State private var showTitle = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let suitColors: [Color] = [.spades, .hearts, .diamonds, .clubs].map(Theme.suitOnDark)

    var body: some View {
        ZStack {
            Theme.background
                .ignoresSafeArea()

            VStack(spacing: Theme.Space.s8) {
                // Card suits in a diamond layout
                VStack(spacing: Theme.Space.s2) {
                    // Top: spade
                    suitText("\u{2660}", color: suitColors[0], delay: 0.1)

                    // Middle row: heart + diamond
                    HStack(spacing: Theme.Space.s10) {
                        suitText("\u{2665}", color: suitColors[1], delay: 0.2)
                        suitText("\u{2666}", color: suitColors[2], delay: 0.3)
                    }

                    // Bottom: club
                    suitText("\u{2663}", color: suitColors[3], delay: 0.4)
                }

                // Title
                Text("BAB Online")
                    .themeFont(Theme.TypeScale.xxl, weight: Theme.Weight.bold, design: .rounded, relativeTo: .largeTitle)
                    .foregroundStyle(Theme.primary)
                    .opacity(showTitle ? 1 : 0)
                    .scaleEffect(showTitle || reduceMotion ? 1 : 0.8)  // Reduce Motion: fade only
            }
        }
        .onAppear {
            withAnimation(.easeOut(duration: Theme.Motion.slow)) {
                showSymbols = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                showTitle = true
            }
        }
    }

    private func suitText(_ symbol: String, color: Color, delay: Double) -> some View {
        Text(symbol)
            .themeFont(Theme.TypeScale.display, weight: Theme.Weight.bold, relativeTo: .largeTitle)
            .foregroundStyle(color)
            .opacity(showSymbols ? 1 : 0)
            .offset(y: showSymbols || reduceMotion ? 0 : 10)
            .animation(.easeOut(duration: 0.4).delay(delay), value: showSymbols)
    }
}
