"""Text-to-speech via Microsoft Edge's neural voices.

Why edge-tts?
- 100% free, no API key, no signup, no rate limits in practice.
- Neural voices that sound genuinely human.
- Works server-side, so the same audio is consistent across browsers/devices.

Default voice is en-AU-WilliamNeural (Sydney accent) since Yash is based in Sydney.
Override via the YASH_EXE_VOICE env var.
"""

from __future__ import annotations

import io
import os
import re
from typing import AsyncIterator

import edge_tts

VOICE = os.environ.get("YASH_EXE_VOICE", "en-AU-WilliamNeural")
RATE = os.environ.get("YASH_EXE_VOICE_RATE", "+5%")

# Emoji & pictograph ranges — TTS reads these literally ("Australian flag") which sounds awful.
_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F5FF"   # symbols & pictographs
    "\U0001F600-\U0001F64F"   # emoticons
    "\U0001F680-\U0001F6FF"   # transport
    "\U0001F700-\U0001F7FF"
    "\U0001F780-\U0001F7FF"
    "\U0001F800-\U0001F8FF"
    "\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FA6F"
    "\U0001FA70-\U0001FAFF"
    "\U0001F1E6-\U0001F1FF"   # regional indicator / flags
    "☀-⛿"           # misc symbols
    "✀-➿"           # dingbats
    "]+",
    flags=re.UNICODE,
)

# Pronunciation rewrites — only the things edge-tts gets wrong out of the box.
# Acronyms like "ML", "AWS", "GPU" are already spoken letter-by-letter correctly,
# so we don't touch those. Keep this list minimal — over-substituting causes weirdness.
_PRONUNCIATION_FIXES = [
    (re.compile(r"\bYash\.exe\b", re.IGNORECASE), "Yash dot E-X-E"),
    (re.compile(r"\biIL13Pred\b"), "I-L thirteen Pred"),
]


def _clean_for_speech(text: str) -> str:
    # Strip markdown formatting (so TTS doesn't read "asterisk" / "underscore" aloud)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"_(.+?)_", r"\1", text)
    text = re.sub(r"`(.+?)`", r"\1", text)
    text = re.sub(r"\[(.+?)\]\(.+?\)", r"\1", text)
    text = re.sub(r"^\s*[-*]\s+", "", text, flags=re.MULTILINE)

    # URLs sound terrible read aloud — drop them entirely
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"www\.\S+", "", text)

    # Email addresses — read as "email" not "yashgoyal1120 at gmail dot com"
    text = re.sub(r"\b[\w.+-]+@[\w.-]+\.\w+\b", "my email", text)

    # Emoji & flags
    text = _EMOJI_RE.sub("", text)

    # Arrow / decoration glyphs that voice TTS reads literally
    text = text.replace("→", " then ")
    text = text.replace("←", " from ")
    text = text.replace("•", ", ")
    text = re.sub(r"[↑↓⏹⏵⏸▍·…]", " ", text)

    # Pronunciation fixes
    for pattern, replacement in _PRONUNCIATION_FIXES:
        text = pattern.sub(replacement, text)

    # Collapse whitespace
    text = re.sub(r"\s+", " ", text)

    return text.strip()


async def synthesize(text: str, voice: str | None = None) -> bytes:
    """Synthesize the full reply as a single MP3 blob."""
    clean = _clean_for_speech(text)
    if not clean:
        return b""
    communicate = edge_tts.Communicate(clean, voice or VOICE, rate=RATE)
    buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    return buf.getvalue()


async def synthesize_stream(text: str, voice: str | None = None) -> AsyncIterator[bytes]:
    """Streaming MP3 chunks (kept for future MediaSource use)."""
    clean = _clean_for_speech(text)
    if not clean:
        return
    communicate = edge_tts.Communicate(clean, voice or VOICE, rate=RATE)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]
