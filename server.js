import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

/* -------------------- RMS DEBUG -------------------- */

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

/* -------------------- 44.1k → 48k RESAMPLER -------------------- */

function resample441to48000(buffer) {
  const inputSamples = buffer.length / 2;
  const outputSamples = Math.floor(inputSamples * (48000 / 44100));
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const t = i * (44100 / 48000);
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, inputSamples - 1);
    const frac = t - i0;

    const s0 = buffer.readInt16LE(i0 * 2);
    const s1 = buffer.readInt16LE(i1 * 2);

    const sample = s0 + (s1 - s0) * frac;
    output.writeInt16LE(sample, i * 2);
  }

  return output;
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

/* -------------------- WEBSOCKET HANDLER -------------------- */

wss.on("connection", (vapiWs) => {
  console.log("✅ Vapi connected");

  if (!SONIOX_API_KEY) {
    console.error("❌ Missing SONIOX_API_KEY");
    vapiWs.close(1011, "Missing SONIOX_API_KEY");
    return;
  }

  let accumulatedText = "";
  let frameCount = 0;

  const sonioxWs = new WebSocket(
    "wss://stt-rt.soniox.com/transcribe-websocket"
  );

  sonioxWs.on("open", () => {
    console.log("✅ Connected to Soniox, sending config");

    sonioxWs.send(
      JSON.stringify({
        api_key: SONIOX_API_KEY,
        model: "stt-rt-v4",
        audio_format: "pcm_s16le",
        sample_rate: 48000,   // ✅ we resample to 48k
        num_channels: 1,
        language_hints: ["en", "et"],
        enable_endpoint_detection: true
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

  /* -------- Vapi → Soniox (Audio) -------- */

  vapiWs.on("message", (data) => {
    if (!Buffer.isBuffer(data)) return;

    frameCount++;

    if (frameCount % 50 === 0) {
      console.log("🔎 RMS s16le:", rmsS16LE(data).toFixed(2), "bytes:", data.length);
    }

    // ✅ Resample from 44.1k → 48k before sending
    const resampled = resample441to48000(data);

    if (sonioxWs.readyState === WebSocket.OPEN) {
      sonioxWs.send(resampled);
    }
  });

  vapiWs.on("close", () => {
    console.log("🔌 Vapi closed");
    try { sonioxWs.close(); } catch {}
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

    const tokens = response.tokens;
    if (!tokens || tokens.length === 0) return;

    // Only append FINAL tokens
    const finalTokens = tokens.filter(t => t.is_final);
    if (!finalTokens.length) return;

    const newText = finalTokens
      .map(t => t.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!newText) return;

    accumulatedText += (accumulatedText ? " " : "") + newText;

    console.log("📝 Sending transcription:", accumulatedText);

    vapiWs.send(JSON.stringify({
      type: "transcriber-response",
      transcription: accumulatedText,
      channel: "customer"
    }));
  });
});

/* -------------------- START SERVER -------------------- */

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy listening on port ${PORT}`);
});
