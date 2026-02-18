import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

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

  sonioxWs.on("open", () => {
    console.log("✅ Connected to Soniox, sending config");

    // Matches what we've observed from Vapi Web calls: raw PCM s16le @ 44.1kHz mono
    sonioxWs.send(
      JSON.stringify({
        api_key: SONIOX_API_KEY,
        model: "stt-rt-preview",
        audio_format: "pcm_s16le",
        sample_rate: 44100,
        num_channels: 1,
        language_hints: ["en"],
        language_hints_strict: true,
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

  let frameCount = 0;

  /* -------- Vapi → Soniox (Raw Audio) -------- */
  vapiWs.on("message", (data) => {
    if (!Buffer.isBuffer(data)) return;

    frameCount++;

    // Debug every ~20 frames
    if (frameCount % 20 === 0) {
      const rms = rmsS16LE(data);
      const peak = peakAbsS16LE(data);
      console.log(`🔎 Audio stats rms=${rms.toFixed(2)} peak=${peak} bytes=${data.length}`);
    }

    if (sonioxWs.readyState === WebSocket.OPEN) {
      sonioxWs.send(data);
    }
  });

  vapiWs.on("close", () => {
    console.log("🔌 Vapi closed");
    try {
      sonioxWs.send(JSON.stringify({ type: "finalize" }));
    } catch {}
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

    // Send live hypothesis (partial + final)
    const hypothesis = tokens
      .map((t) => t.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    if (!hypothesis) return;

    console.log("📝 Sending transcription:", hypothesis);

    vapiWs.send(
      JSON.stringify({
        type: "transcriber-response",
        transcription: hypothesis,
        channel: "customer"
      })
    );
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy listening on port ${PORT}`);
});
