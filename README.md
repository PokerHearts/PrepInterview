# AI Interview Prep Tool 🎙️

A **free, open-source AI mock interview tool** — practice for job interviews with any AI provider, right in your browser.

> **No backend. No signups. No data collection.**  
> All processing happens client-side. Bring your own API key (BYOK).

## ✨ Features

- **Multi-Provider AI** — Choose from Gemini, OpenAI, Groq, or OpenRouter (100+ models)
- **Free Options** — Gemini Flash, Groq (Llama/Mixtral), and OpenRouter offer free tiers
- **Voice Interaction** — Real-time speech recognition + text-to-speech with barge-in support
- **Resume Parsing** — Upload your PDF resume for personalized questions
- **Smart Scorecard** — Get detailed feedback: score, strengths, weaknesses, Q-by-Q analysis
- **Past Scorecard Focus** — Upload a previous scorecard to target weak areas
- **Typing Mode** — Prefer typing? Switch seamlessly between voice and keyboard
- **Privacy First** — Everything runs in your browser. API key stored in session only.

## 🚀 Quick Start

1. **Open** `index.html` in your browser (or host via GitHub Pages)
2. **Select** an AI provider and model
3. **Enter** your API key ([get free Gemini key](https://aistudio.google.com/app/apikey) or [free Groq key](https://console.groq.com/keys))
4. **Upload** your resume (PDF) and paste the job description
5. **Start** the mock interview and practice!

## 🤖 Supported AI Providers

| Provider | Models | Free Tier | Get Key |
|----------|--------|-----------|---------|
| **Google Gemini** | Flash, Flash Lite, Pro | ✅ Yes | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **Groq** | Llama 3.3 70B, Gemma 2, Mixtral | ✅ Yes | [console.groq.com](https://console.groq.com/keys) |
| **OpenRouter** | 100+ models (many free) | ✅ Yes | [openrouter.ai](https://openrouter.ai/keys) |
| **OpenAI** | GPT-4o, GPT-4o Mini | ❌ Paid | [platform.openai.com](https://platform.openai.com/api-keys) |

## 🛠️ Tech Stack

- **Vanilla HTML/CSS/JS** — No frameworks, no build step
- **Multi-Provider AI** — Gemini, OpenAI, Groq, OpenRouter APIs
- **[PDF.js](https://mozilla.github.io/pdf.js/)** — Client-side resume parsing
- **Web Speech API** — Speech recognition & synthesis
- **Web Audio API** — Voice Activity Detection (VAD)
- **[Marked.js](https://marked.js.org/)** — Markdown rendering

## 🎙️ Voice Engine

The voice engine uses a Finite State Machine with 6 states:

```
LISTENING → USER_SPEAKING → PROCESSING → AI_SPEAKING → COOLDOWN → LISTENING
```

Key features:
- **Adaptive VAD** — Auto-calibrates to ambient noise levels
- **Echo prevention** — ASR is gated to prevent TTS feedback loops
- **Barge-in** — Interrupt the AI with elevated voice threshold detection
- **TTS Chunking** — Splits long AI responses to prevent Chrome's 15-second bug
- **Cooldown buffer** — 350ms echo fade after TTS before reopening mic

## 📁 Project Structure

```
HR/
├── index.html        — Main page (3-view SPA)
├── style.css         — Premium dark theme with glassmorphism
├── app.js            — Core logic & UI management
├── providers.js      — Multi-provider AI abstraction layer
├── voice-engine.js   — FSM-based voice engine (VAD, ASR, TTS)
├── pdf-helper.js     — PDF text extraction
└── README.md         — This file
```

## 🔒 Privacy & Security

- **No backend** — All API calls go directly from your browser to the AI provider
- **No data storage** — Nothing is saved to any server
- **Session-only keys** — Your API key is stored in `localStorage` only
- **Open source** — Audit the code yourself

## 📄 License

MIT
