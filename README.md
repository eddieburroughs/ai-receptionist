# AI Receptionist (Twilio <Connect><Stream> + OpenAI Realtime)

Natural, barge-in voice agent for phone calls. Streams Twilio Media to OpenAI Realtime and plays audio back in real time.

## Files
- `server.mjs` — Express server + WS bridge Twilio <-> OpenAI
- `package.json` — deps/scripts
- `.gitignore` — keeps `.env` private
- `.env.example` — placeholders only (no real keys)

## Deploy on Render (Production-First)
1. Create a new GitHub repo and add these files.
2. On Render: **New → Web Service → Build from GitHub**.
   - Build command: `npm install`
   - Start command: `npm start`
3. In **Render → Environment**, add variables (from `.env.example`) with **real values**:
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VOICE_NUMBER`
   - `OPENAI_API_KEY`
   - `BUSINESS_NAME`, `TRANSFER_NUMBER`
   - `ALERT_SMS_TO`, `ALERT_SMS_FROM` (optional)
   - `GOOGLE_FORM_ACTION_URL`, `GOOGLE_FORM_FIELDS` (optional)
   - `PUBLIC_BASE_URL` = your Render URL, e.g. `https://ai-receptionist-no7p.onrender.com`
4. Save → Restart. Confirm `https://YOUR-RENDER-URL/` returns `OK`.

## Hook Up Twilio
- Twilio Console → Phone Numbers → (your number) → **Voice → A CALL COMES IN**:
  - **Webhook**, **POST** to: `https://YOUR-RENDER-URL/voice`

## Test
Call your Twilio number:
- You should hear a greeting, then the AI speaks (and can be interrupted).
- Say: “transfer me to a person” → should route to `TRANSFER_NUMBER`.

## Notes
- Uses naive 8k<->24k resampling (fine for MVP). Swap in a proper resampler for production audio quality.
- If your host drops WebSockets quickly on free tier, upgrade the instance.
