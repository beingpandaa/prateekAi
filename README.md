# prateekAi

An experimental Windows conversation assistant with a separate setup window and a compact, translucent answer window. It captures computer audio or microphone practice, assembles spoken questions, and streams answers from your selected provider.

**Status:** the voice reliability work is under validation. Offline tests exercise app behavior with synthetic transcripts and mocked services. They do not establish live transcription accuracy, answer correctness, latency on your connection, or screen-share exclusion. See the [live validation ledger](docs/LIVE-TEST-RESULTS.md).

## What it does

- Computer audio for calls, or microphone-only practice; optional microphone context.
- Automatic answers, a manual question input, and keyboard recovery for captured questions.
- Optional voice recovery phrases when a captured question needs an explicit trigger.
- English and English + Hindi speech settings.
- ChatGPT connection, OpenAI API, Anthropic API, Gemini API, and compatible endpoints, subject to the selected service's access requirements.
- Conservative local model routing: a short standalone question may use an available lighter model; complex or contextual tasks retain the selected main model.
- Role and background context, readable streaming Markdown, adjustable text size and translucency, and local diagnostics.

Focus presets guide the answer; they do not restrict the app to a fixed list of subjects. Questions can span software, algorithms, system design, Siebel CRM, security, and other professional topics.

## Try it

For a portable build, extract **the entire folder** and open `prateekAi.exe`. The executable needs its accompanying runtime files; moving only the `.exe` will not work. Close older versions first.

1. Open Setup and choose an answer provider and model. Connect your own account or enter the appropriate developer API key there.
2. Add your own Deepgram key for live speech transcription. The current live capture path uses cloud speech recognition.
3. Choose **Mic practice** for speaking questions yourself, or **Live call** for computer audio. Select the speech language and enable Auto-answer for automatic responses.
4. Save the setup, start listening, and watch the separate answer window. The **offline example** works without accounts or provider usage.
5. Stop listening when finished. Closing the answer window stops listening; hiding it does not.

API keys belong in Setup, never in source files, issue reports, screenshots, or chat messages. Live speech and answers can incur provider charges. Enabling the microphone alongside computer audio creates an additional transcription stream; voice recovery in Live call also needs the microphone. The offline example and mocked tests make no paid AI requests.

Use headphones for call testing. Computer audio capture can hear music, videos, and other applications; it is not confined to the meeting tab. Speaker playback can also leak into the microphone.

The app requests screen-capture exclusion through Windows/Electron. **There is no universal invisibility guarantee.** Check the actual view received by a second participant using the same meeting application, sharing mode, and screen configuration you intend to use.

## Controls and recovery

| Action | Control |
|---|---|
| Type a question | Pencil button in the answer window; `Ctrl+Enter` opens/submits its input |
| Request the captured question | `Ctrl+Shift+Space`; an explicit typed draft takes priority |
| Show/hide answers | `Ctrl+Shift+H` |
| Stop an answer | Stop button while generating |
| Resize answers | Bottom-right grip, or arrow keys while the grip has focus |
| Reading settings / Setup | Answer-window overflow menu |
| Inspect processing decisions | Setup → Session → Local diagnostics |

If needed, enable **voice fallback** in Setup and use a configured phrase such as “Give me a minute to think.” The phrase asks the app to submit the retained question; it is not itself the question. The feature is off by default. Read the [voice test matrix](docs/VOICE-TEST-MATRIX.md) for source restrictions, incomplete-audio behavior, and the required validation cases.

Diagnostics include recognized question text and processing decisions. They exclude credentials and raw audio, but may still contain sensitive conversation content. Review exports before sharing them.

## Run from source

Requirements: Windows x64, Node.js **24**, and pnpm **11.19.0**. These are development requirements; the portable app bundles its runtime.

```powershell
git clone https://github.com/beingpandaa/prateekAi.git
cd prateekAi
pnpm install --frozen-lockfile
pnpm start
```

`master` is the baseline branch. The current reliability work is on `voice-reliability`; use that branch when reviewing its changes.

```powershell
git switch voice-reliability
pnpm install --frozen-lockfile
pnpm test
pnpm test:ui
pnpm test:content
pnpm test:flow
pnpm test:profile-compat
pnpm package:portable
```

Builds go to a fresh output directory. See [PACKAGING.md](PACKAGING.md) for portable packaging, executable branding, and isolated smoke tests. A failed test is not resolved by pointing it at your real AppData profile.

## Settings and data

Existing installations keep `%APPDATA%\Callside` when it contains their saved settings; new installations use `%APPDATA%\prateekAi`. If both have settings, the new profile takes precedence. Explicit `PRATEEKAI_DATA_DIR` and legacy `CALLSIDE_DATA_DIR` overrides are supported. Credentials are encrypted for the current Windows user, and unreadable profiles are protected against overwriting. Do not copy a profile to another person or include one in a release.

The app runs on your computer; live transcription and model requests go to the providers you configure. Role/background context and conversation text can accompany answer requests. There is no bundled account, API credit, or fully local transcription engine in this version.

- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Voice scripts, ground truth, and acceptance gates](docs/VOICE-TEST-MATRIX.md)
- [Live test results and outstanding validation](docs/LIVE-TEST-RESULTS.md)
- [Contributing](CONTRIBUTING.md)
