"""Text-to-speech via Microsoft Edge's neural voices.

Why edge-tts?
- 100% free, no API key, no signup, no rate limits in practice.
- Neural voices that sound genuinely human (not the OS-default SpeechSynthesis robot).
- Works server-side, so the same audio is consistent across browsers/devices.

Default voice is en-AU-WilliamNeural (Sydney accent) since Yash is based in Sydney.
Swap via the YASH_EXE_VOICE env var. A few that sound great:
- en-AU-WilliamNeural  (Australian male, warm/professional)
- en-AU-NeilNeural     (Australian male, slightly older/deeper)
- en-US-BrianNeural    (American male, casual confident)
- en-US-AndrewNeural   (American male, friendly)
- en-IN-PrabhatNeural  (Indian English male)
- en-GB-RyanNeural     (British male)
"""

from __future__ import annotations

import io
import os
import re
from typing import AsyncIterator

import edge_tts

VOICE = os.environ.get("YASH_EXE_VOICE", "en-AU-WilliamNeural")
RATE = os.environ.get("YASH_EXE_VOICE_RATE", "+5%")  # slightly faster than default = more energy


def _clean_for_speech(text: str) -> str:
    """Strip markdown / formatting so TTS doesn't read 'asterisk' or 'underscore' aloud."""
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"_(.+?)_", r"\1", text)
    text = re.sub(r"`(.+?)`", r"\1", text)
    text = re.sub(r"\[(.+?)\]\(.+?\)", r"\1", text)
    text = re.sub(r"^\s*[-*]\s+", "", text, flags=re.MULTILINE)
    return text.strip()


async def synthesize(text: str, voice: str | None = None) -> bytes:
    """Synthesize the full reply as a single MP3 blob. ~500ms-2s for typical replies."""
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
    """Streaming MP3 chunks — usable if the frontend supports MediaSource for low-latency
    playback. The non-streaming `synthesize()` is simpler and works everywhere."""
    clean = _clean_for_speech(text)
    if not clean:
        return
    communicate = edge_tts.Communicate(clean, voice or VOICE, rate=RATE)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]
