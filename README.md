<h1 align="center">
  <img src="src/assets/logo.webp" width="48" height="48" style="vertical-align: middle; margin-right: 8px;" alt="HackySack Logo">
  HackySack
</h1>

<p align="center">
  <strong>A stealth desktop interview assistant built with Tauri v2, Rust, and React.</strong><br>
  🌐 <strong>Website:</strong> <a href="https://hackysackapp.github.io/HackySack/">https://hackysackapp.github.io/HackySack/</a>
</p>

---

HackySack is a stealth desktop overlay designed for technical, behavioral, and coding interviews. It runs transparently on top of active windows, captures dual-channel system and microphone audio, transcribes questions in real time using our custom dual-speech transcript engine, and provides instant talking points and working code snippets.

## Key Features & Competitive Advantages

- **🛡️ 100% Stealth Screen Protection**: Uses native Windows API (`SetWindowDisplayAffinity`) to remain completely invisible during full-screen desktop shares on Zoom, Microsoft Teams, Google Meet, Slack, and Discord.
- **🎛️ Independent Mic & Speaker Device Control**: Choose your exact input microphone and output playback device (headset, external monitor, or virtual cable) in Settings. Never miss audio due to Windows default device switches.
- **🎙️ Dual-Channel Speech Transcript Engine**: High-performance Rust audio processing (WASAPI/CPAL) capturing system loopback (interviewer) and microphone (candidate) simultaneously with real-time speaker separation (`Them:` vs `You:`), VAD filtering, and speech transcription.
- **👻 Click-Through Ghost Mode (`Ctrl+Alt+C`)**: Toggle mouse input pass-through to click directly through the assistant window into your IDE, browser, or terminal without moving or minimizing the overlay.
- **🧠 Multi-Document Context Synthesis**: Upload or paste your Resume (PDF/DOCX/TXT), Job Description, and Company Notes. The AI directly weaves your authentic career experiences and metrics into every response.
- **📸 1-Click Screen Capture OCR (`F10`)**: Instantly grab LeetCode problems, system architecture diagrams, or presentation slides directly off your screen for instant AI analysis.
- **⚡ Teleprompter Live Response Format**: Formatted for 0.5-second glanceability during live calls with a 3-Second Quick Pitch (Direct Answer, Key Metric/Term, Trade-off), keyword pills, and a 60-Second Speaking Script generated in under 1.5s.
- **🎯 3 Tailored Interview Presets**: Instant switching between **General / Technical**, **Behavioral STAR Method**, and **Coding & System Design** (includes copy-pasteable SQL/Code blocks with Big-O time/space complexity analysis).
- **🔒 Dual Cloud & 100% Free BYOK Architecture**: Use HackySack Cloud passes or bring your own free Groq, OpenAI, Anthropic, Gemini, or OpenRouter API keys with AES local encryption in Windows Credential Manager (`keyring-rs`).
- **⚡ Ultra-Lightweight Rust & Tauri Performance**: Uses less than 60MB RAM with instant startup—no heavy Electron lag during intensive video calls.

## Keyboard Shortcuts

| Shortcut | Action | Description |
| --- | --- | --- |
| `Ctrl+Shift+H` | Show / Focus | Global shortcut to bring HackySack to the front |
| `F8` | Clear Context | Instantly clears context buffer items and transcript log |
| `F9` | Record / Stop | Starts or stops live audio recording and transcription |
| `F10` | Screenshot | Captures active screen for visual AI context |
| `F12` / `F11` | Ask AI | Triggers AI response for the current question and history |
| `Ctrl+Alt+C` | Click-Through | Toggles mouse input pass-through to background windows |

## Pricing & Cloud Access

- **Free BYOK ($0.00)**: Bring your own free Groq or OpenRouter key (`gsk_...`). Keys are stored with hardware-backed local encryption.
- **7-Day Sprint Pass ($19.99 / week)**: Managed zero-setup access for active interview weeks.
- **Pro Monthly Pass ($29.99 / month)**: Managed zero-setup monthly access powered by high-speed OpenRouter models.

## Installation

Download the latest setup executable (`HackySack_1.0.0_x64-setup.exe`) from the [Releases](https://github.com/hackysackapp/HackySack/releases) page or visit [hackysackapp.github.io/HackySack](https://hackysackapp.github.io/HackySack/).

> ℹ️ **Note on Windows SmartScreen:**  
> First time launching? Click **More info** → **Run anyway** to start HackySack.

### Building from source

Requirements: Rust 1.75+, Node.js 18+, C++ Build Tools.

```bash
git clone https://github.com/hackysackapp/HackySack.git
cd HackySack

npm install
npm run tauri dev
```

To build a standalone Windows installer executable:

```bash
npm run tauri build
```

The setup executable will be generated at `src-tauri/target/release/bundle/nsis/HackySack_1.0.0_x64-setup.exe`.

---

## ☕ Support the Project

If HackySack helped you land your job or ace an interview, consider supporting ongoing development:

👉 [**☕ Buy me a coffee or a loaf of bread on Ko-fi**](https://ko-fi.com/hackysackapp)

---

## License

MIT
