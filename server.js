import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("soniox-vapi-ws-proxy up");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (vapiWs, req) => {
  console.log("✅ Vapi connected");

  if (!SONIOX_API_KEY) {
    console.error("❌ Missing SONIOX_API_KEY");
    vapiWs.close(1011, "Missing SONIOX_API_KEY");
    return;
  }

  const sonioxWs = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");

  sonioxWs.on("open", () => {
    console.log("✅ Connected to Soniox, sending config");

    // ✅ IMPORTANT: raw PCM config matching Vapi audio
    sonioxWs.send(
      JSON.stringify({
        api_key: SONIOX_API_KEY,
        model: "stt-rt-v4",
        audio_format: "pcm_s16le",
        sample_rate: 16000,
        num_channels: 1,
        language_hints: ["en", "et"],
        enable_endpoint_detection: true
      })
    );
  });

  sonioxWs.on("error", (err) => {
    console.error("❌ Soniox WebSocket error:", err);
    vapiWs.close(1011, "Soniox connection error");
  });

  sonioxWs.on("close", (code, reason) => {
    console.log("🔌 Soniox closed", code, reason?.toString());
    vapiWs.close();
  });

  // ✅ Forward binary audio frames from Vapi → Soniox
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
    sonioxWs.close();
  });

  vapiWs.on("error", (err) => {
    console.error("❌ Vapi WebSocket error:", err);
    sonioxWs.close();
  });

  // ✅ Handle Soniox responses
  sonioxWs.on("message", (data) => {
    const raw = data.toString();
    console.log("📩 Soniox response:", raw.slice(0, 300));

    let response;
    try {
      response = JSON.parse(raw);
    } catch (err) {
      console.error("❌ Soniox JSON parse error");
      return;
    }

    // ✅ Handle Soniox error messages
    if (response.error_code) {
      console.error(
        "❌ Soniox error:",
        response.error_code,
        response.error_message
      );
      vapiWs.close(1011, response.error_message);
      sonioxWs.close();
      return;
    }

    // ✅ Only emit FINAL transcripts to Vapi
    const tokens = response.tokens;
if (!tokens?.length) return;

const transcript = tokens
  .map(t => t.text)
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

const isFinal = tokens.some(t => t.is_final);

vapiWs.send(JSON.stringify({ transcript, isFinal }));
    if (!finalTokens?.length) return;

    const transcript = finalTokens
      .map(t => t.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!transcript) return;

    console.log("📝 Sending transcript to Vapi:", transcript);

    vapiWs.send(
      JSON.stringify({
        transcript,
        isFinal: true
      })
    );
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy listening on port ${PORT}`);
});
