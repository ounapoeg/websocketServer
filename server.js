import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

/* -------------------- STEREO → MONO -------------------- */
// Vapi sends stereo linear16 (2ch interleaved). Soniox only needs customer
// audio (channel 0 = customer, channel 1 = assistant per Vapi docs).
// We extract only channel 0 (left = customer).
function extractMonoChannel(stereoBuf, channelIndex = 0) {
  const totalSamples = Math.floor(stereoBuf.length / 2); // total int16 samples
  const frames = Math.floor(totalSamples / 2);           // stereo frames
  const monoBuf = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    const sample = stereoBuf.readInt16LE((i * 2 + channelIndex) * 2);
    monoBuf.writeInt16LE(sample, i * 2);
  }
  return monoBuf;
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

  // Will be populated from Vapi's "start" message
  let sessionConfig = null;

  // Soniox connection — created after we receive the start message
  let sonioxWs = null;
  let accumulatedFinalText = "";
  let frameCount = 0;

  function connectToSoniox(sampleRate, channels) {
    console.log(`🔧 Connecting to Soniox: sampleRate=${sampleRate} vapiChannels=${channels}`);

    sonioxWs = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");

    sonioxWs.on("open", () => {
      console.log("✅ Connected to Soniox, sending config");
      sonioxWs.send(
        JSON.stringify({
          api_key: SONIOX_API_KEY,
          model: "stt-rt-preview",
          audio_format: "pcm_s16le",
          sample_rate: sampleRate,
          num_channels: 1,          // We extract mono customer channel before sending
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

    sonioxWs.on("message", (data) => {
      const raw = data.toString();
      console.log("📩 Soniox:", raw.slice(0, 200));

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

      // Final tokens arrive once and never repeat — accumulate them
      const newFinalText = tokens
        .filter((t) => t.is_final && t.text)
        .map((t) => t.text)
        .join("");

      // Non-final tokens reset every message
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
            channel: "customer",
          })
        );
      }
    });
  }

  /* -------- Vapi → Soniox -------- */
  vapiWs.on("message", (data, isBinary) => {
    // Handle JSON control messages from Vapi
    if (!isBinary) {
      const text = data.toString();
      console.log("📨 Vapi JSON:", text.slice(0, 300));

      try {
        const msg = JSON.parse(text);
        if (msg.type === "start") {
          sessionConfig = {
            sampleRate: msg.sampleRate || 16000,
            channels: msg.channels || 2,
          };
          console.log(`🚀 Got start message: sampleRate=${sessionConfig.sampleRate} channels=${sessionConfig.channels}`);
          connectToSoniox(sessionConfig.sampleRate, sessionConfig.channels);
        }
      } catch {}
      return;
    }

    // Binary audio data
    if (!sessionConfig) {
      console.warn("⚠️ Audio received before start message, dropping");
      return;
    }

    if (!sonioxWs || sonioxWs.readyState !== WebSocket.OPEN) return;

    frameCount++;

    // If stereo, extract customer channel (ch 0) only
    const audioToSend = sessionConfig.channels === 2
      ? extractMonoChannel(data, 0)
      : data;

    if (frameCount % 20 === 0) {
      const rms = rmsS16LE(audioToSend);
      console.log(`🔎 rms=${rms.toFixed(2)} bytes_in=${data.length} bytes_out=${audioToSend.length}`);
    }

    sonioxWs.send(audioToSend);
  });

  vapiWs.on("close", () => {
    console.log("🔌 Vapi closed");
    if (sonioxWs && sonioxWs.readyState === WebSocket.OPEN) {
      try {
        // Per Soniox docs: empty binary frame = end of audio
        sonioxWs.send(Buffer.alloc(0));
      } catch {}
    }
  });

  vapiWs.on("error", (err) => {
    console.error("❌ Vapi WS error:", err);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy listening on port ${PORT}`);
});
