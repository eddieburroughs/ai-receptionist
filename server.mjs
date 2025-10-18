// server.mjs
import 'dotenv/config';
import express from 'express';
import http from 'http';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

/* ========================== CONFIG ========================== */
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://ai-receptionist-no7p.onrender.com').replace(/\/+$/, '');
const STREAM_WSS   = PUBLIC_BASE.replace('https://','wss://') + '/twilio-media';
const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-mini'; // snappier bring-up
const BUSINESS       = process.env.BUSINESS_NAME || 'RegularUpkeep.com';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;
const twilioClient  = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

/* ========================= HEALTH ========================== */
app.get('/', (_, res) => res.send('OK'));

/* ================== AUDIO HELPERS (μ-law) ================== */
function mulawDecode(mu){const BIAS=0x84;mu=~mu&0xff;const sign=mu&0x80;let exponent=(mu&0x70)>>4;let mantissa=mu&0x0f;let sample=((mantissa<<4)+8)<<(exponent+3);sample-=BIAS;return sign?-sample:sample;}
function decodeMuLawBuffer(b64){const buf=Buffer.from(b64,'base64');const out=new Int16Array(buf.length);for(let i=0;i<buf.length;i++)out[i]=mulawDecode(buf[i]);return out;}
function linear2ulaw(sample){const BIAS=0x84,CLIP=32635;let sign=(sample>>8)&0x80;if(sign!==0)sample=-sample;if(sample>CLIP)sample=CLIP;sample+=BIAS;let exponent=7;for(let m=0x4000;(sample&m)===0&&exponent>0;exponent--,m>>=1){}const mantissa=(sample>>((exponent===0)?4:(exponent+3)))&0x0f;return(~(sign|(exponent<<4)|mantissa))&0xff;}
function encodeMuLawBufferFromPCM(int16){const out=Buffer.alloc(int16.length);for(let i=0;i<int16.length;i++)out[i]=linear2ulaw(int16[i]);return out.toString('base64');}
function up8kTo24k(int16){const out=new Int16Array(int16.length*3);for(let i=0;i<int16.length;i++){out[i*3]=out[i*3+1]=out[i*3+2]=int16[i];}return out;}
function down24kTo8k(int16){const out=new Int16Array(Math.floor(int16.length/3));for(let i=0,j=0;j<out.length;i+=3,j++)out[j]=int16[i];return out;}
function ulawSilenceB64(){return Buffer.alloc(160,0xFF).toString('base64');} // 20ms @ 8kHz

/* ================= OPENAI REALTIME (GLOBAL) ================= */
// Keep one warm Realtime socket for snappy first audio.
// Single-call assumption for now.
let globalAI = null;
let aiReady  = false;

function connectRealtime() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
  return new WebSocket(url, { headers });
}

function ensureGlobalAI() {
  if (globalAI && globalAI.readyState === 1) return;
  aiReady = false;
  globalAI = connectRealtime();

  globalAI.on('open', () => {
    aiReady = true;
    console.log('[AI] GLOBAL OPEN');
    // configure once
    const payload = {
      type: 'session.update',
      session: {
        instructions:
`You are a warm, efficient receptionist for ${BUSINESS}.
Speak briefly; allow interruptions. Collect:
- name, phone, address or ZIP, service (Plumbing/HVAC/Electrical/Handyman), preferred date + morning/afternoon, short details.
If caller asks for a person ("transfer", "operator", "agent"), stop speaking and output a single line: TRANSFER
When you have enough info, output a single line: DONE
Backchannel (not spoken):
Emit lines like:
LEAD name=<...>; phone=<...>; address=<...>; service=<...>; preferred=<...>; details=<...>; priority=<true|false>`,
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad' }
      }
    };
    try { globalAI.send(JSON.stringify(payload)); } catch {}
  });

  globalAI.on('ping', d => { try { globalAI.pong(d); } catch {} });
  globalAI.on('error', e => console.error('[AI] GLOBAL error', e.message));
  globalAI.on('close', () => {
    aiReady = false;
    console.log('[AI] GLOBAL CLOSED — reconnecting in 1s');
    setTimeout(ensureGlobalAI, 1000);
  });
}

// warm it at boot and keep it warm
ensureGlobalAI();
setInterval(ensureGlobalAI, 60_000); // safety re-check

/* =================== VOICE ENTRY / TWIML =================== */
app.post('/voice', (req, res) => {
  // make sure AI is warming before Twilio starts the stream
  ensureGlobalAI();

  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural' }, `Welcome to ${BUSINESS}. Connecting you now.`);

  const connect = twiml.connect();
  connect.stream({
    url: STREAM_WSS,
    statusCallback: `${PUBLIC_BASE}/stream-status`,
    statusCallbackMethod: 'POST'
    // no `track` needed; <Connect><Stream> is bidirectional.
  });

  console.log('[TwiML] <Connect><Stream> →', STREAM_WSS);
  res.type('text/xml').send(twiml.toString());
});

app.post('/stream-status', (req, res) => {
  console.log('[StreamStatus]', new Date().toISOString(), req.body);
  res.sendStatus(200);
});

/* ============== TRANSFER / GOODBYE TWIML =================== */
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

/* =================== WS BRIDGE (MEDIA) ==================== */
const wss = new WebSocketServer({ server, path: '/twilio-media' });

wss.on('connection', (twilioWs) => {
  console.log('[WS] Twilio media CONNECTED', new Date().toISOString());

  // per-connection state
  let stopped = false;
  let callSid = '';
  let streamSid = '';
  let keepAlive = null;
  let sentRealAudio = false;
  const pendingAudioToAI = []; // base64 PCM24 queued while AI not yet ready

  // Twilio -> AI (global)
  twilioWs.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === 'start') {
        callSid   = data.start?.callSid   || '';
        streamSid = data.start?.streamSid || '';
        console.log('[Twilio] START callSid=', callSid, 'streamSid=', streamSid);

        // start 20ms keep-alive silence until AI actually speaks
        if (!keepAlive) {
          const silence = ulawSilenceB64();
          keepAlive = setInterval(() => {
            if (stopped) return;
            if (twilioWs.readyState === 1 && streamSid && !sentRealAudio) {
              twilioWs.send(JSON.stringify({ event:'media', streamSid, media:{ payload: silence }}));
            }
          }, 20);
          console.log('[KeepAlive] started (20ms)');
        }

        // if AI is ready, proactively ask it to speak now
        if (globalAI && aiReady && globalAI.readyState === 1) {
          try {
            globalAI.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['audio'],
                instructions: 'Hi! I’m the RegularUpkeep assistant. How can I help you today?'
              }
            }));
          } catch {}
        }
      }

      if (data.event === 'media') {
        // caller audio to AI (queue if AI not ready yet)
        const pcm8  = decodeMuLawBuffer(data.media.payload);
        const pcm24 = up8kTo24k(pcm8);
        const b64   = Buffer.from(pcm24.buffer).toString('base64');

        if (globalAI && aiReady && globalAI.readyState === 1 && !stopped) {
          try {
            globalAI.send(JSON.stringify({ type:'input_audio_buffer.append', audio:b64 }));
            globalAI.send(JSON.stringify({ type:'input_audio_buffer.commit' }));
          } catch (e) {
            pendingAudioToAI.push(b64);
          }
        } else {
          pendingAudioToAI.push(b64);
        }
      }

      if (data.event === 'stop') {
        stopped = true;
        console.log('[Twilio] STOP', callSid);
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; console.log('[KeepAlive] stopped'); }
      }
    } catch (e) {
      console.error('[Bridge] Twilio message handler error:', e.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('[WS] Twilio media CLOSED');
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  });

  // AI -> Twilio (audio + control/backchannel)
  if (globalAI) {
    globalAI.on('message', onAIMessage);
  }

  function onAIMessage(buf) {
    if (stopped) return;
    try {
      const msg = JSON.parse(buf.toString());

      // AUDIO back to caller
      if (msg.type === 'output_audio.delta' && msg.audio) {
        if (streamSid && twilioWs.readyState === 1) {
          const pcm24 = new Int16Array(Buffer.from(msg.audio, 'base64').buffer);
          const pcm8  = down24kTo8k(pcm24);
          const b64ulaw = encodeMuLawBufferFromPCM(pcm8);

          if (!sentRealAudio && keepAlive) {
            clearInterval(keepAlive);
            keepAlive = null;
            sentRealAudio = true;
            console.log('[KeepAlive] stopped (AI speaking)');
          }

          twilioWs.send(JSON.stringify({ event:'media', streamSid, media:{ payload: b64ulaw }}));
        }
      }

      // TEXT controls
      if (msg.type === 'output_text.delta' && msg.delta) {
        const line = msg.delta.trim();
        if (!line) return;

        if (/^TRANSFER$/i.test(line) && callSid) {
          console.log('[CTRL] TRANSFER');
          twilioClient.calls(callSid)
            .update({ url: `${PUBLIC_BASE}/transfer`, method: 'POST' })
            .catch(e => console.error('[CTRL] transfer failed', e.message));
          return;
        }

        if (/^DONE$/i.test(line) && callSid) {
          console.log('[CTRL] DONE → goodbye');
          twilioClient.calls(callSid)
            .update({ url: `${PUBLIC_BASE}/goodbye`, method: 'POST' })
            .catch(e => console.error('[CTRL] goodbye failed', e.message));
          return;
        }

        if (/^LEAD\b/i.test(line)) {
          const lead = {};
          const body = line.replace(/^LEAD\s*/i,'');
          body.split(';').forEach(pair => {
            const [k,v] = pair.split('=');
            if (k) lead[k.trim().toLowerCase()] = (v||'').trim();
          });
          console.log('[LEAD]', lead);
        }
      }
    } catch (e) {
      console.error('[Bridge] AI message handler error:', e.message);
    }
  }
});

/* ========================= START ========================== */
server.listen(PORT, () => console.log(`Server listening on :${PORT}`));
