# Project Brief Agent - Quick MVP Backend

## What this does
- Upload PDFs, extract text
- Create PayPal checkout & capture payments
- Call OpenAI to analyze brief and return structured JSON
- Basic in-memory users & credits (replace with DB in production)

## Setup (local)
1. Clone repo
2. Copy `.env.template` -> `.env` and fill with keys
3. Install:
   npm install
4. Run locally:
   node server.js
5. Endpoints:
   - POST /api/upload (form field 'file')
   - POST /api/create-paypal-order { userId, amount }
   - GET /api/capture-paypal-order?token=...
   - POST /api/analyze { docId, userId }
   - GET /api/user-credits?userId=...

## Deploy to Render
1. Create a new Web Service from your GitHub repo
2. Build Command: `npm install`
3. Start Command: `node server.js`
4. Add environment variables from `.env.template` in Render dashboard
5. Deploy and use the Render URL as BASE_URL in environment

## Notes
- This is MVP. Replace in-memory `users` and `docs` with Postgres/Supabase.
- For scanned PDFs, add Tesseract OCR pipeline.
- Add auth (JWT) before production to prevent abuse.
