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

    sonioxWs.send(JSON.stringify({
  api_key: SONIOX_API_KEY,
  model: "stt-rt-v4",
  audio_format: "pcm_s16le",
  sample_rate: 48000,
  num_channels: 1,
  language_hints: ["en", "et"],
  enable_endpoint_detection: true
}));

  sonioxWs.on("error", (err) => {
    console.error("❌ Soniox WebSocket error:", err);
    try {
      vapiWs.close(1011, "Soniox connection error");
    } catch {}
  });

  sonioxWs.on("close", (code, reason) => {
    console.log("🔌 Soniox closed", code, reason?.toString());
    try {
      vapiWs.close();
    } catch {}
  });

  // Vapi -> Soniox (audio)
  vapiWs.on("message", (data) => {
    if (Buffer.isBuffer(data)) {
      console.log("🎤 Audio chunk:", data.length, "bytes");
    } else {
      console.log("📨 Non-binary from Vapi:", data.toString().slice(0, 200));
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
    console.error("❌ Vapi WebSocket error:", err);
    try {
      sonioxWs.close();
    } catch {}
  });

  // Soniox -> Vapi (transcripts)
  sonioxWs.on("message", (data) => {
    const raw = data.toString();
    console.log("📩 Soniox response:", raw.slice(0, 300));

    let response;
    try {
      response = JSON.parse(raw);
    } catch (err) {
      console.error("❌ Soniox JSON parse error", err);
      return;
    }

    // Soniox errors
    if (response.error_code) {
      console.error("❌ Soniox error:", response.error_code, response.error_message);
      try {
        vapiWs.close(1011, response.error_message || "Soniox error");
      } catch {}
      try {
        sonioxWs.close();
      } catch {}
      return;
    }

    const tokens = response.tokens;
    if (!tokens || tokens.length === 0) return;

    const transcript = tokens
      .map((t) => t.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const isFinal = tokens.some((t) => t.is_final);

    if (!transcript) return;

    console.log("📝 Sending transcript to Vapi:", transcript, "final:", isFinal);

    try {
  vapiWs.send(
    JSON.stringify({
      type: "transcriber-response",
      transcription: transcript,
      channel: "customer"
    })
  );
} catch (err) {
  console.error("❌ Failed sending transcript to Vapi", err);
}
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy listening on port ${PORT}`);
});
