// server.mjs
import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import http from 'http';

/**
 * HIGH LEVEL:
 * - /voice returns TwiML that starts a <Connect><Stream> to wss://yourhost/twilio-media
 * - wss "/twilio-media" receives 8kHz mu-law audio chunks from Twilio (base64)
 * - we transcode to 24k PCM, forward to OpenAI Realtime over WS
 * - we receive AI audio back, transcode to 8k mu-law, and send to caller
 *
 * Notes:
 * Twilio Media Streams format: base64, mono, 8-bit, 8kHz μ-law (u-law) in 20ms frames.
 * Realtime expects linear PCM (often 24kHz). We keep the transcoding minimal for clarity here.
 * See docs: Twilio Media Streams (audio format) and OpenAI Realtime WS guides.
 */

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

// Simple health check
app.get('/', (_, res) => res.send('OK'));

/** 1) TwiML entry: tell Twilio to stream the call audio to our WS */
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();

  // Greet immediately (AI will take over)
  twiml.say({ voice: 'Polly.Joanna-Neural' }, `Welcome to ${process.env.BUSINESS_NAME}. One moment while I connect you.`);

  // Start a bidirectional media stream over WebSocket
  const connect = twiml.connect();
  connect.stream({
    url: `${publicWssUrl()}/twilio-media`,
    track: 'both_tracks',    // send caller audio; allow us to send audio back
    statusCallback: `${publicHttpUrl()}/stream-status`,
    statusCallbackMethod: 'POST'
  });

  res.type('text/xml').send(twiml.toString());
});

// optional: status logs
app.post('/stream-status', (req, res) => {
  console.log('Stream status:', req.body);
  res.sendStatus(200);
});

/** Helper: get your public URLs (dev uses ngrok; prod uses your domain) */
function publicHttpUrl() {
  // for local dev, paste your ngrok https URL here each time you start it
  return process.env.PUBLIC_HTTP_URL || `http://localhost:${PORT}`;
}
function publicWssUrl() {
  return (process.env.PUBLIC_WSS_URL || '').replace('https://', 'wss://').replace('http://', 'ws://') || `ws://localhost:${PORT}`;
}

const server = http.createServer(app);

/** 2) WebSocket server for Twilio Media Streams */
const wss = new WebSocketServer({ server, path: '/twilio-media' });

// --- naive μ-law <-> PCM helpers (you can swap with a proper audio lib later) ---
function mulawDecode(muLawByte) {
  // very small μ-law decoder: returns 16-bit PCM int
  const MULAW_MAX = 0x1FFF;
  const BIAS = 0x84;
  muLawByte = ~muLawByte;
  let sign = (muLawByte & 0x80);
  let exponent = (muLawByte & 0x70) >> 4;
  let mantissa = muLawByte & 0x0F;
  let sample = ((mantissa << 4) + 8) << (exponent + 3);
  sample -= BIAS;
  return sign ? -sample : sample;
}
function decodeMuLawBuffer(b64) {
  // Twilio gives base64 string of mu-law bytes (8kHz, mono)
  const buf = Buffer.from(b64, 'base64');
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawDecode(buf[i]);
  return out; // 16-bit PCM @ 8kHz
}
// very naive 8k -> 24k upsample (repeat samples 3x). Replace with proper resampler later.
function upsample8kTo24k(int16) {
  const out = new Int16Array(int16.length * 3);
  for (let i = 0; i < int16.length; i++) {
    out[i*3] = int16[i];
    out[i*3 + 1] = int16[i];
    out[i*3 + 2] = int16[i];
  }
  return out;
}

// back to μ-law for Twilio playback
function linear2ulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  let mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let ulawbyte = ~(sign | (exponent << 4) | mantissa);
  return ulawbyte & 0xFF;
}
function encodeMuLawBufferFromPCM(int16) {
  const out = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = linear2ulaw(int16[i]);
  return out.toString('base64');
}

// ----- OpenAI Realtime connection helper -----
function connectRealtimeWS() {
  // Official Realtime WebSocket endpoint (server-to-server)
  const url = 'wss://api.openai.com/v1/realtime?model=gpt-realtime'; // models may vary
  const headers = {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };
  return new WebSocket(url, { headers });
}

wss.on('connection', (twilioWs, req) => {
  console.log('Twilio media stream connected');

  // 1) connect to OpenAI Realtime
  const ai = connectRealtimeWS();

  // When OpenAI is ready, send a "session.update" to set voice + instructions
  ai.on('open', () => {
    const session = {
      type: 'session.update',
      session: {
        instructions: `You are a warm, efficient receptionist for ${process.env.BUSINESS_NAME}.
- Greet briefly, collect name, phone, service address (zip ok), service type (plumbing/HVAC/electrical/handyman), preferred date and morning/afternoon.
- If urgent (leak, no heat/AC, smoke/sparks), handle with urgency and be concise.
- Speak in short sentences. Allow caller to barge-in and you adjust politely.
- If caller asks for a human or says "transfer", say "One moment" and stop speaking.`,
        voice: 'alloy',            // choose any supported voice
        input_audio_format: 'pcm16',   // we send 24k PCM
        output_audio_format: 'pcm16',  // we expect 24k PCM back
        turn_detection: { type: 'server_vad' } // let model handle endpointing
      }
    };
    ai.send(JSON.stringify(session));
    console.log('Realtime session started');
  });

  // 2) receive audio frames from Twilio → decode → upsample → send to OpenAI
  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.event === 'media') {
        const pcm8k = decodeMuLawBuffer(data.media.payload);       // Int16Array 8k
        const pcm24k = upsample8kTo24k(pcm8k);                      // Int16Array 24k (naive)
        // send to OpenAI as "input_audio_buffer.append"
        ai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm24k.buffer).toString('base64') }));
        // tell OpenAI we’ve ended a chunk (helps barge-in)
        ai.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      } else if (data.event === 'start') {
        console.log('Twilio stream started');
      } else if (data.event === 'stop') {
        console.log('Twilio stream stopped');
        ai.close();
        twilioWs.close();
      }
    } catch (e) {
      console.error('Parse/stream error:', e);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WS closed');
    try { ai.close(); } catch {}
  });

  // 3) receive audio from OpenAI → downsample (simple) → μ-law encode → send back to Twilio
  ai.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // audio frames arrive as "output_audio.delta" with base64 PCM16@24k chunks
      if (msg.type === 'output_audio.delta' && msg.audio) {
        const pcm24k = new Int16Array(Buffer.from(msg.audio, 'base64').buffer);
        // naive 24k -> 8k downsample by dropping 2 of every 3 samples
        const pcm8k = new Int16Array(Math.floor(pcm24k.length / 3));
        for (let i = 0, j = 0; j < pcm8k.length; i += 3, j++) pcm8k[j] = pcm24k[i];

        const b64ulaw = encodeMuLawBufferFromPCM(pcm8k);
        // send to Twilio
        const twilioMsg = {
          event: 'media',
          media: { payload: b64ulaw }
        };
        twilioWs.send(JSON.stringify(twilioMsg));
      }

      // for logging/debug
      if (msg.type === 'output_text.delta' && msg.delta) {
        process.stdout.write(msg.delta);
      }
    } catch (e) {
      console.error('AI msg error:', e);
    }
  });

  ai.on('close', () => console.log('Realtime WS closed'));
  ai.on('error', (e) => console.error('Realtime WS error:', e));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on :${PORT}`));
