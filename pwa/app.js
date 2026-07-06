"use strict";

// ---------------------------------------------------------------------------
// Audio protocol (16-tone FSK: one tone carries one nibble). Same protocol as
// the desktop app, so web devices interoperate with each other.
// ---------------------------------------------------------------------------
const TONE_DUR = 0.075;
const GAP_DUR = 0.035;
const BASE_FREQ = 1600.0;
const FREQ_STEP = 160.0;
const START_FREQ = 4400.0;
const END_FREQ = 4800.0;
const NIBBLE_FREQS = Array.from({ length: 16 }, (_, i) => BASE_FREQ + i * FREQ_STEP);
const ALL_FREQS = [...NIBBLE_FREQS, START_FREQ, END_FREQ];
const IDX_START = 16;
const IDX_END = 17;
const BLOCK = 512;
const MAX_TEXT = 120;
const LEAD_SILENCE = 0.5;

const enc = new TextEncoder();

function checksumOf(bytes) {
  let c = 0;
  for (const b of bytes) c ^= b;
  return c;
}

// Text -> mono Float32 waveform at the given sample rate.
function encodeText(text, sampleRate) {
  const data = enc.encode(text);
  const symbols = [IDX_START, IDX_START];
  for (const b of [...data, checksumOf(data)]) {
    symbols.push((b >> 4) & 0xf, b & 0xf);
  }
  symbols.push(IDX_END, IDX_END);

  const nTone = Math.floor(sampleRate * TONE_DUR);
  const nGap = Math.floor(sampleRate * GAP_DUR);
  const nFade = Math.floor(sampleRate * 0.005);
  const nLead = Math.floor(sampleRate * LEAD_SILENCE);
  const total = nLead * 2 + symbols.length * (nTone + nGap);
  const out = new Float32Array(total);

  let pos = nLead;
  for (const s of symbols) {
    const f = ALL_FREQS[s];
    for (let i = 0; i < nTone; i++) {
      let amp = 0.8;
      if (i < nFade) amp *= i / nFade;
      else if (i >= nTone - nFade) amp *= (nTone - 1 - i) / nFade;
      out[pos + i] = Math.sin((2 * Math.PI * f * i) / sampleRate) * amp;
    }
    pos += nTone + nGap; // the gap stays silent (already zero)
  }
  return out;
}

// Power of a block at each candidate frequency (Goertzel).
function goertzelPowers(block, sampleRate) {
  const n = block.length;
  const p = new Float64Array(ALL_FREQS.length);
  for (let idx = 0; idx < ALL_FREQS.length; idx++) {
    const k = Math.round((ALL_FREQS[idx] * n) / sampleRate);
    const w = (2 * Math.PI * k) / n;
    const coeff = 2 * Math.cos(w);
    let s0 = 0, s1 = 0;
    for (let i = 0; i < n; i++) {
      const t = block[i] + coeff * s0 - s1;
      s1 = s0;
      s0 = t;
    }
    p[idx] = s0 * s0 + s1 * s1 - coeff * s0 * s1;
  }
  return p;
}

// State machine: audio blocks in, text out.
class Decoder {
  constructor(onText, onStatus, sampleRate) {
    this.onText = onText;
    this.onStatus = onStatus;
    this.sampleRate = sampleRate;
    this.reset();
  }
  reset() {
    this.inFrame = false;
    this.symbols = [];
    this.curIdx = null;
    this.curCount = 0;
    this.silence = 0;
  }
  _classify(block) {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    if (rms < 1e-4) return null;
    const p = goertzelPowers(block, this.sampleRate);
    let i = 0;
    for (let j = 1; j < p.length; j++) if (p[j] > p[i]) i = j;
    let rest = 0;
    for (let j = 0; j < p.length; j++) if (j !== i) rest += p[j];
    rest /= p.length - 1;
    const loud = Math.pow(rms * block.length, 2) * 0.05;
    if (p[i] > 6.0 * (rest + 1e-12) && p[i] > loud) return i;
    return null;
  }
  _endSegment() {
    if (this.curIdx !== null && this.curCount >= 3) this._onSymbol(this.curIdx);
    this.curIdx = null;
    this.curCount = 0;
  }
  _onSymbol(idx) {
    if (idx === IDX_START) {
      this.inFrame = true;
      this.symbols = [];
      this.onStatus(STATUS.receiving);
    } else if (idx === IDX_END) {
      if (this.inFrame) this._finish();
      this.reset();
    } else if (this.inFrame) {
      this.symbols.push(idx);
    }
  }
  _finish() {
    const nib = this.symbols;
    if (nib.length < 2 || nib.length % 2 !== 0) {
      this.onText(null, false);
      return;
    }
    const bytes = new Uint8Array(nib.length / 2);
    for (let i = 0; i < nib.length; i += 2) bytes[i / 2] = (nib[i] << 4) | nib[i + 1];
    const payload = bytes.slice(0, -1);
    const checksum = bytes[bytes.length - 1];
    let text = null;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(payload);
    } catch (e) {
      text = null;
    }
    this.onText(text, checksumOf(payload) === checksum);
  }
  feed(block) {
    const idx = this._classify(block);
    if (idx === null) {
      this.silence += 1;
      if (this.silence >= 2) this._endSegment();
      if (this.inFrame && this.silence > 100) {
        this.onStatus(STATUS.aborted);
        this.reset();
      }
      return;
    }
    this.silence = 0;
    if (idx === this.curIdx) {
      this.curCount += 1;
    } else {
      this._endSegment();
      this.curIdx = idx;
      this.curCount = 1;
    }
  }
}

const STATUS = {
  receiving: "Sequence detected, receiving...",
  aborted: "Sequence interrupted.",
};

// ---------------------------------------------------------------------------
// WAV export
// ---------------------------------------------------------------------------
function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ws(36, "data");
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Oscilloscope drawing (canvas 2D)
// ---------------------------------------------------------------------------
const SCOPE_GRID = "#1c2733";
const SCOPE_MID = "#243447";
const SCOPE_WAVE = "#39d353";

function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

function drawScope(canvas, samples, caption, markers) {
  const { w, h, dpr } = sizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b0f16";
  ctx.fillRect(0, 0, w, h);
  const mid = h / 2;

  ctx.strokeStyle = SCOPE_GRID;
  ctx.lineWidth = 1;
  for (let gx = 0; gx < w; gx += 40) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
  }
  ctx.strokeStyle = SCOPE_MID;
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

  if (markers) {
    ctx.font = "10px Tahoma";
    for (const m of markers) {
      const x1 = m.a * w, x2 = m.b * w;
      ctx.fillStyle = m.color;
      ctx.globalAlpha = 0.28;
      ctx.fillRect(x1, 0, x2 - x1, h);
      ctx.globalAlpha = 1;
      if (x2 - x1 > 22) {
        ctx.fillStyle = "#dfe8ff";
        ctx.textAlign = "center";
        ctx.fillText(m.label, (x1 + x2) / 2, h - 6);
      }
    }
  }

  if (!samples || samples.length === 0) {
    ctx.fillStyle = "#4a5a6a";
    ctx.font = "11px Tahoma";
    ctx.textAlign = "center";
    ctx.fillText("(no signal)", w / 2, mid);
    return;
  }

  const n = samples.length;
  const cols = Math.min(Math.floor(w), n);
  let peak = 1e-9;
  for (let i = 0; i < n; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  const amp = mid - 5;
  ctx.strokeStyle = SCOPE_WAVE;
  ctx.beginPath();
  for (let c = 0; c < cols; c++) {
    const a = Math.floor((c * n) / cols);
    let b = Math.floor(((c + 1) * n) / cols);
    if (b <= a) b = a + 1;
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i < b && i < n; i++) { const v = samples[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const x = c * (w / cols);
    ctx.moveTo(x, mid - (hi / peak) * amp);
    ctx.lineTo(x, mid - (lo / peak) * amp);
  }
  ctx.stroke();

  if (caption) {
    ctx.fillStyle = "#c8f7c8";
    ctx.font = "10px Tahoma";
    ctx.textAlign = "left";
    ctx.fillText(caption, 7, 13);
  }
}

// ---------------------------------------------------------------------------
// Waveform navigator (letter by letter) for the Generate tab
// ---------------------------------------------------------------------------
function buildTxView(text, wave, sampleRate) {
  const nTone = Math.floor(sampleRate * TONE_DUR);
  const symLen = nTone + Math.floor(sampleRate * GAP_DUR);
  const lead = Math.floor(sampleRate * LEAD_SILENCE);
  const data = enc.encode(text);
  const hex = (v) => v.toString(16).toUpperCase();

  const symbols = [["ROGER", "#3a6ea5"], ["ROGER", "#3a6ea5"]];
  for (const b of [...data, checksumOf(data)]) {
    symbols.push([hex((b >> 4) & 0xf), "#2f7d4f"]);
    symbols.push([hex(b & 0xf), "#2f7d4f"]);
  }
  symbols.push(["E", "#a53a3a"], ["E", "#a53a3a"]);

  const symSpan = (k) => { const a = lead + k * symLen; return [a, a + nTone]; };

  const segs = [["ROGER ROGER (sync markers)", 0, 2]];
  let k = 2;
  for (const ch of text) {
    const nb = enc.encode(ch).length;
    const show = ch.trim() ? ch : "space";
    segs.push([`Letter "${show}"`, k, k + nb * 2]);
    k += nb * 2;
  }
  segs.push(["CHECKSUM (integrity byte)", k, k + 2]);
  segs.push(["END (closing markers)", k + 2, k + 4]);

  return { wave, symbols, symSpan, segs, sampleRate };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const setStatus = (msg) => { statusEl.textContent = msg; };

let audioCtx = null;
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// Droid panels
let droidTick = 0;
function setDroid(imgEl, state) {
  if (state === "success") {
    droidTick += 1;
    imgEl.src = "success.gif?" + droidTick; // restart the animation
  } else if (state === "fail") {
    imgEl.src = "error.png";
  } else {
    imgEl.src = "rogericon.jpg";
  }
}

const rogerAudio = new Audio("rogerroger.mp3");
function playRoger() {
  try { rogerAudio.currentTime = 0; rogerAudio.play().catch(() => {}); } catch (e) {}
}

// Tabs
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $("generate").classList.toggle("hidden", tab.dataset.tab !== "generate");
    $("listen").classList.toggle("hidden", tab.dataset.tab !== "listen");
  });
});

// ---- Generate tab ----
const txText = $("tx-text");
const txCount = $("tx-count");
const txWave = $("tx-wave");
const genDroid = $("gen-droid");
let txView = null;
let txIdx = 0;
let txBusy = false;

txText.addEventListener("input", () => {
  const n = txText.value.length;
  txCount.textContent = `${n} / ${MAX_TEXT} characters`;
});

function renderTxSegment() {
  if (!txView) { drawScope(txWave, null, "", null); updateTxNav(); return; }
  const n = txView.wave.length;
  const [title, k0, k1] = txView.segs[txIdx];
  const [a0] = txView.symSpan(k0);
  const [, a1] = txView.symSpan(k1 - 1);
  const pad = Math.floor(txView.sampleRate * 0.04);
  const va = Math.max(0, a0 - pad);
  const vb = Math.min(n, a1 + pad);
  const view = txView.wave.subarray(va, vb);
  const span = Math.max(1, vb - va);
  const markers = [];
  for (let k = k0; k < k1; k++) {
    const [label, color] = txView.symbols[k];
    const [sa, sb] = txView.symSpan(k);
    markers.push({ a: (sa - va) / span, b: (sb - va) / span, label, color });
  }
  const secs = n / txView.sampleRate;
  const cap = `${txIdx + 1}/${txView.segs.length}   ${title}   (message ~${secs.toFixed(1)}s)`;
  drawScope(txWave, view, cap, markers);
  updateTxNav();
}

function updateTxNav() {
  const ready = !!txView;
  $("tx-prev").disabled = !(ready && txIdx > 0);
  $("tx-next").disabled = !(ready && txIdx < txView.segs.length - 1);
  $("tx-seg").textContent = ready
    ? `${txIdx + 1} / ${txView.segs.length}   ${txView.segs[txIdx][0]}`
    : "Generate a message to explore the waveform.";
}

$("tx-prev").addEventListener("click", () => { if (txView && txIdx > 0) { txIdx--; renderTxSegment(); } });
$("tx-next").addEventListener("click", () => { if (txView && txIdx < txView.segs.length - 1) { txIdx++; renderTxSegment(); } });

$("tx-btn").addEventListener("click", () => {
  const text = txText.value.trim();
  if (!text) { setStatus("Type a message to transmit."); return; }
  if (txBusy) return;
  const ctx = getCtx();
  const wave = encodeText(text, ctx.sampleRate);
  txView = buildTxView(text, wave, ctx.sampleRate);
  txIdx = 0;
  renderTxSegment();
  setDroid(genDroid, "idle");

  const buf = ctx.createBuffer(1, wave.length, ctx.sampleRate);
  buf.copyToChannel(wave, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);

  txBusy = true;
  $("tx-btn").disabled = true;
  $("tx-btn").textContent = "TRANSMITTING...";
  setStatus(`Transmitting (~${(wave.length / ctx.sampleRate).toFixed(0)} s)...`);
  src.onended = () => {
    txBusy = false;
    $("tx-btn").disabled = false;
    $("tx-btn").textContent = "TRANSMIT";
    setStatus("Transmission complete. Roger.");
    setDroid(genDroid, "success"); // stays until the next transmit
  };
  src.start();
});

$("save-btn").addEventListener("click", () => {
  const text = txText.value.trim();
  if (!text) { setStatus("Type a message to save."); return; }
  const rate = (audioCtx && audioCtx.sampleRate) || 44100;
  const wave = encodeText(text, rate);
  txView = buildTxView(text, wave, rate);
  txIdx = 0;
  renderTxSegment();
  const blob = encodeWav(wave, rate);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "roger.wav";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("WAV saved.");
});

// ---- Listen tab ----
const rxWave = $("rx-wave");
const rxTextEl = $("rx-text");
const rxDroid = $("rx-droid");
let listening = false;
let micStream = null;
let workletNode = null;
let sourceNode = null;
let decoder = null;
let rxBuf = null;
let rxViewLen = 0;
let rafId = 0;
let rxCaption = "";

function appendReceived(line) {
  rxTextEl.textContent += line + "\n";
  rxTextEl.scrollTop = rxTextEl.scrollHeight;
}

async function startListen() {
  const ctx = getCtx();
  rxViewLen = Math.floor(ctx.sampleRate * 1.5);
  rxBuf = new Float32Array(rxViewLen);
  rxCaption = "listening...";
  decoder = new Decoder(onReceived, onDecoderStatus, ctx.sampleRate);

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    setStatus("Microphone access denied or unavailable.");
    return;
  }

  try {
    await ctx.audioWorklet.addModule("capture-worklet.js");
  } catch (e) {
    setStatus("Audio engine failed to start: " + e.message);
    micStream.getTracks().forEach((t) => t.stop());
    return;
  }

  sourceNode = ctx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(ctx, "capture");
  workletNode.port.onmessage = (e) => handleBlock(e.data);
  const sink = ctx.createGain();
  sink.gain.value = 0; // keep the node pulled without feeding audio back out
  sourceNode.connect(workletNode);
  workletNode.connect(sink);
  sink.connect(ctx.destination);

  listening = true;
  $("listen-btn").textContent = "STOP";
  setStatus("Listening... waiting for an audio sequence.");
  setDroid(rxDroid, "idle");
  loopScope();
}

function stopListen(msg) {
  listening = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (workletNode) { try { workletNode.disconnect(); } catch (e) {} workletNode = null; }
  if (sourceNode) { try { sourceNode.disconnect(); } catch (e) {} sourceNode = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  $("listen-btn").textContent = "LISTEN";
  setStatus(msg);
  drawScope(rxWave, null, "", null);
}

function handleBlock(block) {
  if (!listening) return;
  // rolling buffer for the scope
  rxBuf.copyWithin(0, block.length);
  rxBuf.set(block, rxViewLen - block.length);
  try { decoder.feed(block); } catch (e) { decoder.reset(); }
}

function loopScope() {
  if (!listening) return;
  drawScope(rxWave, rxBuf, rxCaption, null);
  rafId = requestAnimationFrame(loopScope);
}

function onDecoderStatus(msg) {
  setStatus(msg);
  if (msg === STATUS.aborted) setDroid(rxDroid, "fail");
  else if (msg === STATUS.receiving) setDroid(rxDroid, "idle");
}

function onReceived(text, ok) {
  if (text === null) {
    setStatus("Invalid sequence, try again.");
    rxCaption = "invalid sequence";
    setDroid(rxDroid, "fail");
  } else if (ok) {
    appendReceived("> " + text);
    setStatus("Message received. Roger roger.");
    rxCaption = '"' + text + '"';
    setDroid(rxDroid, "success");
    playRoger();
  } else {
    appendReceived("> " + text + "   [checksum error]");
    setStatus("Received with errors: move closer and retry.");
    rxCaption = '"' + text + '" [checksum]';
    setDroid(rxDroid, "fail");
  }
}

$("listen-btn").addEventListener("click", () => {
  if (listening) stopListen("Listening stopped.");
  else startListen();
});

// Redraw on resize / first paint.
window.addEventListener("resize", () => {
  if (txView) renderTxSegment(); else drawScope(txWave, null, "", null);
  if (!listening) drawScope(rxWave, null, "", null);
});
drawScope(txWave, null, "", null);
drawScope(rxWave, null, "", null);

// ---------------------------------------------------------------------------
// PWA service worker
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
