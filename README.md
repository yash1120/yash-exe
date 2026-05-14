# Yash.exe

> **Don't read my CV — talk to it.**
>
> An interactive AI clone of [Yash Goyal](https://linkedin.com/in/yashgoyal11) — Machine Learning Engineer based in Sydney. Built as a portfolio piece to demonstrate agentic AI, streaming inference, and production deployment in a single shippable artifact a recruiter can use in 30 seconds.

[![Status](https://img.shields.io/badge/status-live-22c55e?style=flat-square)](https://yash-exe.onrender.com)
[![Python](https://img.shields.io/badge/python-3.11%2B-3776ab?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![Model](https://img.shields.io/badge/llama_3.3_70B-via_Groq-f55036?style=flat-square)](https://groq.com/)
[![Framework](https://img.shields.io/badge/agent-LangGraph-1c3c3c?style=flat-square)](https://langchain-ai.github.io/langgraph/)
[![License](https://img.shields.io/badge/license-MIT-000?style=flat-square)](LICENSE)
[![Cost](https://img.shields.io/badge/cost_to_run-%240-22c55e?style=flat-square)](#-built-to-run-for-free)

---

## What it is

A single-page web app where visitors can ask a Llama-3.3-70B agent — grounded in my CV, projects, and research papers — anything about me. They can type, or tap the mic and have a back-and-forth conversation. Replies stream token-by-token; speech is synthesized sentence-by-sentence in parallel, so the first audio plays ~1 second after the user finishes speaking.

I built it because every ML engineer's portfolio has the same three projects. This one is a **demonstrable system**, not a screenshot — a recruiter can interact with it in 30 seconds and immediately understand what I can build.

## Why this is interesting

| Technique | Where to look |
|---|---|
| **Streaming agent via LangGraph** — single-node graph today, trivially extensible to tool-using nodes | [`backend/agent.py`](backend/agent.py) |
| **Sentence-chunked TTS pipeline** — fires parallel TTS requests as the LLM streams; audio queue plays strictly in order | [`frontend/app.js`](frontend/app.js) |
| **Server-Sent Events streaming** for both LLM tokens and audio synthesis triggering | [`backend/main.py`](backend/main.py) |
| **Neural TTS without paid services** — uses `edge-tts` to tap Microsoft Edge's neural voices for free | [`backend/tts.py`](backend/tts.py) |
| **Hallucination eval gate** — 7 fact-check cases verify the agent doesn't invent a PhD, deflects salary questions, etc. | [`evals/test_facts.py`](evals/test_facts.py) |
| **Profile-as-prompt instead of vector RAG** — engineering judgment: a 3k-token CV fits in the system prompt, so RAG would be over-engineering | [`backend/prompts.py`](backend/prompts.py) |

## Architecture

```
┌──────────────────────┐    POST /api/chat/stream     ┌─────────────────────────┐
│  Browser             │ ───────────────────────────▶ │  FastAPI                │
│                      │                               │  ├─ /api/chat/stream    │
│  Web Speech API      │ ◀── SSE: text chunks ─────── │  ├─ /api/tts            │
│  (microphone)        │                               │  └─ static frontend     │
│                      │    POST /api/tts (per         │                         │
│  Sentence-chunked    │       sentence, parallel)     │  LangGraph agent        │
│  audio queue         │ ───────────────────────────▶ │  (single "agent" node,  │
│  (HTML5 Audio)       │                               │   ready for tools)      │
│                      │ ◀── MP3 blob ─────────────── │                         │
└──────────────────────┘                               │  Groq API               │
                                                       │   ↳ llama-3.3-70b       │
                                                       │                         │
                                                       │  edge-tts (WebSocket)   │
                                                       │   ↳ neural voices       │
                                                       └─────────────────────────┘
                                                                  │
                                                                  ▼
                                                     data/yash_profile.md
                                                     (single source of truth)
```

## 💸 Built to run for free

| Layer | Service | Free tier |
|---|---|---|
| LLM | [Groq](https://console.groq.com/) — Llama 3.3 70B | 30 req/min, no credit card |
| TTS | [edge-tts](https://github.com/rany2/edge-tts) — Microsoft neural voices | unlimited, no key |
| STT | Browser Web Speech API | free, native |
| Hosting | [Render](https://render.com/) (default) / Fly.io / HuggingFace Spaces | free tier, no card |

End-to-end cost to run this in production: **$0/mo**.

## Quick start

```bash
git clone https://github.com/yash1120/yash-exe.git
cd yash-exe
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env                # Windows: Copy-Item .env.example .env
# Edit .env and paste your free key from https://console.groq.com/keys
uvicorn backend.main:app --reload --port 8000
```

Open <http://localhost:8000>. Click a suggestion chip, or tap the mic.

> **Best in Chrome / Edge / Brave** for the microphone. Text chat works everywhere.

## Run the eval gate

```bash
python -m evals.test_facts
```

This runs 7 fact-check cases against the live agent and verifies:
- It correctly cites AirLabOne, SAS Viya, NVIDIA Omniverse
- It **deflects** salary questions instead of inventing a number
- It **doesn't hallucinate** a PhD (I only have a Master's)
- It grounds answers in the profile, not in pretraining

Wire it into CI to gate every deploy.

## 🛠 Make it about *you*

This repo is designed to be forked. To clone it for yourself, you need to change exactly **two** files plus a handful of links:

### 1. Replace the profile
Edit [`data/yash_profile.md`](data/yash_profile.md) with your own bio, experience, projects, publications, and the "what I won't answer" rules. The system prompt loads this verbatim.

### 2. Update the persona name
Edit [`backend/prompts.py`](backend/prompts.py) — change `Yash.exe` and `Yash Goyal` to your name. Two replacements.

### 3. Swap the contact links
In [`frontend/index.html`](frontend/index.html) — update the four `<a>` tags in `<nav class="contact-bar">` (Email, LinkedIn, GitHub, Resume).

### 4. Drop in your CV
Put your `resume.pdf` in `frontend/resume.pdf` (it's served as a static file at `/resume.pdf`).

### 5. Update the title and meta tags
In [`frontend/index.html`](frontend/index.html) — `<title>`, `<meta name="description">`, and OpenGraph tags.

### 6. (Optional) Pick a different voice
In `.env`: `YASH_EXE_VOICE=en-US-AndrewNeural` (or any from `edge_tts.list_voices()`).

### 7. (Optional) Update the eval cases
[`evals/test_facts.py`](evals/test_facts.py) — replace my facts with yours, so the hallucination gate is meaningful for *your* profile.

That's it. The architecture, agent, TTS pipeline, eval harness, and deploy config are all reusable as-is.

## Deploy (free, ~5 minutes)

The repo includes a `render.yaml` blueprint for **Render** (free tier, auto-HTTPS, `*.onrender.com` URL).

```bash
git push origin main
```

Then:
1. <https://dashboard.render.com/> → **New** → **Blueprint** → connect repo → **Apply**
2. Service → **Environment** → paste your `GROQ_API_KEY` → **Save**
3. **Manual Deploy** → **Deploy latest commit**
4. Live in ~3 min at `https://<your-service>.onrender.com`

Full guide with alternatives (HF Spaces never-sleeps, Fly.io, Cloud Run): [docs/deploy.md](docs/deploy.md).

## Project layout

```
yash-exe/
├── backend/
│   ├── main.py            # FastAPI: /api/chat, /api/chat/stream, /api/tts, static
│   ├── agent.py           # LangGraph agent + Groq streaming
│   ├── tts.py             # edge-tts wrapper (markdown stripping + voice config)
│   └── prompts.py         # Persona + system prompt construction
├── frontend/
│   ├── index.html         # Single-page UI (contact bar, chat, composer)
│   ├── app.js             # SSE streaming + sentence-chunked TTS queue
│   ├── style.css          # Monochrome theme, Inter + JetBrains Mono
│   └── resume.pdf         # Served at /resume.pdf
├── data/
│   └── yash_profile.md    # Source of truth — edit to change what the AI knows
├── evals/
│   └── test_facts.py      # Fact-check / hallucination eval gate (7 cases)
├── docs/
│   ├── deploy.md          # Render / HF Spaces / Fly.io guide
│   └── phase-2-voice-clone.md  # ElevenLabs voice clone + Twilio phone number
├── render.yaml            # Render blueprint (free tier)
├── Dockerfile             # For Fly.io / HF Spaces / Cloud Run
├── requirements.txt
└── .env.example
```

## Roadmap

- [x] Phase 1 — Web UI with neural TTS + browser STT, hosted on Render free tier
- [ ] Phase 1.5 — Vector RAG over GitHub READMEs + publications full-text (ChromaDB)
- [ ] Phase 2 — ElevenLabs voice clone (so the reply sounds like *me* specifically)
- [ ] Phase 2 — Twilio phone number (recruiters can literally call)
- [ ] Phase 3 — Tool use: live GitHub activity fetch, Cal.com meeting scheduler
- [ ] Phase 3 — Per-caller memory (Postgres) so repeat callers are recognised
- [ ] Phase 3 — Analytics dashboard: call/chat transcripts, source attribution

See [`docs/phase-2-voice-clone.md`](docs/phase-2-voice-clone.md) for the voice-clone & phone implementation guide.

## FAQ

**Why not just use ChatGPT with my CV pasted in?**
You could. The point of this repo isn't the answer quality — it's that *I built and shipped the system*. A recruiter who tries it understands within 30 seconds that I can stand up an agent, a streaming inference pipeline, neural TTS, and a deploy in production. That's a higher signal than another "I built a RAG chatbot" README.

**Why Llama 3.3 70B instead of GPT-4 or Claude?**
Two reasons: (1) free tier on Groq means anyone can fork-and-run with no credit card friction; (2) Groq's inference is genuinely faster than the closed-model APIs for this scale of prompt, which makes the voice UX feel real-time. Swapping to Claude or GPT-4 is a 20-line diff if you'd rather.

**Why no vector database?**
A single-page CV is ~3k tokens, which fits comfortably in the system prompt of every turn. Adding ChromaDB to retrieve from a single document would be over-engineering. RAG becomes the right move once you add blog posts, full GitHub READMEs, or transcribed talks.

**Is this actually agentic?**
Today the LangGraph has one node — so technically just a chat loop. The graph is in place so that adding tool-using nodes (search GitHub, fetch publications, schedule a meeting) is a one-line change. Roadmap Phase 3.

## Built with

- [Llama 3.3 70B Versatile](https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct) served on [Groq](https://groq.com/)
- [LangGraph](https://langchain-ai.github.io/langgraph/) for the agent loop
- [FastAPI](https://fastapi.tiangolo.com/) + Server-Sent Events streaming
- [edge-tts](https://github.com/rany2/edge-tts) — free server-side neural TTS via Microsoft Edge voices
- [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) — browser-native microphone
- [Inter](https://rsms.me/inter/) + [JetBrains Mono](https://www.jetbrains.com/lp/mono/) typography

## License

[MIT](LICENSE) — fork it, ship your own, no attribution required (though a star is appreciated 🌟).

## Acknowledgements

Built by [Yash Goyal](https://linkedin.com/in/yashgoyal11) in Sydney, 2026. If you fork this and land a job, [send me a note](mailto:yashgoyal1120@gmail.com) — I love hearing it worked.
