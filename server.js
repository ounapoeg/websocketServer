import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

const INPUT_SAMPLE_RATE = 44100;
const OUTPUT_SAMPLE_RATE = 16000;
const RATIO = INPUT_SAMPLE_RATE / OUTPUT_SAMPLE_RATE; // 2.75625

/* -------------------- RESAMPLE -------------------- */
function resampleS16LE(inputBuf) {
  const inputSamples = Math.floor(inputBuf.length / 2);
  const outputSamples = Math.floor(inputSamples / RATIO);
  const outputBuf = Buffer.allocUnsafe(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * RATIO;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    const s0 = inputBuf.readInt16LE(srcIdx * 2);
    const s1 = srcIdx + 1 < inputSamples
      ? inputBuf.readInt16LE((srcIdx + 1) * 2)
      : s0;

    const interpolated = Math.round(s0 + frac * (s1 - s0));
    outputBuf.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
  }

  return outputBuf;
}

/* -------------------- AUDIO DEBUG -------------------- */
function rmsS16LE(buf) {
  const n = Math.floor(buf.length / 2);
  if (n <= 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / n);
}

function peakAbsS16LE(buf) {
  const n = Math.floor(buf.length / 2);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.abs(buf.readInt16LE(i * 2));
    if (s > peak) peak = s;
  }
  return peak;
}

/* -------------------- HTTP SERVER -------------------- */
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("soniox-vapi-ws-proxy up");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (vapiWs) => {
  console.log("✅ Vapi connected");

  if (!SONIOX_API_KEY) {
    console.error("❌ Missing SONIOX_API_KEY");
    vapiWs.close(1011, "Missing SONIOX_API_KEY");
    return;
  }

  const sonioxWs = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");

  // Accumulated final tokens across all messages — never reset these
  let accumulatedFinalText = "";

  sonioxWs.on("open", () => {
    console.log("✅ Connected to Soniox, sending config");
    sonioxWs.send(
      JSON.stringify({
        api_key: SONIOX_API_KEY,
        model: "stt-rt-preview",
        audio_format: "pcm_s16le",
        sample_rate: OUTPUT_SAMPLE_RATE,
        num_channels: 1,
        language_hints: ["et"],
        language_hints_strict: true,
        enable_endpoint_detection: true,
      })
    );
  });

  sonioxWs.on("error", (err) => {
    console.error("❌ Soniox error:", err);
    try { vapiWs.close(); } catch {}
  });

  sonioxWs.on("close", (code, reason) => {
    console.log("🔌 Soniox closed", code, reason?.toString?.() || "");
    try { vapiWs.close(); } catch {}
  });

  let frameCount = 0;

  /* -------- Vapi → Soniox -------- */
  vapiWs.on("message", (data) => {
    if (!Buffer.isBuffer(data)) {
      console.log("📨 Vapi JSON message:", data.toString().slice(0, 300));
      return;
    }

    frameCount++;

    if (frameCount % 20 === 0) {
      const rms = rmsS16LE(data);
      const peak = peakAbsS16LE(data);
      console.log(`🔎 Raw    rms=${rms.toFixed(2)} peak=${peak} bytes=${data.length}`);
    }

    if (sonioxWs.readyState !== WebSocket.OPEN) return;

    const resampled = resampleS16LE(data);

    if (frameCount % 20 === 0) {
      const rms2 = rmsS16LE(resampled);
      console.log(`🔎 Resamp rms=${rms2.toFixed(2)} bytes=${resampled.length}`);
    }

    sonioxWs.send(resampled);
  });

  vapiWs.on("close", () => {
    console.log("🔌 Vapi closed");
    if (sonioxWs.readyState === WebSocket.OPEN) {
      try {
        // Per Soniox docs: send an empty frame to signal end of audio
        sonioxWs.send(Buffer.alloc(0));
      } catch {}
    }
  });

  /* -------- Soniox → Vapi (Transcript) -------- */
  sonioxWs.on("message", (data) => {
    const raw = data.toString();
    console.log("📩 Soniox response:", raw.slice(0, 200));

    let response;
    try {
      response = JSON.parse(raw);
    } catch {
      return;
    }

    if (response.error_code) {
      console.error("❌ Soniox error:", response.error_message);
      return;
    }

    if (response.finished) {
      console.log("✅ Soniox session finished");
      try { sonioxWs.close(); } catch {}
      return;
    }

    const tokens = response.tokens;
    if (!tokens || tokens.length === 0) return;

    // Per docs: final tokens are sent ONCE and never repeated — accumulate them
    const newFinalText = tokens
      .filter((t) => t.is_final && t.text)
      .map((t) => t.text)
      .join("");

    // Non-final tokens reset every message — they're the current hypothesis tail
    const partialText = tokens
      .filter((t) => !t.is_final && t.text)
      .map((t) => t.text)
      .join("");

    if (newFinalText) {
      accumulatedFinalText += newFinalText;
    }

    const fullHypothesis = (accumulatedFinalText + partialText)
      .replace(/\s+/g, " ")
      .trim();

    if (!fullHypothesis) return;

    const isFinal = partialText.length === 0 && newFinalText.length > 0;

    console.log(`📝 (${isFinal ? "final" : "partial"}):`, fullHypothesis);

    if (vapiWs.readyState === WebSocket.OPEN) {
      vapiWs.send(
        JSON.stringify({
          type: "transcriber-response",
          transcription: fullHypothesis,
          isFinal,
          channel: "customer",
        })
      );
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy listening on port ${PORT}`);
});
