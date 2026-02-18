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
  res.end("ws proxy up");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (vapiWs) => {
  console.log("Vapi connected");

  if (!SONIOX_API_KEY) {
    console.error("Missing SONIOX_API_KEY");
    vapiWs.close(1011, "Missing SONIOX_API_KEY");
    return;
  }

  const sonioxWs = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");

  sonioxWs.on("open", () => {
    console.log("Connected to Soniox, sending config");
    sonioxWs.send(JSON.stringify({
      api_key: SONIOX_API_KEY,
      model: "stt-rt-preview",
      audio_format: "auto"
    }));
  });

  vapiWs.on("message", (data) => {
    if (sonioxWs.readyState === WebSocket.OPEN) sonioxWs.send(data);
  });

  sonioxWs.on("message", (data) => {
    try {
      const response = JSON.parse(data.toString());
      if (response.tokens?.length) {
        const text = response.tokens.map(t => t.text).join(" ");
        const isFinal = response.tokens.some(t => t.is_final);
        vapiWs.send(JSON.stringify({ transcript: text, isFinal }));
      }
    } catch (e) {
      console.error("Soniox parse error", e);
    }
  });

  vapiWs.on("close", () => sonioxWs.close());
  sonioxWs.on("close", () => vapiWs.close());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP+WS server listening on ${PORT}`);
});
