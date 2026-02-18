import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

if (!SONIOX_API_KEY) {
  console.error("SONIOX_API_KEY is required");
}

const server = new WebSocketServer({ port: PORT });

server.on("connection", (vapiWs) => {
  const sonioxWs = new WebSocket(
    "wss://stt-rt.soniox.com/transcribe-websocket"
  );

  sonioxWs.on("open", () => {
    // ✅ Send required Soniox config FIRST
    sonioxWs.send(
      JSON.stringify({
        api_key: SONIOX_API_KEY,
        model: "stt-rt-preview",
        audio_format: "auto"
      })
    );
  });

  // ✅ Forward audio from Vapi → Soniox
  vapiWs.on("message", (data) => {
    if (sonioxWs.readyState === WebSocket.OPEN) {
      sonioxWs.send(data);
    }
  });

  // ✅ Convert Soniox → Vapi format
  sonioxWs.on("message", (data) => {
    try {
      const response = JSON.parse(data.toString());

      if (response.tokens?.length) {
        const text = response.tokens.map(t => t.text).join(" ");
        const isFinal = response.tokens.some(t => t.is_final);

        vapiWs.send(
          JSON.stringify({
            transcript: text,
            isFinal: isFinal
          })
        );
      }
    } catch (e) {
      console.error("Parse error:", e);
    }
  });

  vapiWs.on("close", () => sonioxWs.close());
  sonioxWs.on("close", () => vapiWs.close());
});

console.log(`Proxy running on port ${PORT}`);
