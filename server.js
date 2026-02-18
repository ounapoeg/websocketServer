import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

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

function rmsF32LE(buf) {
  const n = Math.floor(buf.length / 4);
  if (n <= 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readFloatLE(i * 4);
    if (!Number.isFinite(s)) return NaN;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / n);
}

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

  // Accumulate FINAL tokens to avoid duplication.
  let accumulatedText = "";

  // Log RMS periodically to determine actual incoming audio encoding.
  let frameCount = 0;

  const sonioxWs = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");

  sonioxWs.on("open", () => {
    console.log("✅ Connected to Soniox, sending config");

    // NOTE:
    // We start with the most likely WebRTC format: 48kHz mono, signed 16-bit little-endian PCM.
    // If RMS logs show that f32le spikes instead, switch audio_format to pcm_f32le.
    sonioxWs.send(
      JSON.stringify({
        api_key: SONIOX_API_KEY,
        model: "stt-rt-v4",
        audio_format: "pcm_s16le",
        sample_rate: 48000,
        num_channels: 1,
        language_hints: ["en", "et"],
        enable_endpoint_detection: true,
        enable_language_identification: true
      })
    );
  });

  sonioxWs.on("error", (err) => {
    console.error("❌ Soniox error:", err);
    try {
      vapiWs.close();
    } catch {}
  });

  sonioxWs.on("close", (code, reason) => {
    console.log("🔌 Soniox closed", code, reason?.toString?.() || "");
    try {
      vapiWs.close();
    } catch {}
  });

  // Vapi -> Soniox (audio)
  vapiWs.on("message", (data) => {
    if (!Buffer.isBuffer(data)) return;

    frameCount++;
    if (frameCount % 50 === 0) {
      const r16 = rmsS16LE(data);
      const r32 = rmsF32LE(data);
      console.log(
        "🔎 RMS s16le:",
        r16.toFixed(2),
        "RMS f32le:",
        Number.isNaN(r32) ? "NaN" : r32.toFixed(4),
        "bytes:",
        data.length
      );
    }

    if (sonioxWs.readyState === WebSocket.OPEN) {
      sonioxWs.send(data);
    }
  });

  vapiWs.on("close", () => {
    console.log("🔌 Vapi closed");
    try {
      sonioxWs.close();
    } catch {}
  });

  vapiWs.on("error", (err) => {
    console.error("❌ Vapi WS error:", err);
    try {
      sonioxWs.close();
    } catch {}
  });

  // Soniox -> Vapi (transcripts)
  sonioxWs.on("message", (data) => {
    const raw = data.toString();
    console.log("📩 Soniox response:", raw.slice(0, 250));

    let response;
    try {
      response = JSON.parse(raw);
    } catch (err) {
      console.error("❌ Soniox JSON parse error", err);
      return;
    }

    if (response.error_code) {
      console.error("❌ Soniox error:", response.error_code, response.error_message);
      return;
    }

    const tokens = response.tokens;
    if (!tokens || tokens.length === 0) return;

    // Only append final tokens to avoid the "Hell Hell o" duplication problem.
    const finalTokens = tokens.filter((t) => t && t.is_final);
    if (finalTokens.length === 0) return;

    const newText = finalTokens
      .map((t) => t.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!newText) return;

    accumulatedText += (accumulatedText ? " " : "") + newText;

    console.log("📝 Sending transcription:", accumulatedText);

    try {
      vapiWs.send(
        JSON.stringify({
          type: "transcriber-response",
          transcription: accumulatedText,
          channel: "customer"
        })
      );
    } catch (err) {
      console.error("❌ Failed sending transcription to Vapi", err);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy listening on port ${PORT}`);
});
