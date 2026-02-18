// server.js
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
  console.log("Vapi connected", {
    ip: req.socket.remoteAddress,
    ua: req.headers["user-agent"],
  });

  if (!SONIOX_API_KEY) {
    console.error("Missing SONIOX_API_KEY");
    vapiWs.close(1011, "Missing SONIOX_API_KEY");
    return;
  }

  const sonioxWs = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");

  sonioxWs.on("open", () => {
    console.log("Connected to Soniox, sending config");
    sonioxWs.send(
      JSON.stringify({
        api_key: SONIOX_API_KEY,
        model: "stt-rt-preview",
        audio_format: "auto",
        enable_endpoint_detection: true,
      })
    );
  });

  sonioxWs.on("close", (code, reason) => {
    console.log("Soniox closed", { code, reason: reason?.toString?.() });
    try {
      vapiWs.close();
    } catch {}
  });

  sonioxWs.on("error", (err) => {
    console.error("Soniox ws error", err);
    try {
      vapiWs.close(1011, "Soniox ws error");
    } catch {}
  });

  // Vapi -> Soniox (audio frames)
  vapiWs.on("message", (data) => {
    const isBinary = Buffer.isBuffer(data);
    console.log(
      "Received from Vapi:",
      isBinary ? `binary ${data.length} bytes` : `text ${data.toString().slice(0, 120)}`
    );

    if (sonioxWs.readyState === WebSocket.OPEN) {
      sonioxWs.send(data);
    }
  });

  vapiWs.on("close", (code, reason) => {
    console.log("Vapi closed", { code, reason: reason?.toString?.() });
    try {
      sonioxWs.close();
    } catch {}
  });

  vapiWs.on("error", (err) => {
    console.error("Vapi ws error", err);
    try {
      sonioxWs.close();
    } catch {}
  });

  // Soniox -> Vapi (transcript frames)
  sonioxWs.on("message", (data) => {
    const raw = data.toString();
    console.log("Received from Soniox:", raw.slice(0, 300));

    let response;
    try {
      response = JSON.parse(raw);
    } catch (e) {
      console.error("Soniox JSON parse error", e);
      return;
    }

    // Keep it simple + compatible: only emit FINAL transcripts to Vapi.
    const finalTokens = response.tokens?.filter((t) => t && t.is_final);
    if (!finalTokens?.length) return;

    // Join token texts with spaces; trim to avoid double spaces.
    const transcript = finalTokens
      .map((t) => t.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!transcript) return;

    try {
      vapiWs.send(JSON.stringify({ transcript, isFinal: true }));
    } catch (e) {
      console.error("Failed sending transcript to Vapi", e);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP+WS proxy listening on ${PORT}`);
});
