// Yash.exe — frontend chat + voice glue.
//
// Voice latency strategy:
// - LLM tokens stream from /api/chat/stream over SSE.
// - As tokens arrive, we accumulate a "speak buffer" and chip off complete sentence
//   chunks (sentence-ending punctuation + space, min 30 chars) — each chunk fires a
//   parallel /api/tts request. TTS requests synthesize concurrently.
// - Audio blobs play strictly in order via an in-order queue.
// - First audio plays ~1.0-1.5s after the user finishes speaking.
//
// Voice UX:
// - A prominent status banner above the composer shows "Listening" (with live transcript)
//   and "Yash is speaking" (with audio waves) so the user always knows the system's state.
// - Web Speech API's interimResults stream gives a live preview of the transcription.

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

// Audio queue. Each item is a Promise<Blob|null> so TTS requests can run in
// parallel while playback strictly serialises.
let audioQueue = [];
let isPlayingAudio = false;
let currentAudio = null;
let ttsAborter = null;

const MIN_CHUNK_LEN = 30;
const LONG_NO_PUNCT_LEN = 90;

// --- UI helpers ---

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

function queueSpeak(text) {
  const trimmed = text && text.trim();
  if (!trimmed) return;
  audioQueue.push(synthesizeBlob(trimmed, ttsAborter?.signal));
  playNextAudio();
}

async function playNextAudio() {
  if (isPlayingAudio) return;
  if (audioQueue.length === 0) {
    if (voiceStatusEl.classList.contains("speaking")) showVoiceStatus(null);
    return;
  }
  isPlayingAudio = true;
  showVoiceStatus("speaking");
  const blob = await audioQueue.shift();
  if (!blob || !blob.size) {
    isPlayingAudio = false;
    playNextAudio();
    return;
  }
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  audio.onended = () => {
    URL.revokeObjectURL(url);
    isPlayingAudio = false;
    if (currentAudio === audio) currentAudio = null;
    playNextAudio();
  };
  audio.onerror = () => {
    URL.revokeObjectURL(url);
    isPlayingAudio = false;
    playNextAudio();
  };
  try {
    await audio.play();
  } catch (err) {
    console.warn("audio.play failed", err);
    isPlayingAudio = false;
    playNextAudio();
  }
}

function stopSpeaking() {
  ttsAborter?.abort();
  audioQueue = [];
  isPlayingAudio = false;
  if (currentAudio) {
    try { currentAudio.pause(); } catch {}
    currentAudio = null;
  }
  if (voiceStatusEl.classList.contains("speaking")) showVoiceStatus(null);
}

function takeSpeakableChunk(buffer) {
  if (buffer.length < MIN_CHUNK_LEN) return null;
  let lastIdx = -1;
  const re = /[.!?]\s+/g;
  let m;
  while ((m = re.exec(buffer)) !== null) {
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx >= MIN_CHUNK_LEN) {
    return [buffer.slice(0, lastIdx).trim(), buffer.slice(lastIdx)];
  }
  if (buffer.length > LONG_NO_PUNCT_LEN) {
    const commaIdx = buffer.lastIndexOf(", ");
    if (commaIdx > MIN_CHUNK_LEN) {
      return [buffer.slice(0, commaIdx + 1).trim(), buffer.slice(commaIdx + 2)];
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

  const assistantEl = addMessage("assistant", "", { streaming: true });
  let fullReply = "";
  let speakBuf = "";
  abortCtrl = new AbortController();
  ttsAborter = new AbortController();

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
        assistantEl.textContent = fullReply;
        chatEl.scrollTop = chatEl.scrollHeight;

        if (voiceMode) {
          speakBuf += chunk;
          let split;
          while ((split = takeSpeakableChunk(speakBuf)) !== null) {
            const [toSpeak, rest] = split;
            queueSpeak(toSpeak);
            speakBuf = rest;
          }
        }
      }
    }

    assistantEl.classList.remove("streaming");
    if (fullReply) {
      history.push({ role: "assistant", content: fullReply });
      if (voiceMode && speakBuf.trim()) {
        queueSpeak(speakBuf);
      }
    }
  } catch (err) {
    assistantEl.classList.remove("streaming");
    if (err.name === "AbortError") {
      assistantEl.textContent = fullReply + " ⏹";
      if (fullReply) history.push({ role: "assistant", content: fullReply });
    } else {
      assistantEl.textContent = `Sorry — something broke: ${err.message}.`;
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
      showVoiceStatus(null);
      sendMessage(final.trim());
    }
  };

  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    // If we ended without a final result, hide the banner.
    if (!voiceMode && voiceStatusEl.classList.contains("listening")) {
      showVoiceStatus(null);
    }
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
      // Some browsers throw if start() is called too quickly after stop()
      listening = false;
      micBtn.classList.remove("listening");
    }
  }
});
