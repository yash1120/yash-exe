// Yash.exe — frontend chat + voice glue.
//
// Voice/text sync strategy (the important bit):
// - In voice mode, we DO NOT show the LLM's text as it streams in. We buffer it.
// - As complete sentences arrive, we fire parallel /api/tts requests (audio queue).
// - Each queue item carries a callback that reveals THAT sentence's text the
//   moment its audio starts playing (audio.onplay).
// - Result: text and audio appear in lock-step. The user doesn't read the whole
//   reply 4 seconds before hearing it.
// - In text mode (no mic), text streams normally — no waiting.

const chatEl = document.getElementById("chat");
const welcomeEl = document.getElementById("welcome");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const micBtn = document.getElementById("mic-btn");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const clearBtn = document.getElementById("clear-btn");
const chipsEl = document.getElementById("chips");
const voiceStatusEl = document.getElementById("voice-status");

const history = [];
let voiceMode = false;
let abortCtrl = null;

let audioQueue = [];     // [{ blobPromise, onPlay }]
let isPlayingAudio = false;
let currentAudio = null;
let ttsAborter = null;

const MIN_CHUNK_LEN = 22;
const COMMA_CHUNK_LEN = 60;
const LONG_NO_PUNCT_LEN = 90;

// Common abbreviations whose trailing "." is NOT a sentence end. Keep tight —
// too aggressive a list creates run-on chunks.
const ABBREV_TAIL = /(?:^|\s)(?:Dr|Mr|Mrs|Ms|St|vs|etc|cf|Jr|Sr|Inc|Co|Ltd|Corp|Prof|No|Ph\.D|M\.D|B\.A|M\.A|B\.S|M\.S|U\.S|U\.K|e\.g|i\.e)\.$/;

// --- DOM helpers ---

function hideWelcome() {
  if (welcomeEl && !welcomeEl.hidden) welcomeEl.hidden = true;
}

function addMessage(role, text, { streaming = false } = {}) {
  hideWelcome();
  const div = document.createElement("div");
  div.className = `msg ${role}` + (streaming ? " streaming" : "");
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function setBusy(busy) {
  sendBtn.disabled = busy;
  input.disabled = busy;
  stopBtn.hidden = !busy;
}

// --- Voice status banner ---

const MIC_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M19 11a7 7 0 0 1-14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`;

function showVoiceStatus(state, opts = {}) {
  if (!state) {
    voiceStatusEl.hidden = true;
    voiceStatusEl.className = "voice-status";
    voiceStatusEl.innerHTML = "";
    return;
  }
  voiceStatusEl.hidden = false;
  voiceStatusEl.className = `voice-status ${state}`;

  if (state === "listening") {
    const sub = opts.transcript
      ? `“${escapeHtml(opts.transcript)}”`
      : "Speak now — I'm listening";
    voiceStatusEl.innerHTML = `
      <span class="voice-icon">${MIC_SVG}</span>
      <div class="voice-text">
        <strong>Listening</strong>
        <span class="voice-sub" id="live-transcript">${sub}</span>
      </div>`;
  } else if (state === "thinking") {
    voiceStatusEl.innerHTML = `
      <span class="thinking-icon">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </span>
      <div class="voice-text">
        <strong>Thinking</strong>
        <span class="voice-sub">writing a reply, voice coming…</span>
      </div>`;
  } else if (state === "speaking") {
    voiceStatusEl.innerHTML = `
      <div class="voice-waves">
        <span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span>
      </div>
      <div class="voice-text">
        <strong>Yash is speaking</strong>
        <span class="voice-sub">tap the mic to interrupt</span>
      </div>`;
  }
}

function updateLiveTranscript(text) {
  const el = document.getElementById("live-transcript");
  if (el) el.textContent = text ? `“${text}”` : "Speak now — I'm listening";
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// --- TTS pipeline ---

async function synthesizeBlob(text, signal) {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

function queueSpeak(text, onPlayCallback) {
  const trimmed = text && text.trim();
  if (!trimmed) return;
  audioQueue.push({
    blobPromise: synthesizeBlob(trimmed, ttsAborter?.signal),
    onPlay: onPlayCallback || (() => {}),
  });
  playNextAudio();
}

async function playNextAudio() {
  if (isPlayingAudio) return;
  if (audioQueue.length === 0) {
    if (voiceStatusEl.classList.contains("speaking")) showVoiceStatus(null);
    return;
  }
  isPlayingAudio = true;
  // Show "speaking" the moment we start consuming the queue (covers the brief
  // window between thinking and the first audio actually firing).
  if (!voiceStatusEl.classList.contains("speaking")) showVoiceStatus("speaking");

  const item = audioQueue.shift();
  const blob = await item.blobPromise;

  if (!blob || !blob.size) {
    // TTS failed for this chunk — reveal text anyway so the conversation isn't stuck.
    try { item.onPlay(); } catch {}
    isPlayingAudio = false;
    playNextAudio();
    return;
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  let revealed = false;
  const revealOnce = () => {
    if (revealed) return;
    revealed = true;
    try { item.onPlay(); } catch {}
  };

  audio.onplay = revealOnce;
  audio.onended = () => {
    URL.revokeObjectURL(url);
    isPlayingAudio = false;
    if (currentAudio === audio) currentAudio = null;
    playNextAudio();
  };
  audio.onerror = () => {
    URL.revokeObjectURL(url);
    revealOnce();
    isPlayingAudio = false;
    playNextAudio();
  };
  try {
    await audio.play();
  } catch (err) {
    console.warn("audio.play failed", err);
    revealOnce();
    isPlayingAudio = false;
    playNextAudio();
  }
}

function stopSpeaking() {
  ttsAborter?.abort();
  // Reveal any text whose audio never got to play, so the chat isn't half-written.
  while (audioQueue.length > 0) {
    const item = audioQueue.shift();
    try { item.onPlay?.(); } catch {}
  }
  isPlayingAudio = false;
  if (currentAudio) {
    try { currentAudio.pause(); } catch {}
    currentAudio = null;
  }
  if (voiceStatusEl.classList.contains("speaking")) showVoiceStatus(null);
}

// Smart sentence-boundary chunker. Skips obvious abbreviations.
function takeSpeakableChunk(buffer) {
  if (buffer.length < MIN_CHUNK_LEN) return null;

  // Find the last real sentence-end (avoiding common abbreviations).
  let lastIdx = -1;
  const re = /[.!?]+\s+/g;
  let m;
  while ((m = re.exec(buffer)) !== null) {
    const before = buffer.slice(0, m.index + 1);
    if (ABBREV_TAIL.test(before)) continue;
    // Skip single-letter initials like "A." (often "A.I.", "U.S.")
    if (/\s[A-Z]\.$/.test(before)) continue;
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx >= MIN_CHUNK_LEN) {
    return [buffer.slice(0, lastIdx).trim(), buffer.slice(lastIdx)];
  }

  // Comma fallback for long clause-heavy sentences
  if (buffer.length >= COMMA_CHUNK_LEN) {
    const commaIdx = buffer.lastIndexOf(", ");
    if (commaIdx >= MIN_CHUNK_LEN) {
      return [buffer.slice(0, commaIdx + 1).trim(), buffer.slice(commaIdx + 2)];
    }
  }

  // Hard cap: chunk at any space if we've gone too long without punctuation
  if (buffer.length > LONG_NO_PUNCT_LEN) {
    const spaceIdx = buffer.lastIndexOf(" ", LONG_NO_PUNCT_LEN);
    if (spaceIdx >= MIN_CHUNK_LEN) {
      return [buffer.slice(0, spaceIdx).trim(), buffer.slice(spaceIdx + 1)];
    }
  }

  return null;
}

// --- Chips, Clear ---

chipsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  sendMessage(btn.dataset.prompt);
});

clearBtn.addEventListener("click", () => {
  history.length = 0;
  stopSpeaking();
  chatEl.querySelectorAll(".msg").forEach((m) => m.remove());
  if (welcomeEl) welcomeEl.hidden = false;
});

// --- Chat (SSE streaming + interleaved TTS) ---

async function sendMessage(message) {
  if (!message || !message.trim()) return;
  if (sendBtn.disabled) return;

  stopSpeaking();
  addMessage("user", message);
  history.push({ role: "user", content: message });
  input.value = "";
  setBusy(true);

  // In voice mode, suppress the streaming caret and show "Thinking" in the banner.
  const wasVoice = voiceMode;
  const assistantEl = addMessage("assistant", "", { streaming: !wasVoice });
  if (wasVoice) showVoiceStatus("thinking");

  let fullReply = "";
  let speakBuf = "";
  let revealedText = "";
  abortCtrl = new AbortController();
  ttsAborter = new AbortController();

  // Reveals one TTS chunk's worth of text to the bubble. Called from audio.onplay.
  function revealChunk(chunkText) {
    revealedText = revealedText ? `${revealedText} ${chunkText}` : chunkText;
    assistantEl.textContent = revealedText;
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: history.slice(0, -1) }),
      signal: abortCtrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      const lines = sseBuf.split("\n");
      sseBuf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        const chunk = data.replace(/\\n/g, "\n");
        fullReply += chunk;

        if (wasVoice) {
          // Voice mode: buffer text, fire TTS per sentence, reveal on audio.onplay.
          speakBuf += chunk;
          let split;
          while ((split = takeSpeakableChunk(speakBuf)) !== null) {
            const [toSpeak, rest] = split;
            queueSpeak(toSpeak, () => revealChunk(toSpeak));
            speakBuf = rest;
          }
        } else {
          // Text mode: show as it streams.
          assistantEl.textContent = fullReply;
          chatEl.scrollTop = chatEl.scrollHeight;
        }
      }
    }

    assistantEl.classList.remove("streaming");
    if (fullReply) {
      history.push({ role: "assistant", content: fullReply });
      if (wasVoice && speakBuf.trim()) {
        const remaining = speakBuf.trim();
        queueSpeak(remaining, () => revealChunk(remaining));
      }
    }
  } catch (err) {
    assistantEl.classList.remove("streaming");
    if (wasVoice && fullReply && revealedText.length < fullReply.length) {
      // Audio path failed — make sure user sees the full reply text.
      assistantEl.textContent = fullReply;
      showVoiceStatus(null);
    }
    if (err.name === "AbortError") {
      if (fullReply && !history.includes({ role: "assistant", content: fullReply })) {
        history.push({ role: "assistant", content: fullReply });
      }
    } else {
      if (!assistantEl.textContent) {
        assistantEl.textContent = `Sorry — something broke: ${err.message}.`;
      }
    }
  } finally {
    setBusy(false);
    voiceMode = false;
    abortCtrl = null;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(input.value);
});

stopBtn.addEventListener("click", () => {
  abortCtrl?.abort();
  stopSpeaking();
});

// --- Speech recognition (mic in) ---

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

if (SR) {
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-AU";

  recognition.onstart = () => {
    showVoiceStatus("listening");
  };

  recognition.onresult = (evt) => {
    let interim = "";
    let final = "";
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const t = evt.results[i][0].transcript;
      if (evt.results[i].isFinal) final += t;
      else interim += t;
    }
    if (interim && !final) {
      updateLiveTranscript(interim.trim());
    }
    if (final.trim()) {
      voiceMode = true;
      sendMessage(final.trim());
    }
  };

  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    // Only hide if we were still in listening state (sendMessage swaps to "thinking")
    if (voiceStatusEl.classList.contains("listening")) showVoiceStatus(null);
  };

  recognition.onerror = (evt) => {
    listening = false;
    micBtn.classList.remove("listening");
    if (voiceStatusEl.classList.contains("listening")) showVoiceStatus(null);
    if (evt.error && evt.error !== "no-speech" && evt.error !== "aborted") {
      console.warn("speech recognition error:", evt.error);
    }
  };
} else {
  micBtn.disabled = true;
  micBtn.title = "Speech recognition needs Chrome / Edge / Brave.";
}

micBtn.addEventListener("click", () => {
  if (!recognition) return;
  if (listening) {
    recognition.stop();
  } else {
    stopSpeaking();
    listening = true;
    micBtn.classList.add("listening");
    try {
      recognition.start();
    } catch {
      listening = false;
      micBtn.classList.remove("listening");
    }
  }
});
