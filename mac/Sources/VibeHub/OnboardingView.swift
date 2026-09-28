import AppKit
import SwiftUI

/// Connecting this Mac: one button (browser pairing, no typing), live "Waiting…"
/// feedback, and everything else — the pasted-token fallback, reopening the page —
/// behind a quiet "Trouble?" disclosure (ADHD rules, `vibehub-qa-fix.md`). Controls only,
/// no heading: each host (the first-run window, the popover, Settings) says it once.
///
/// The pairing itself runs on `TrackerManager` (`startBrowserPairing`), not here: opening
/// the approval page brings the browser forward, which closes a menu-bar window and this
/// view with it. A view-owned poll died there and the approval landed on nobody. This
/// view only renders that state and can come and go while the pairing carries on.
struct OnboardingView: View {
    @ObservedObject var store: StatusStore
    @ObservedObject var settings: AppSettings
    @ObservedObject var tracker: TrackerManager
    /// `.center` in the first-run window, `.leading` in the popover.
    var alignment: HorizontalAlignment = .leading
    /// The first-run window's button is the whole screen's one action — make it big.
    var large = false
    var onSaved: ((_ viaKeyboard: Bool) -> Void)? = nil

    @State private var token = ""
    @State private var isVerifying = false
    @State private var errorMessage: String?
    @State private var showTrouble = false

    var body: some View {
        VStack(alignment: alignment, spacing: 10) {
            if let pairing = tracker.pairing {
                pairingStatus(pairing)
            } else {
                Button("Connect") { tracker.startBrowserPairing() }
                    .buttonStyle(PrimaryButtonStyle(large: large))
                    .keyboardShortcut(.defaultAction)
            }

            if let message = errorMessage ?? tracker.pairingError {
                Label(message, systemImage: "exclamationmark.circle")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            trouble
        }
        // The pairing ended while this view was on screen: connected (no error, a token
        // now saved) means the host moves on. A cancel or a failure changes nothing here.
        .onChange(of: tracker.pairing) { pairing in
            guard pairing == nil, tracker.pairingError == nil, store.token != nil else { return }
            onSaved?(false)
        }
    }

    private func pairingStatus(_ pairing: TrackerManager.PairingState) -> some View {
        VStack(alignment: alignment, spacing: 6) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(pairing.phase == .connecting ? "Connecting\u{2026}" : "Waiting for your browser\u{2026}")
                    .font(.system(size: 12, weight: .medium))
            }
            if let code = pairing.code {
                // The code to match on the browser page — the one detail worth reading.
                Text(code)
                    .font(.system(size: 15, weight: .semibold, design: .monospaced))
                    .tracking(1.5)
                    .textSelection(.enabled)
            }
            Button("Cancel") { tracker.cancelPairing() }
                .buttonStyle(.link)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .disabled(pairing.phase == .connecting)
        }
    }

    /// Everything that isn't the main path. Closed by default; one click opens it.
    @ViewBuilder
    private var trouble: some View {
        if showTrouble {
            VStack(alignment: alignment, spacing: 8) {
                if let verificationURL = tracker.pairing?.verificationURL {
                    Button("Open the page again") { NSWorkspace.shared.open(verificationURL) }
                        .buttonStyle(.link)
                        .font(.system(size: 11))
                }
                Text("Or paste a code from the site:")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    SecureField("vh_\u{2026}", text: $token)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 11, design: .monospaced))
                        .onSubmit { verify(viaKeyboard: true) }
                    Button(isVerifying ? "Checking\u{2026}" : "Connect") { verify(viaKeyboard: false) }
                        .buttonStyle(.bordered)
                        .disabled(isVerifying || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .frame(maxWidth: 280)
            }
        } else {
            Button("Trouble?") { showTrouble = true }
                .buttonStyle(.link)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
    }

    private func verify(viaKeyboard: Bool) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isVerifying = true
        errorMessage = nil
        Task {
            let result = await tracker.connect(token: trimmed)
            isVerifying = false
            switch result {
            case .success:
                token = ""
                tracker.cancelPairing()
                store.wake()
                onSaved?(viaKeyboard)
            case .failure(let error):
                errorMessage = error.errorDescription
            }
        }
    }
}
