// server.mjs
import 'dotenv/config';
import express from 'express';
import http from 'http';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import fetch from 'node-fetch'; // Node 20+ has global fetch; import for compatibility

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// --- simple in-memory state ---
const calls = new Map();           // callSid -> { lead:{}, priority:false }
const streams = new Map();         // ws -> { callSid }
const wsByCall = new Map();        // callSid -> ws

function publicBase() {
  const url = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  return url.replace(/\/+$/, '');
}

// ============ 1) TwiML entry: start Connect<Stream> ============
app.post('/voice', (req, res) => {
  const { CallSid } = req.body || {};
  calls.set(CallSid, { lead: {}, priority: false });

  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural' }, `Welcome to ${process.env.BUSINESS_NAME}. Connecting you now.`);

  const connect = twiml.connect();
  connect.stream({
    url: `${publicBase().replace('https://','wss://').replace('http://','ws://')}/twilio-media`,
    track: 'both_tracks',
    statusCallback: `${publicBase()}/stream-status`,
    statusCallbackMethod: 'POST'
  });

  res.type('text/xml').send(twiml.toString());
});

app.post('/stream-status', (req, res) => res.sendStatus(200));

// ============ 2) Transfer endpoint (used when caller says "transfer") ============
app.post('/transfer', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural' }, 'One moment while I connect you.');
  twiml.dial(process.env.TRANSFER_NUMBER);
  res.type('text/xml').send(twiml.toString());
});

// ============ 3) Goodbye endpoint (optional end) ============
app.post('/goodbye', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural' }, 'Thanks for calling. We’ll follow up shortly. Goodbye.');
  res.type('text/xml').send(twiml.toString());
});

// ============ 4) WebSocket bridge: Twilio <-> OpenAI Realtime ============
const wss = new WebSocketServer({ server, path: '/twilio-media' });

// ---- tiny μ-law helpers (same as before) ----
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
  return out;
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
// naive up/down sample
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

// ---- OpenAI Realtime connect ----
function connectRealtime() {
  const url = 'wss://api.openai.com/v1/realtime?model=gpt-realtime';
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };
  return new WebSocket(url, { headers });
}

// ---- parse “LEAD:” lines the AI emits (backchannel) ----
function parseLeadLine(line) {
  // Example: LEAD name=Jane Doe; phone=252-555-0134; address=27893; service=HVAC; preferred=Tomorrow PM; details=AC not cooling; priority=true
  const out = {};
  const body = line.replace(/^LEAD\s*/i,'');
  body.split(';').forEach(pair => {
    const [k,v] = pair.split('=');
    if (!k) return;
    out[k.trim().toLowerCase()] = (v||'').trim();
  });
  return out;
}

// ---- summarize via SMS + Google Form drop ----
async function finalizeLeadAndNotify(callSid) {
  const state = calls.get(callSid);
  if (!state) return;
  const { lead = {}, priority = false } = state;

  const text =
`New ${priority ? 'PRIORITY ' : ''}lead:
Name: ${lead.name||'?'}
Phone: ${lead.phone||'?'}
Address: ${lead.address||'?'}
Service: ${lead.service||'?'}
Preferred: ${lead.preferred||'?'}
Details: ${lead.details||'?'}
CallSid: ${callSid}`;

  // SMS (optional)
  if (process.env.ALERT_SMS_TO && process.env.ALERT_SMS_FROM) {
    try {
      await twilioClient.messages.create({
        to: process.env.ALERT_SMS_TO,
        from: process.env.ALERT_SMS_FROM,
        body: text
      });
    } catch (e) { console.error('SMS failed', e.message); }
  }

  // Google Form drop (optional)
  const action = process.env.GOOGLE_FORM_ACTION_URL;
  const mapping = process.env.GOOGLE_FORM_FIELDS || '';
  if (action && mapping) {
    const mapObj = Object.fromEntries(mapping.split('&').map(x => x.split('=')));
    const form = new URLSearchParams();
    form.append(mapObj.name || 'entry.1', lead.name || '');
    form.append(mapObj.phone || 'entry.2', lead.phone || '');
    form.append(mapObj.address || 'entry.3', lead.address || '');
    form.append(mapObj.service || 'entry.4', lead.service || '');
    form.append(mapObj.preferred || 'entry.5', lead.preferred || '');
    form.append(mapObj.details || 'entry.6', lead.details || '');
    form.append(mapObj.priority || 'entry.7', (priority ? 'TRUE' : 'FALSE'));
    try {
      await fetch(action, { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
    } catch(e) { console.error('Form post failed', e.message); }
  }
}

wss.on('connection', (twilioWs) => {
  // Connect AI
  const ai = connectRealtime();

  // wire up
  ai.on('open', () => {
    // instructions tell the model to emit LEAD lines & TRANSFER / DONE signals
    const payload = {
      type: 'session.update',
      session: {
        instructions:
`You are a warm, efficient receptionist for ${process.env.BUSINESS_NAME}.
Speak briefly, allow interruptions. Collect:
- name, phone, address or ZIP, service (Plumbing/HVAC/Electrical/Handyman), preferred date + morning/afternoon, short details.
If caller says anything like "transfer", "operator", "person", stop speaking and output a single line: TRANSFER.
If the issue is urgent (leak, no heat/AC, smoke/sparks, burning smell), mark priority true.

Backchannel for the developer (do NOT read aloud):
Whenever you confirm new info, output one line starting with:
LEAD name=<...>; phone=<...>; address=<...>; service=<...>; preferred=<...>; details=<...>; priority=<true|false>
When you have enough info, output a single line: DONE`,
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad' }
      }
    };
    ai.send(JSON.stringify(payload));
  });

  // Receive audio from Twilio -> send to AI
  twilioWs.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.event === 'start') {
        const callSid = data.start?.callSid;
        if (callSid) {
          streams.set(twilioWs, { callSid });
          wsByCall.set(callSid, twilioWs);
          if (!calls.has(callSid)) calls.set(callSid, { lead: {}, priority: false });
          console.log('Stream started for', callSid);
        }
      }
      if (data.event === 'media') {
        const pcm8 = decodeMuLawBuffer(data.media.payload);
        const pcm24 = up8kTo24k(pcm8);
        ai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm24.buffer).toString('base64') }));
        ai.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }
      if (data.event === 'stop') {
        const callSid = streams.get(twilioWs)?.callSid;
        if (callSid) finalizeLeadAndNotify(callSid);
        try { ai.close(); } catch {}
        streams.delete(twilioWs);
        console.log('Stream stopped');
      }
    } catch (e) {
      console.error('Twilio WS parse error', e.message);
    }
  });

  twilioWs.on('close', () => {
    const callSid = streams.get(twilioWs)?.callSid;
    if (callSid) finalizeLeadAndNotify(callSid);
    try { ai.close(); } catch {}
    streams.delete(twilioWs);
  });

  // Receive from AI -> play to caller & watch for control lines
  ai.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());

      // audio chunks back to caller
      if (msg.type === 'output_audio.delta' && msg.audio) {
        const pcm24 = new Int16Array(Buffer.from(msg.audio, 'base64').buffer);
        const pcm8 = down24kTo8k(pcm24);
        const b64ulaw = encodeMuLawBufferFromPCM(pcm8);
        twilioWs.send(JSON.stringify({ event: 'media', media: { payload: b64ulaw } }));
      }

      // read model text to catch LEAD / DONE / TRANSFER lines
      if (msg.type === 'output_text.delta' && msg.delta) {
        const line = msg.delta.trim();

        // Which call is this for?
        const callSid = streams.get(twilioWs)?.callSid;
        if (!callSid) return;

        // BACKCHANNEL parsing
        if (/^LEAD\b/i.test(line)) {
          const found = parseLeadLine(line);
          const st = calls.get(callSid) || { lead: {}, priority: false };
          st.lead = { ...st.lead, ...found };
          if (String(found.priority || '').toLowerCase() === 'true') st.priority = true;
          calls.set(callSid, st);
        } else if (/^TRANSFER$/i.test(line)) {
          // Redirect live call to /transfer
          twilioClient.calls(callSid).update({ url: `${publicBase()}/transfer`, method: 'POST' }).catch(e => console.error('Transfer failed', e.message));
        } else if (/^DONE$/i.test(line)) {
          // End gracefully
          twilioClient.calls(callSid).update({ url: `${publicBase()}/goodbye`, method: 'POST' }).catch(e => console.error('Goodbye failed', e.message));
        }

        // Emergency hint if keywords appear in AI text (belt-and-suspenders)
        if (/(leak|flood|no heat|no ac|smoke|sparks|burning)/i.test(line)) {
          const st = calls.get(callSid) || { lead: {}, priority: false };
          st.priority = true; calls.set(callSid, st);
        }
      }
    } catch (e) {
      console.error('AI msg error', e.message);
    }
  });

  ai.on('close', () => console.log('Realtime WS closed'));
  ai.on('error', (e) => console.error('Realtime WS error', e.message));
});

server.listen(PORT, () => console.log(`Server listening on :${PORT}`));

