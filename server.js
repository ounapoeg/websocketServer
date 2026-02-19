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
  let customerSonioxWs = null;
  let assistantSonioxWs = null;

  /* -------------------- SONIOX FACTORY -------------------- */
  function createSonioxConnection(sampleRate, channelLabel) {
    const ws = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");

    // Accumulates only final tokens. Reset after each <end> boundary.
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

      // Only accumulate final tokens — these are stable, committed words.
      // We intentionally ignore non-final (partial) tokens entirely.
      // Sending partials to Vapi caused the growing blob of repeated text.
      const newFinals = tokens
        .filter((t) => t.is_final && t.text)
        .map((t) => t.text)
        .join("");

      if (newFinals) {
        accumulated += newFinals;
        console.log(`📝 [${channelLabel}] accumulated: "${accumulated.slice(-80)}"`);
      }

      // <end> is Soniox's sentence boundary marker.
      // Only send to Vapi when a complete sentence is ready.
      // Loop handles multiple <end> markers in one message (rare but possible).
      while (accumulated.includes("<end>")) {
        const endIdx = accumulated.indexOf("<end>");
        const utterance = accumulated.slice(0, endIdx).trim();
        accumulated = accumulated.slice(endIdx + 5); // advance past "<end>"

        if (utterance && vapiWs.readyState === WebSocket.OPEN) {
          console.log(`📤 [${channelLabel}] → Vapi: "${utterance}"`);
          vapiWs.send(
            JSON.stringify({
              type: "transcriber-response",
              transcription: utterance,
              channel: channelLabel,
            })
          );
        }
      }
    });

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
