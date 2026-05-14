"""FastAPI entrypoint for Yash.exe.

Serves:
- POST /api/chat            — one-shot JSON chat
- POST /api/chat/stream     — Server-Sent Events streaming chat (used by the web UI)
- GET  /api/health          — health check
- GET  /                    — static frontend (the chat + mic UI)

Run locally:
    uvicorn backend.main:app --reload --port 8000

Env required:
    ANTHROPIC_API_KEY
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

from .agent import chat, stream  # noqa: E402 — load env before importing agent
from .tts import synthesize  # noqa: E402

app = FastAPI(title="Yash.exe", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    history: list[Message] = Field(default_factory=list)


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    voice: str | None = None


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/tts")
async def tts_endpoint(req: TTSRequest) -> Response:
    audio = await synthesize(req.text, req.voice)
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest) -> dict:
    history = [m.model_dump() for m in req.history]
    reply = await chat(history, req.message)
    return {"reply": reply}


@app.post("/api/chat/stream")
async def chat_stream_endpoint(req: ChatRequest) -> StreamingResponse:
    history = [m.model_dump() for m in req.history]

    async def event_source():
        async for chunk in stream(history, req.message):
            chunk = chunk.replace("\n", "\\n")
            yield f"data: {chunk}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_source(), media_type="text/event-stream")


_frontend = Path(__file__).parent.parent / "frontend"
if _frontend.exists():
    app.mount("/", StaticFiles(directory=str(_frontend), html=True), name="frontend")
