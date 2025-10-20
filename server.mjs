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
// μ-law <-> PCM16
function mulawDecode(mu){const BIAS=0x84;mu=~mu&0xff;const sign=mu&0x80;let exponent=(mu&0x70)>>4;let mantissa=mu&0x0f;let sample=((mantissa<<4)+8)<<(exponent+3);sample-=BIAS;return sign?-sample:sample;}
function decodeMuLawBuffer(b64){const buf=Buffer.from(b64,'base64');const out=new Int16Array(buf.length);for(let i=0;i<buf.length;i++)out[i]=mulawDecode(buf[i]);return out;}
function linear2ulaw(sample){const BIAS=0x84,CLIP=32635;let sign=(sample>>8)&0x80;if(sign!==0)sample=-sample;if(sample>CLIP)sample=CLIP;sample+=BIAS;let exponent=7;for(let m=0x4000;(sample&m)===0&&exponent>0;exponent--,m>>=1){}const mantissa=(sample>>((exponent===0)?4:(exponent+3)))&0x0f;return(~(sign|(exponent<<4)|mantissa))&0xff;}
function encodeMuLawBufferFromPCM(int16){const out=Buffer.alloc(int16.length);for(let i=0;i<int16.length;i++)out[i]=linear2ulaw(int16[i]);return out.toString('base64');}
function ulawSilenceB64(){return Buffer.alloc(160,0xFF).toString('base64');} // 20ms @ 8kHz

// ★ Resampling: Twilio 8 kHz  <->  OpenAI 16 kHz (duplicate / drop every other sample)
function up8kTo16k(int16){const out=new Int16Array(int16.length*2);for(let i=0;i<int16.length;i++){out[i*2]=int16[i];out[i*2+1]=int16[i];}return out;}
function down16kTo8k(int16){const out=new Int16Array(Math.floor(int16.length/2));for(let i=0,j=0;j<out.length;i+=2,j++)out[j]=int16[i];return out;}

/* ================= OPENAI REALTIME (GLOBAL) ================= */
// Keep one warm connection (with explicit "realtime" subprotocol) and PRINT FULL ERRORS.
let globalAI = null;
let aiReady  = false;
let isConnecting = false;

function connectRealtime() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };
  // IMPORTANT: subprotocol "realtime"
  return new WebSocket(url, 'realtime', { headers });
}

function ensureGlobalAI() {
  if (aiReady || isConnecting) return;
  if (globalAI && globalAI.readyState === 1) { aiReady = true; return; }
  isConnecting = true;

  const ws = connectRealtime();
  globalAI = ws;

  ws.on('open', () => {
    aiReady = true;
    isConnecting = false;
    console.log('[AI] GLOBAL OPEN');

    const payload = {
      type: 'session.update',
      session: {
        instructions:
`You are Shirley, the friendly and professional voice receptionist for ${BUSINESS}.
Speak naturally with warmth, short sentences, slight pauses, and a smile in your tone.
You answer incoming phone calls for home maintenance services and collect:
- name, phone number, address or ZIP
- service type (Plumbing, HVAC, Electrical, Handyman)
- preferred time (morning/afternoon, day)
- brief details of the issue
If caller asks for a person ("operator", "transfer", "agent"), say “Sure, let me get someone on the line,” then output TRANSFER.
When you have all details, politely close and output DONE.
For urgent issues (leak, smoke, no AC/heat), mark priority=true in a LEAD line.
Stay concise and human. Barge-in friendly. Use natural fillers sparingly.`,
        voice: 'alloy',
        // ★ Keep formats plain + explicit 16kHz
        input_audio_format: { type: 'pcm16', sample_rate: 16000 },
        output_audio_format: { type: 'pcm16', sample_rate: 16000 },
        turn_detection: { type: 'server_vad' }
      }
    };
    try { ws.send(JSON.stringify(payload)); } catch (e) { console.error('[AI] session.update send error', e.message); }
  });

  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg?.type && msg.type !== 'output_audio.delta') {
        if (msg.type === 'error') {
          console.error('[AI][ERR]', msg.error?.message || msg.message || '(no message)', JSON.stringify(msg, null, 2));
        } else {
          console.log('[AI][DBG]', msg.type);
        }
      }
    } catch (e) {
      console.error('[AI][PARSE]', e.message);
    }
  });

  ws.on('unexpected-response', async (req, res) => {
    console.error('[AI] unexpected-response status=', res.statusCode);
    try {
      const chunks = [];
      for await (const c of res) chunks.push(c);
      const body = Buffer.concat(chunks).toString();
      console.error('[AI] unexpected-response body=', body.slice(0, 2000));
    } catch (e) {
      console.error('[AI] unexpected-response read error', e.message);
    }
  });

  ws.on('error', (e) => {
    console.error('[AI] GLOBAL error', e?.message || e);
  });

  ws.on('close', (code, reasonBuf) => {
    aiReady = false;
    isConnecting = false;
    const reason = (() => {
      try { return Buffer.from(reasonBuf || '').toString() || '<no reason>'; }
      catch { return '<unreadable>'; }
    })();
    console.error(`[AI] GLOBAL CLOSED code=${code} reason=${reason}`);
    setTimeout(() => ensureGlobalAI(), 2000); // small backoff
  });
}
ensureGlobalAI();
setInterval(() => ensureGlobalAI(), 60_000);

/* =================== VOICE ENTRY / TWIML =================== */
app.post('/voice', (req, res) => {
  ensureGlobalAI();
  const twiml = new VoiceResponse();
  // No <Say> — go straight to AI streaming
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
  let mediaCount = 0;
  let greetingWatchdog = null;

  // Per-call AI->Twilio relay
  const onAIMessage = (buf) => {
    if (stopped) return;
    try {
      const msg = JSON.parse(buf.toString());

      if (msg.type && msg.type !== 'output_audio.delta') {
        if (msg.type === 'error') {
          console.error('[AI][CALLERR]', msg.error?.message || msg.message || '(no message)', JSON.stringify(msg, null, 2));
        } else {
          console.log('[AI][CALLDBG]', msg.type);
        }
      }

      // AUDIO back to caller
      if (msg.type === 'output_audio.delta' && msg.audio) {
        if (streamSid && twilioWs.readyState === 1) {
          const pcm16k = new Int16Array(Buffer.from(msg.audio, 'base64').buffer);
          const pcm8k  = down16kTo8k(pcm16k);
          const b64ulaw = encodeMuLawBufferFromPCM(pcm8k);

          if (!sentRealAudio && keepAlive) {
            clearInterval(keepAlive);
            keepAlive = null;
            sentRealAudio = true;
            console.log('[KeepAlive] stopped (AI speaking)');
          }

          twilioWs.send(JSON.stringify({ event:'media', streamSid, media:{ payload:b64ulaw }}));
        }
      }

      // TEXT control / backchannel
      if (msg.type === 'output_text.delta' && msg.delta) {
        const line = msg.delta.trim();
        if (!line) return;

        if (/^TRANSFER$/i.test(line) && callSid) {
          console.log('[CTRL] TRANSFER');
          twilioClient.calls(callSid).update({ url: `${PUBLIC_BASE}/transfer`, method: 'POST' })
            .catch(e => console.error('[CTRL] transfer failed', e.message));
          return;
        }

        if (/^DONE$/i.test(line) && callSid) {
          console.log('[CTRL] DONE → goodbye');
          twilioClient.calls(callSid).update({ url: `${PUBLIC_BASE}/goodbye`, method: 'POST' })
            .catch(e => console.error('[CTRL] goodbye failed', e.message));
          return;
        }

        if (/^LEAD\b/i.test(line)) {
          const lead = {};
          const body = line.replace(/^LEAD\s*/i,'');
          body.split(';').forEach(p => { const [k,v]=p.split('='); if (k) lead[k.trim().toLowerCase()] = (v||'').trim(); });
          console.log('[LEAD]', lead);
        }
      }
    } catch (e) {
      console.error('[AI->Twilio parse/send error]', e.message);
    }
  };

  if (globalAI) globalAI.on('message', onAIMessage);

  // Twilio -> AI
  twilioWs.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === 'start') {
        console.log('[DEBUG] got start event');
        callSid   = data.start?.callSid   || '';
        streamSid = data.start?.streamSid || '';
        console.log('[Twilio] START', callSid, streamSid);

        // Keep Twilio alive with 20ms μ-law silence until first AI audio
        const silence = ulawSilenceB64();
        keepAlive = setInterval(() => {
          if (!sentRealAudio && !stopped && twilioWs.readyState === 1 && streamSid) {
            twilioWs.send(JSON.stringify({ event:'media', streamSid, media:{ payload:silence }}));
          }
        }, 20);
        console.log('[KeepAlive] started (20ms)');

        // Trigger Shirley's first line immediately + watchdog
        if (globalAI && aiReady && globalAI.readyState === 1) {
          console.log('[AI] greeting sent');
          globalAI.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio'],
              instructions: `Welcome to ${BUSINESS}, this is Shirley. How can I help you today?`
            }
          }));

          greetingWatchdog = setTimeout(() => {
            if (!sentRealAudio && !stopped && globalAI.readyState === 1) {
              console.log('[AI] greeting retry (no audio yet)');
              globalAI.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['audio'],
                  instructions: `Hi there! This is Shirley with ${BUSINESS}. What can I do for you today?`
                }
              }));
            }
          }, 2000);
        } else {
          console.log('[AI] greeting deferred (AI not ready)');
        }
      }

      if (data.event === 'media') {
        if (++mediaCount % 50 === 0) console.log('[DEBUG] got media chunk x', mediaCount);

        // Twilio 8k -> OpenAI 16k
        const pcm8k  = decodeMuLawBuffer(data.media.payload);
        const pcm16k = up8kTo16k(pcm8k);
        const b64    = Buffer.from(pcm16k.buffer).toString('base64');

        if (globalAI && aiReady && globalAI.readyState === 1 && !stopped) {
          globalAI.send(JSON.stringify({ type:'input_audio_buffer.append', audio:b64 }));
          globalAI.send(JSON.stringify({ type:'input_audio_buffer.commit' }));
        }
      }

      if (data.event === 'stop') {
        console.log('[DEBUG] got stop event');
        stopped = true;
        console.log('[Twilio] STOP', callSid);
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; console.log('[KeepAlive] stopped'); }
        if (greetingWatchdog) { clearTimeout(greetingWatchdog); greetingWatchdog = null; }
      }
    } catch (e) {
      console.error('[Twilio WS error]', e.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('[WS] Twilio media CLOSED');
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (greetingWatchdog) { clearTimeout(greetingWatchdog); greetingWatchdog = null; }
    if (globalAI) globalAI.off?.('message', onAIMessage);
  });
});

/* ========================= START ========================== */
server.listen(PORT, () => console.log(`Server listening on :${PORT}`));
