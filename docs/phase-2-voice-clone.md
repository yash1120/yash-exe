# Phase 2 — Upgrade to ElevenLabs voice clone + Twilio phone number

The MVP uses **browser-native voice** (Web Speech API + SpeechSynthesis) — zero cost, zero setup, works in Chrome and Edge. This is fine for the web demo. To take it to the level where a recruiter can call a real phone number and hear *your actual voice*, you need two upgrades.

---

## 1. Replace browser TTS with ElevenLabs voice clone

### a. Clone your voice (one-time, ~5 min)
1. Sign up at https://elevenlabs.io (free tier exists; Starter $5/mo is plenty).
2. Go to **Voices → Add Voice → Instant Voice Cloning**.
3. Record or upload 1–3 minutes of clean audio of yourself talking normally. Save the resulting `voice_id`.

### b. Add a TTS endpoint to the backend
Install: `pip install elevenlabs httpx`

Create `backend/tts.py`:
```python
import os
import httpx

ELEVEN_API = "https://api.elevenlabs.io/v1/text-to-speech"
VOICE_ID = os.environ["ELEVENLABS_VOICE_ID"]
API_KEY = os.environ["ELEVENLABS_API_KEY"]

async def synthesize(text: str) -> bytes:
    url = f"{ELEVEN_API}/{VOICE_ID}/stream"
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            url,
            headers={"xi-api-key": API_KEY, "Content-Type": "application/json"},
            json={
                "text": text,
                "model_id": "eleven_turbo_v2_5",  # fastest, ~300ms first byte
                "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
            },
        )
        r.raise_for_status()
        return r.content
```

Wire it into `backend/main.py`:
```python
from fastapi.responses import Response
from .tts import synthesize

@app.post("/api/tts")
async def tts_endpoint(req: dict):
    audio = await synthesize(req["text"])
    return Response(content=audio, media_type="audio/mpeg")
```

### c. Swap the frontend
In `frontend/app.js`, replace the `speak()` function:
```javascript
async function speak(text) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({text}),
  });
  const blob = await res.blob();
  new Audio(URL.createObjectURL(blob)).play();
}
```

For real streaming TTS (audio plays as it's generated, ~300ms latency instead of waiting for the whole reply), use the WebSocket streaming endpoint — see ElevenLabs WS docs.

---

## 2. Add a phone number (Twilio)

### a. Get a number
1. Sign up at twilio.com. Numbers are ~$1/mo for an AU number.
2. Buy a number with **Voice** capability.

### b. Add the Twilio voice webhook
Install: `pip install twilio`

Create `backend/phone.py`:
```python
from fastapi import APIRouter, Form
from fastapi.responses import Response
from twilio.twiml.voice_response import VoiceResponse, Gather

from .agent import chat

router = APIRouter(prefix="/phone")
_history_by_call = {}  # in-memory per-call; use Redis in prod

@router.post("/incoming")
async def incoming(CallSid: str = Form(...)):
    _history_by_call[CallSid] = []
    resp = VoiceResponse()
    g = Gather(input="speech", action=f"/phone/turn?call_sid={CallSid}", timeout=3, speechTimeout="auto")
    g.say("Hey, I'm Yash dot E X E. Ask me anything.", voice="Polly.Matthew-Neural")
    resp.append(g)
    return Response(str(resp), media_type="application/xml")

@router.post("/turn")
async def turn(call_sid: str, SpeechResult: str = Form(""), CallSid: str = Form(...)):
    history = _history_by_call.get(CallSid, [])
    reply = await chat(history, SpeechResult)
    history.extend([
        {"role": "user", "content": SpeechResult},
        {"role": "assistant", "content": reply},
    ])
    _history_by_call[CallSid] = history

    resp = VoiceResponse()
    resp.say(reply, voice="Polly.Matthew-Neural")
    g = Gather(input="speech", action=f"/phone/turn?call_sid={CallSid}", timeout=3, speechTimeout="auto")
    resp.append(g)
    return Response(str(resp), media_type="application/xml")
```

For the **voice-cloned** version, instead of Twilio's built-in `<Say>`, use `<Play>` with a URL pointing to your `/api/tts` endpoint (write the audio to a public CDN like S3, or stream it through Twilio Media Streams for true low-latency).

In `backend/main.py`:
```python
from .phone import router as phone_router
app.include_router(phone_router, prefix="/api")
```

### c. Point Twilio at your URL
1. Deploy (see below).
2. In the Twilio console, set the number's **Voice & Fax → A Call Comes In** webhook to:
   `https://your-domain.com/api/phone/incoming` (HTTP POST)

---

## 3. Deployment options

| Platform | Free tier? | Best for |
|---|---|---|
| **Fly.io** | $5/mo small VM | Recommended — global edge, simple Dockerfile deploy |
| **Render** | Free tier sleeps | OK for low traffic |
| **Railway** | $5/mo | Easiest GitHub deploy |
| **AWS App Runner** | No free | If you want to show AWS on your CV |

Minimal `Dockerfile`:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

After deploying:
- Add the URL to your LinkedIn headline: *"Don't read my CV — talk to it: yash-exe.fly.dev"*
- Add the phone number to your email signature.
- Post a 30-second video of yourself calling it on LinkedIn. Tag the companies you're targeting.

---

## 4. What to add next (Phase 3 ideas)

- **Tool use**: let the agent fetch live data (GitHub stars, latest commits) using Claude's tool_use API.
- **Memory between calls**: persist conversations to Postgres so the agent remembers a recruiter who called twice.
- **Analytics dashboard**: log every call (transcript, duration, recruiter company if known). Recruiters love seeing that you measure your own funnel.
- **Multi-language**: detect inbound language; reply in the same one. Big in Sydney where many recruiters are bilingual.
