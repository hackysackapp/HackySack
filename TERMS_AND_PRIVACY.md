# HackySack — Terms of Service & Privacy Policy

**Effective Date:** August 11, 2026

## 1. Terms of Service & Disclaimer of Liability

- **Software Provided "AS IS"**: HackySack is provided on an "AS IS" and "AS AVAILABLE" basis, without warranty of any kind, express or implied.
- **User Responsibility**: Users assume sole responsibility for how they use HackySack during interview preparation or live sessions. The software developers and contributors are not liable for any employment decisions, interview outcomes, or institutional policy compliance.
- **Limitation of Liability**: In no event shall the authors or copyright holders be liable for any direct, indirect, incidental, or consequential damages arising out of the use or inability to use this software.

## 2. Privacy Policy

- **Local Data Storage**: All candidate resume text, job descriptions, session notes, and API keys are stored locally on your device (in local browser storage and Windows Credential Manager).
- **Zero Telemetry**: HackySack does not collect, track, or transmit your personal data, audio recordings, or interview transcripts to external analytics servers.
- **API Key Security**: When using Free BYOK mode, your API keys communicate directly with your selected AI provider (Groq or OpenRouter). Keys are encrypted locally using native Windows hardware DPAPI encryption (`keyring-rs`).
- **Cloud Pass Users**: When using the optional Managed Cloud Pass, requests are processed via encrypted Deno Edge functions hard-capped to a maximum daily query limit for abuse protection.

## 3. Contact

For security reports, legal inquiries, or questions, open an issue on the official GitHub repository at [https://github.com/hackysackapp/HackySack](https://github.com/hackysackapp/HackySack).
