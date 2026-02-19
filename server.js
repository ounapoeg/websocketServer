import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;

/* -------------------- STEREO → MONO -------------------- */
function extractMonoChannel(stereoBuf, channelIndex = 0) {
  const totalSamples = Math.floor(stereoBuf.length / 2);
  const frames = Math.floor(totalSamples / 2);
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

  let sessionConfig = null;
  let frameCount = 0;

  // ---- Customer channel (ch 0) ----
  let customerSonioxWs = null;
  let customerAccumulated = "";

  // ---- Assistant channel (ch 1) ----
  let assistantSonioxWs = null;
  let assistantAccumulated = "";

  /* -------------------- SONIOX FACTORY -------------------- */
  function createSonioxConnection(sampleRate, channelLabel) {
    const ws = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");
    let accumulated = "";

    ws.on("open", () => {
      console.log(`✅ Soniox [${channelLabel}] connected`);
      ws.send(
        JSON.stringify({
          api_key: SONIOX_API_KEY,
          model: "stt-rt-preview",
          audio_format: "pcm_s16le",
          sample_rate: sampleRate,
          num_channels: 1,
          language_hints: ["et"],
          language_hints_strict: true,
          enable_endpoint_detection: true,
        })
      );
    });

    ws.on("error", (err) => {
      console.error(`❌ Soniox [${channelLabel}] error:`, err.message);
    });

    ws.on("close", (code) => {
      console.log(`🔌 Soniox [${channelLabel}] closed (${code})`);
    });

    ws.on("message", (data) => {
      let response;
      try {
        response = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (response.error_code) {
        console.error(`❌ Soniox [${channelLabel}] error:`, response.error_message);
        return;
      }

      if (response.finished) {
        console.log(`✅ Soniox [${channelLabel}] session finished`);
        return;
      }

      const tokens = response.tokens;
      if (!tokens || tokens.length === 0) return;

      // Accumulate final tokens
      const newFinals = tokens
        .filter((t) => t.is_final && t.text)
        .map((t) => t.text)
        .join("");

      const partials = tokens
        .filter((t) => !t.is_final && t.text)
        .map((t) => t.text)
        .join("");

      if (newFinals) accumulated += newFinals;

      const fullHypothesis = (accumulated + partials).replace(/\s+/g, " ").trim();
      if (!fullHypothesis) return;

      // Send partial updates to Vapi for responsiveness
      if (vapiWs.readyState === WebSocket.OPEN) {
        vapiWs.send(
          JSON.stringify({
            type: "transcriber-response",
            transcription: fullHypothesis,
            channel: channelLabel,
          })
        );
        console.log(`📤 [${channelLabel}] → Vapi: "${fullHypothesis.slice(0, 80)}"`);
      }

      // When Soniox signals end of utterance (<end>), reset accumulator
      // so next utterance starts fresh
      if (accumulated.includes("<end>")) {
        const cleaned = accumulated.replace(/<end>/g, "").trim();
        console.log(`✅ [${channelLabel}] utterance complete: "${cleaned}"`);
        accumulated = "";

        // Send the clean final version one more time
        if (cleaned && vapiWs.readyState === WebSocket.OPEN) {
          vapiWs.send(
            JSON.stringify({
              type: "transcriber-response",
              transcription: cleaned,
              channel: channelLabel,
            })
          );
        }
      }
    });

    // Expose accumulated for external reset if needed
    ws._getAccumulated = () => accumulated;
    ws._resetAccumulated = () => { accumulated = ""; };

    return ws;
  }

  /* -------------------- CONNECT BOTH CHANNELS -------------------- */
  function connectToSoniox(sampleRate) {
    console.log(`🔧 Starting dual Soniox connections at ${sampleRate}Hz`);
    customerSonioxWs = createSonioxConnection(sampleRate, "customer");
    assistantSonioxWs = createSonioxConnection(sampleRate, "assistant");
  }

  /* -------------------- VAPI → SONIOX -------------------- */
  vapiWs.on("message", (data, isBinary) => {
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
          console.log(`🚀 Start: sampleRate=${sessionConfig.sampleRate} channels=${sessionConfig.channels}`);
          connectToSoniox(sessionConfig.sampleRate);
        }
      } catch {}
      return;
    }

    if (!sessionConfig) {
      console.warn("⚠️ Audio before start message, dropping");
      return;
    }

    frameCount++;

    if (sessionConfig.channels === 2) {
      // Extract and route each channel independently
      const customerAudio = extractMonoChannel(data, 0);
      const assistantAudio = extractMonoChannel(data, 1);

      if (customerSonioxWs?.readyState === WebSocket.OPEN) {
        customerSonioxWs.send(customerAudio);
      }
      if (assistantSonioxWs?.readyState === WebSocket.OPEN) {
        assistantSonioxWs.send(assistantAudio);
      }

      if (frameCount % 20 === 0) {
        const rms = rmsS16LE(customerAudio);
        console.log(`🔎 [customer] rms=${rms.toFixed(2)} bytes_in=${data.length} bytes_out=${customerAudio.length}`);
      }
    } else {
      // Mono — send to customer only
      if (customerSonioxWs?.readyState === WebSocket.OPEN) {
        customerSonioxWs.send(data);
      }
    }
  });

  /* -------------------- CLEANUP -------------------- */
  vapiWs.on("close", () => {
    console.log("🔌 Vapi closed");
    const endFrame = Buffer.alloc(0);
    try {
      if (customerSonioxWs?.readyState === WebSocket.OPEN) customerSonioxWs.send(endFrame);
    } catch {}
    try {
      if (assistantSonioxWs?.readyState === WebSocket.OPEN) assistantSonioxWs.send(endFrame);
    } catch {}
  });

  vapiWs.on("error", (err) => {
    console.error("❌ Vapi WS error:", err);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy listening on port ${PORT}`);
});
