import SwiftUI

/// Shared report/block affordances for chat surfaces (App Store Guideline 1.2).
extension View {
    /// Long-press context menu offering View Profile / Report / Block on chat rows from other
    /// users. Shows nothing for system messages or the current user's own messages.
    func reportBlockMenu(for message: ChatMessage, currentUsername: String, reportTarget: Binding<String?>) -> some View {
        modifier(ReportBlockMenuModifier(message: message, currentUsername: currentUsername, reportTarget: reportTarget))
    }

    /// Report-reason prompt + safety feedback alerts, and the player profile sheet the rows'
    /// "View Profile" opens (iOS 1.2.2). Attach once per chat surface.
    func safetyAlerts(reportTarget: Binding<String?>, reportContext: String) -> some View {
        modifier(SafetyAlertsModifier(reportTarget: reportTarget, reportContext: reportContext))
            .playerProfileHost()
    }
}

/// The chat rows' long-press menu. "View Profile" (iOS 1.2.2, the web's tap on a name) opens
/// the player's profile on the surface's host (`safetyAlerts`); it is left out where there is none.
struct ReportBlockMenuModifier: ViewModifier {
    let message: ChatMessage
    let currentUsername: String
    @Binding var reportTarget: String?
    @Environment(\.viewPlayerProfile) private var viewProfile

    func body(content: Content) -> some View {
        content.contextMenu {
            if message.type != .system, !message.username.isEmpty, message.username != currentUsername {
                if let viewProfile {
                    Button {
                        viewProfile(message.username)
                    } label: {
                        Label("View Profile", systemImage: "person.crop.circle")
                    }
                }
                Button {
                    reportTarget = message.username
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
}

struct SafetyAlertsModifier: ViewModifier {
    @EnvironmentObject var safetyState: SafetyState
    @ObservedObject private var profileSheets = ProfileSheets.shared
    @Binding var reportTarget: String?
    let reportContext: String
    /// This is the player profile sheet's own copy. While that sheet is up it shows the report /
    /// block feedback, and every surface under it holds its alert back: a surface that presents
    /// an alert while its sheet is up takes the sheet down.
    var insideProfile = false

    private var showsFeedback: Bool {
        safetyState.feedbackMessage != nil && (insideProfile || !profileSheets.isUp)
    }

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
                    get: { showsFeedback },
                    set: { if !$0, showsFeedback { safetyState.feedbackMessage = nil } }
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
