import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

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

  let accumulatedText = "";

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
        sample_rate: 48000, // WebRTC uses 48kHz
        num_channels: 2,
        language_hints: ["en", "et"],
        enable_endpoint_detection: true
      })
    );
  });

  sonioxWs.on("error", (err) => {
    console.error("❌ Soniox error:", err);
    try { vapiWs.close(); } catch {}
  });

  sonioxWs.on("close", () => {
    console.log("🔌 Soniox closed");
    try { vapiWs.close(); } catch {}
  });

  // Forward audio from Vapi → Soniox
  vapiWs.on("message", (data) => {
    if (Buffer.isBuffer(data)) {
      console.log("🎤 Audio chunk:", data.length, "bytes");
    }

    if (sonioxWs.readyState === WebSocket.OPEN) {
      sonioxWs.send(data);
    }
  });

  vapiWs.on("close", () => {
    console.log("🔌 Vapi closed");
    try { sonioxWs.close(); } catch {}
  });

  // Handle Soniox responses
  sonioxWs.on("message", (data) => {
    const raw = data.toString();
    console.log("📩 Soniox response:", raw.slice(0, 200));

    let response;
    try {
      response = JSON.parse(raw);
    } catch {
      console.error("❌ JSON parse error");
      return;
    }

    if (response.error_code) {
      console.error("❌ Soniox error:", response.error_message);
      return;
    }

    const tokens = response.tokens;
    if (!tokens || tokens.length === 0) return;

    // ✅ Only append FINAL tokens (prevents duplication)
    const finalTokens = tokens.filter(t => t.is_final);
    if (!finalTokens.length) return;

    const newText = finalTokens
      .map(t => t.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!newText) return;

    accumulatedText += (accumulatedText ? " " : "") + newText;

    console.log("📝 Sending transcript:", accumulatedText);

    try {
      vapiWs.send(JSON.stringify({
        type: "transcriber-response",
        transcription: accumulatedText,
        channel: "customer"
      }));
    } catch (err) {
      console.error("❌ Failed sending transcript to Vapi");
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy listening on port ${PORT}`);
});
