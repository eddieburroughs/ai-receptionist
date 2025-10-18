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
const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-mini';
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
function ulawSilenceB64(){return Buffer.alloc(160,0xFF).toString('base64');}

/* ================= OPENAI REALTIME (GLOBAL) ================= */
// keep one warm connection so “Shirley” speaks instantly
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

    const payload = {
      type: 'session.update',
      session: {
        instructions:
`You are Shirley, the friendly and professional voice receptionist for ${BUSINESS}.
Speak naturally with warmth and confidence, just like a real person—short sentences, small pauses, and a smile in your tone.
You answer incoming phone calls for home maintenance services.
Your goal is to greet the caller, understand what they need, and collect:
- their name
- phone number
- address or ZIP
- what kind of service (Plumbing, HVAC, Electrical, Handyman)
- preferred day/time (morning or afternoon)
- and any details about the issue.
If the caller asks for a person ("operator", "transfer", "agent"), say “Sure, let me get someone on the line,” and output TRANSFER.
When you have all the details, say something friendly like “Thanks! We’ll follow up shortly,” then output DONE.
For urgent issues like leaks, smoke, or no AC, mark them priority=true in a LEAD line.
Keep your voice conversational and human—think of a real receptionist named Shirley.`,
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

ensureGlobalAI();
setInterval(ensureGlobalAI, 60_000);

/* =================== VOICE ENTRY / TWIML =================== */
app.post('/voice', (req, res) => {
  ensureGlobalAI();

  const twiml = new VoiceResponse();
  // No Twilio voice prompt — go straight to AI
  const connect = twiml.connect();
  connect.stream({
    url: STREAM_WSS,
    statusCallback: `${PUBLIC_BASE}/stream-status`,
    statusCallbackMethod: 'POST'
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
  twiml.say({ voice: 'Polly.Joanna-Neural' }, 'Thanks for calling. Goodbye.');
  res.type('text/xml').send(twiml.toString());
});

/* =================== WS BRIDGE (MEDIA) ==================== */
const wss = new WebSocketServer({ server, path: '/twilio-media' });

wss.on('connection', (twilioWs) => {
  console.log('[WS] Twilio media CONNECTED', new Date().toISOString());
  let stopped = false;
  let callSid = '';
  let streamSid = '';
  let keepAlive = null;
  let sentRealAudio = false;

  twilioWs.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === 'start') {
        callSid   = data.start?.callSid   || '';
        streamSid = data.start?.streamSid || '';
        console.log('[Twilio] START', callSid, streamSid);

        // Send short keep-alive silence
        const silence = ulawSilenceB64();
        keepAlive = setInterval(() => {
          if (!sentRealAudio && !stopped && twilioWs.readyState === 1)
            twilioWs.send(JSON.stringify({ event:'media', streamSid, media:{ payload:silence }}));
        }, 20);

        // Have Shirley speak immediately
        if (globalAI && aiReady && globalAI.readyState === 1) {
          globalAI.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio'],
              instructions: `Welcome to ${BUSINESS}, this is Shirley. How can I help you today?`
            }
          }));
        }
      }

      if (data.event === 'media') {
        const pcm8 = decodeMuLawBuffer(data.media.payload);
        const pcm24 = up8kTo24k(pcm8);
        const b64 = Buffer.from(pcm24.buffer).toString('base64');
        if (globalAI && aiReady && globalAI.readyState === 1 && !stopped) {
          globalAI.send(JSON.stringify({ type:'input_audio_buffer.append', audio:b64 }));
          globalAI.send(JSON.stringify({ type:'input_audio_buffer.commit' }));
        }
      }

      if (data.event === 'stop') {
        stopped = true;
        console.log('[Twilio] STOP', callSid);
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
      }
    } catch (e) { console.error('[Twilio WS error]', e.message); }
  });

  twilioWs.on('close', () => {
    console.log('[WS] Twilio media CLOSED');
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  });

  // AI -> Twilio
  if (globalAI) globalAI.on('message', onAIMessage);

  function onAIMessage(buf) {
    if (stopped) return;
    try {
      const msg = JSON.parse(buf.toString());

      if (msg.type === 'output_audio.delta' && msg.audio) {
        const pcm24 = new Int16Array(Buffer.from(msg.audio, 'base64').buffer);
        const pcm8 = down24kTo8k(pcm24);
        const b64ulaw = encodeMuLawBufferFromPCM(pcm8);
        if (!sentRealAudio && keepAlive) { clearInterval(keepAlive); keepAlive = null; sentRealAudio = true; }
        if (twilioWs.readyState === 1)
          twilioWs.send(JSON.stringify({ event:'media', streamSid, media:{ payload:b64ulaw }}));
      }

      if (msg.type === 'output_text.delta' && msg.delta) {
        const line = msg.delta.trim();
        if (/^TRANSFER$/i.test(line) && callSid)
          twilioClient.calls(callSid).update({ url:`${PUBLIC_BASE}/transfer`, method:'POST' });
        else if (/^DONE$/i.test(line) && callSid)
          twilioClient.calls(callSid).update({ url:`${PUBLIC_BASE}/goodbye`, method:'POST' });
        else if (/^LEAD\b/i.test(line)) {
          const lead = {};
          const body = line.replace(/^LEAD\s*/i,'');
          body.split(';').forEach(p=>{const[k,v]=p.split('=');if(k)lead[k.trim().toLowerCase()]=(v||'').trim();});
          console.log('[LEAD]', lead);
        }
      }
    } catch (e) { console.error('[AI->Twilio error]', e.message); }
  }
});

/* ========================= START ========================== */
server.listen(PORT, () => console.log(`Server listening on :${PORT}`));
