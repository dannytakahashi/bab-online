import SwiftUI

/// Branded splash screen shown on app launch.
struct SplashView: View {
    @State private var showSymbols = false
    @State private var showTitle = false

    private let suitColors: [Color] = [
        .white,                              // spade
        Color(red: 0.9, green: 0.3, blue: 0.3), // heart
        Color(red: 0.9, green: 0.3, blue: 0.3), // diamond
        .white,                              // club
    ]

    var body: some View {
        ZStack {
            Color.Theme.background
                .ignoresSafeArea()

            VStack(spacing: 32) {
                // Card suits in a diamond layout
                VStack(spacing: 8) {
                    // Top: spade
                    suitText("\u{2660}", color: suitColors[0], delay: 0.1)

                    // Middle row: heart + diamond
                    HStack(spacing: 40) {
                        suitText("\u{2665}", color: suitColors[1], delay: 0.2)
                        suitText("\u{2666}", color: suitColors[2], delay: 0.3)
                    }

                    // Bottom: club
                    suitText("\u{2663}", color: suitColors[3], delay: 0.4)
                }

                // Title
                Text("BAB Online")
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.Theme.primary)
                    .opacity(showTitle ? 1 : 0)
                    .scaleEffect(showTitle ? 1 : 0.8)
            }
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) {
                showSymbols = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                showTitle = true
            }
        }
    }

    private func suitText(_ symbol: String, color: Color, delay: Double) -> some View {
        Text(symbol)
            .font(.system(size: 44, weight: .bold))
            .foregroundStyle(color)
            .opacity(showSymbols ? 1 : 0)
            .offset(y: showSymbols ? 0 : 10)
            .animation(.easeOut(duration: 0.4).delay(delay), value: showSymbols)
    }
}
