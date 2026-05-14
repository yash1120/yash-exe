// Yash.exe — frontend chat + voice glue.
//
// Voice latency strategy:
// - LLM tokens stream from /api/chat/stream over SSE.
// - As tokens arrive, we accumulate a "speak buffer" and chip off complete sentence
//   chunks (sentence-ending punctuation + space, min 30 chars) — each chunk fires a
//   parallel /api/tts request. TTS requests synthesize concurrently.
// - Audio blobs play strictly in order via an in-order queue.
// - Result: first audio typically plays ~1.0-1.5s after the user finishes speaking,
//   vs ~5s if we waited for the full LLM reply before calling TTS.

const chatEl = document.getElementById("chat");
const welcomeEl = document.getElementById("welcome");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const micBtn = document.getElementById("mic-btn");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const clearBtn = document.getElementById("clear-btn");
const audioIndicator = document.getElementById("audio-indicator");
const chipsEl = document.getElementById("chips");

const history = [];
let voiceMode = false;
let abortCtrl = null;

// Audio queue. Each item is a Promise<Blob|null> so TTS requests can run in
// parallel while playback strictly serialises.
let audioQueue = [];
let isPlayingAudio = false;
let currentAudio = null;
let ttsAborter = null;

const MIN_CHUNK_LEN = 30;       // don't fire TTS for tiny scraps
const LONG_NO_PUNCT_LEN = 90;   // emergency-flush on comma if no period yet

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
  audioIndicator.hidden = false;
  // Kick off the TTS request immediately — it runs in parallel with any prior
  // requests so total TTFA scales with the slowest single sentence, not the sum.
  audioQueue.push(synthesizeBlob(trimmed, ttsAborter?.signal));
  playNextAudio();
}

async function playNextAudio() {
  if (isPlayingAudio) return;
  if (audioQueue.length === 0) {
    audioIndicator.hidden = true;
    return;
  }
  isPlayingAudio = true;
  audioIndicator.hidden = false;
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
  audioIndicator.hidden = true;
}

// Given the running buffer of LLM text, return [chunkToSpeak, leftover] if a
// speakable boundary is available, else null.
function takeSpeakableChunk(buffer) {
  if (buffer.length < MIN_CHUNK_LEN) return null;

  // Find the last sentence-ending punctuation followed by whitespace.
  let lastIdx = -1;
  const re = /[.!?]\s+/g;
  let m;
  while ((m = re.exec(buffer)) !== null) {
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx >= MIN_CHUNK_LEN) {
    return [buffer.slice(0, lastIdx).trim(), buffer.slice(lastIdx)];
  }

  // Fallback: if the buffer is getting long and there's no sentence break,
  // chunk on a comma so audio keeps flowing.
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
  recognition.interimResults = false;
  recognition.lang = "en-AU";

  recognition.onresult = (evt) => {
    const transcript = evt.results[0][0].transcript;
    voiceMode = true;
    sendMessage(transcript);
  };
  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
  };
  recognition.onerror = () => {
    listening = false;
    micBtn.classList.remove("listening");
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
    recognition.start();
  }
});
