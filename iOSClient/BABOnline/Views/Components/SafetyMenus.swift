import SwiftUI

/// Shared report/block affordances for chat surfaces (App Store Guideline 1.2).
extension View {
    /// Long-press context menu offering Report / Block on chat rows from other users.
    /// Shows nothing for system messages or the current user's own messages.
    func reportBlockMenu(for message: ChatMessage, currentUsername: String, reportTarget: Binding<String?>) -> some View {
        contextMenu {
            if message.type != .system, !message.username.isEmpty, message.username != currentUsername {
                Button {
                    reportTarget.wrappedValue = message.username
                } label: {
                    Label("Report User", systemImage: "exclamationmark.bubble")
                }
                Button(role: .destructive) {
                    SafetyEmitter.blockUser(username: message.username)
                } label: {
                    Label("Block User", systemImage: "hand.raised")
                }
            }
        }
    }

    /// Report-reason prompt + safety feedback alerts. Attach once per chat surface.
    func safetyAlerts(reportTarget: Binding<String?>, reportContext: String) -> some View {
        modifier(SafetyAlertsModifier(reportTarget: reportTarget, reportContext: reportContext))
    }
}

struct SafetyAlertsModifier: ViewModifier {
    @EnvironmentObject var safetyState: SafetyState
    @Binding var reportTarget: String?
    let reportContext: String

    // Copied from the binding when the alert opens so the username survives
    // the alert's dismissal ordering.
    @State private var pendingTarget = ""
    @State private var reportReason = ""
    @State private var showReportAlert = false

    func body(content: Content) -> some View {
        content
            .onChange(of: reportTarget) { _, newValue in
                if let target = newValue {
                    pendingTarget = target
                    reportReason = ""
                    showReportAlert = true
                }
            }
            .alert("Report \(pendingTarget)", isPresented: $showReportAlert) {
                TextField("Reason", text: $reportReason)
                Button("Cancel", role: .cancel) {
                    reportTarget = nil
                }
                Button("Submit Report", role: .destructive) {
                    SafetyEmitter.reportUser(
                        username: pendingTarget,
                        reason: reportReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? "No reason given"
                            : reportReason,
                        context: reportContext
                    )
                    reportTarget = nil
                }
            } message: {
                Text("Reports are reviewed and abusive accounts are removed.")
            }
            .alert(
                "Safety",
                isPresented: Binding(
                    get: { safetyState.feedbackMessage != nil },
                    set: { if !$0 { safetyState.feedbackMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) {
                    safetyState.feedbackMessage = nil
                }
            } message: {
                Text(safetyState.feedbackMessage ?? "")
            }
    }
}
