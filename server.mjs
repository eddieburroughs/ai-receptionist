// server.mjs
import 'dotenv/config';
import express from 'express';
import http from 'http';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

// ========= CONFIG (your Render URL) =========
const RENDER_BASE = 'https://ai-receptionist-no7p.onrender.com'; // <-- your URL
const WSS_URL = RENDER_BASE.replace('https://','wss://') + '/twilio-media';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// =============== Healthcheck ===============
app.get('/', (_, res) => res.send('OK'));

// ========= Simple in-memory per-call store =========
const calls = new Map(); // callSid -> { lead:{}, priority:false, streamSid?:string }
const wsForCall = new Map(); // callSid -> ws (Twilio media)
const aiForCall = new Map(); // callSid -> ws (OpenAI)

// ====== TwiML entry: answer and start media stream ======
app.post('/voice', (req, res) => {
  const { CallSid } = req.body || {};
  calls.set(CallSid, { lead: {}, priority: false });

  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural' }, `Welcome to ${process.env.BUSINESS_NAME || 'RegularUpkeep.com'}. Connecting you now.`);

  const connect = twiml.connect();
  connect.stream({
    url: WSS_URL,
    statusCallback: `${RENDER_BASE}/stream-status`,
    statusCallbackMethod: 'POST'
    // NOTE: leaving default direction (inbound). We still send audio back.
  });

  console.log('[TwiML] Sent <Connect><Stream> to', WSS_URL);
  res.type('text/xml').send(twiml.toString());
});

// Optional: logs from Twilio about the stream lifecycle
app.post('/stream-status', (req, res) => {
  console.log('[StreamStatus]', new Date().toISOString(), req.body);
  res.sendStatus(200);
});

// ======= Transfer + Goodbye endpoints (used by AI triggers) =======
app.post('/transfer', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural' }, 'One moment while I connect you.');
  twiml.dial(process.env.TRANSFER_NUMBER);
  res.type('text/xml').send(twiml.toString());
});

app.post('/goodbye', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural' }, 'Thanks for calling. We’ll follow up shortly. Goodbye.');
  res.type('text/xml').send(twiml.toString());
});

// ================== Audio helpers (μ-law <-> PCM) ==================
function mulawDecode(mu) {
  const BIAS = 0x84;
  mu = ~mu & 0xFF;
  const sign = mu & 0x80;
  let exponent = (mu & 0x70) >> 4;
  let mantissa = mu & 0x0F;
  let sample = ((mantissa << 4) + 8) << (exponent + 3);
  sample -= BIAS;
  return sign ? -sample : sample;
}
function decodeMuLawBuffer(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawDecode(buf[i]);
  return out; // PCM16 @ 8k
}
function linear2ulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}
function encodeMuLawBufferFromPCM(int16) {
  const out = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = linear2ulaw(int16[i]);
  return out.toString('base64');
}
// naive up/down sampling (8k <-> 24k) for demo
function up8kTo24k(int16) {
  const out = new Int16Array(int16.length * 3);
  for (let i = 0; i < int16.length; i++) out[i*3] = out[i*3+1] = out[i*3+2] = int16[i];
  return out;
}
function down24kTo8k(int16) {
  const out = new Int16Array(Math.floor(int16.length / 3));
  for (let i = 0, j = 0; j < out.length; i += 3, j++) out[j] = int16[i];
  return out;
}

// ============== OpenAI Realtime WS helper ==============
function connectRealtime() {
  const url = 'wss://api.openai.com/v1/realtime?model=gpt-realtime'; // adjust model name if needed
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };
  return new WebSocket(url, { headers });
}

// ================== WebSocket bridge ===================
const wss = new WebSocketServer({ server, path: '/twilio-media' });

wss.on('connection', (twilioWs) => {
  console.log('[WS] Twilio media stream CONNECTED', new Date().toISOString());

  // Connect to OpenAI Realtime
  const ai = connectRealtime();

  // State captured from Twilio "start" event
  let callSid = '';
  let streamSid = '';

  // When OpenAI is ready, configure session (voice + rules)
  ai.on('open', () => {
    console.log('[AI] Realtime WS OPEN');
    const payload = {
      type: 'session.update',
      session: {
        instructions:
`You are a warm, efficient receptionist for ${process.env.BUSINESS_NAME || 'RegularUpkeep.com'}.
Speak briefly; allow interruptions. Collect:
- name, phone, address or ZIP, service (Plumbing/HVAC/Electrical/Handyman), preferred date + morning/afternoon, short details.
If caller asks for a person ("transfer", "operator", "agent"), stop speaking and output a single line: TRANSFER
When you have enough info, output a single line: DONE
Backchannel for developer (not spoken):
Emit lines like:
LEAD name=<...>; phone=<...>; address=<...>; service=<...>; preferred=<...>; details=<...>; priority=<true|false>`,
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad' }
      }
    };
    ai.send(JSON.stringify(payload));
  });

  ai.on('error', (e) => console.error('[AI] error', e.message));
  ai.on('close', () => console.log('[AI] Realtime WS CLOSED'));

  // From Twilio -> to OpenAI
  twilioWs.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === 'start') {
        callSid = data.start?.callSid || '';
        streamSid = data.start?.streamSid || '';
        wsForCall.set(callSid, twilioWs);
        aiForCall.set(callSid, ai);
        if (!calls.has(callSid)) calls.set(callSid, { lead: {}, priority: false });
        console.log('[Twilio] START callSid=', callSid, 'streamSid=', streamSid);
      }

      if (data.event === 'media') {
        // Caller audio (μ-law 8k) -> PCM 24k -> send to AI
        const pcm8 = decodeMuLawBuffer(data.media.payload);
        const pcm24 = up8kTo24k(pcm8);
        ai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm24.buffer).toString('base64') }));
        ai.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }

      if (data.event === 'mark') {
        // ignore keepalives
      }

      if (data.event === 'stop') {
        console.log('[Twilio] STOP for', callSid);
        try { ai.close(); } catch {}
        wsForCall.delete(callSid);
        aiForCall.delete(callSid);
      }
    } catch (e) {
      console.error('[Twilio] WS parse error', e.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('[WS] Twilio media stream CLOSED');
    try { ai.close(); } catch {}
  });

  // From OpenAI -> back to Twilio (AUDIO + control text)
  ai.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());

      // AUDIO back to caller
      if (msg.type === 'output_audio.delta' && msg.audio && streamSid) {
        const pcm24 = new Int16Array(Buffer.from(msg.audio, 'base64').buffer);
        const pcm8 = down24kTo8k(pcm24);
        const b64ulaw = encodeMuLawBufferFromPCM(pcm8);

        // IMPORTANT: include streamSid when sending audio to Twilio
        const frame = { event: 'media', streamSid, media: { payload: b64ulaw } };
        twilioWs.send(JSON.stringify(frame));
      }

      // TEXT: watch for LEAD / DONE / TRANSFER
      if (msg.type === 'output_text.delta' && msg.delta) {
        const line = msg.delta.trim();
        if (!line) return;

        // parse control words
        if (/^TRANSFER$/i.test(line) && callSid) {
          console.log('[CTRL] TRANSFER');
          twilioClient.calls(callSid).update({ url: `${RENDER_BASE}/transfer`, method: 'POST' })
            .catch(e => console.error('[CTRL] transfer failed', e.message));
          return;
        }
        if (/^DONE$/i.test(line) && callSid) {
          console.log('[CTRL] DONE -> goodbye');
          twilioClient.calls(callSid).update({ url: `${RENDER_BASE}/goodbye`, method: 'POST' })
            .catch(e => console.error('[CTRL] goodbye failed', e.message));
          return;
        }

        // very light LEAD capture (optional)
        if (/^LEAD\b/i.test(line) && callSid) {
          const entry = (calls.get(callSid) || { lead: {}, priority: false });
          const body = line.replace(/^LEAD\s*/i,'');
          body.split(';').forEach(pair => {
            const [k,v] = pair.split('=');
            if (!k) return;
            entry.lead[k.trim().toLowerCase()] = (v||'').trim();
          });
          if (String(entry.lead.priority||'').toLowerCase() === 'true') entry.priority = true;
          calls.set(callSid, entry);
          console.log('[LEAD]', entry.lead);
        }
      }
    } catch (e) {
      console.error('[AI] msg error', e.message);
    }
  });
});

server.listen(PORT, () => console.log(`Server listening on :${PORT}`));

