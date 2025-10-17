// server.js - Full patched file
// Cleaned Quick MVP with lazy pdf-parse import and improved upload-by-url handler
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

// allow CORS for Wix (or restrict to your exact Wix domain in production)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // ok for testing; restrict later to your Wix domain
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Small startup checks to surface missing env variables early
const requiredEnvs = ['OPENAI_API_KEY', 'S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'BASE_URL'];
requiredEnvs.forEach(k => {
  if (!process.env[k]) console.warn(`Warning: environment variable ${k} is not set.`);
});

// In-memory stores (swap with DB in production)
const docs = {};   // docId -> { s3Key, text, uploadedAt, userId }
const users = {};  // userId -> { credits: number, email }

// ---------- AWS S3 Setup ----------
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION || 'eu-north-1'
});
const s3 = new AWS.S3();

// ---------- OpenAI Setup ----------
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ---------- Multer ----------
const upload = multer({ dest: '/tmp' }); // keeps current disk flow; ok for Render ephemeral fs

// ---------- PayPal (fetch-based) helper ----------
const PAYPAL_BASE = (process.env.PAYPAL_MODE === 'live')
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// Get OAuth2 access token from PayPal
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('PayPal credentials missing in env');

  const basicAuth = Buffer.from(`${clientId}:${secret}`).toString('base64');

  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`PayPal token error: ${resp.status} ${txt}`);
  }
  const data = await resp.json();
  return data.access_token;
}

// Create an order (returns { id, approvalUrl })
async function createPayPalOrder({ amount = '15.00', description = 'Project Brief Analyzer - 50 credits', userId = 'anonymous' } = {}) {
  const token = await getPayPalAccessToken();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: 'USD', value: amount },
      description,
      custom_id: userId
    }],
    application_context: {
      return_url: `${process.env.BASE_URL}/api/capture-paypal-order`,
      cancel_url: `${process.env.BASE_URL}/paypal-cancel`
    }
  };

  const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`PayPal create order failed: ${resp.status} ${txt}`);
  }
  const data = await resp.json();
  const approvalUrl = (data.links || []).find(l => l.rel === 'approve')?.href || null;
  return { id: data.id, approvalUrl };
}

// Capture order (after approval)
async function capturePayPalOrder(orderId) {
  const token = await getPayPalAccessToken();
  const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`PayPal capture failed: ${resp.status} ${txt}`);
  }
  const data = await resp.json();
  return data;
}

// Utility: upload local file to S3
function uploadToS3(localPath, s3Key) {
  return new Promise((resolve, reject) => {
    fs.readFile(localPath, (err, data) => {
      if (err) return reject(err);
      s3.putObject({ Bucket: process.env.S3_BUCKET, Key: s3Key, Body: data }, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

// ----------------- Routes -----------------

// Health
app.get('/', (req, res) => res.send('Project Brief Agent Backend is running'));

// Upload PDF (lazy import of pdf-parse to avoid module load side-effects)
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const filePath = req.file.path;
    const fileName = req.file.originalname || req.file.filename || 'upload.pdf';
    const userId = req.body.userId || 'anonymous';

    const s3Key = `uploads/${Date.now()}-${fileName}`;
    const data = await fs.promises.readFile(filePath);

    // Lazy-import pdf-parse here so any side effects inside the pdf-parse module don't run at startup
    let text = '';
    try {
      const pdfModule = await import('pdf-parse'); // dynamic import returns module namespace
      const pdfFunc = pdfModule.default || pdfModule;
      const parsed = await pdfFunc(data);
      text = parsed.text || '';
    } catch (err) {
      text = '';
      console.warn('pdf-parse extraction failed for uploaded file (may be scanned PDF)', err?.message || err);
    }

    // Upload to S3
    await uploadToS3(filePath, s3Key);

    // Create doc record
    const docId = `doc-${Date.now()}`;
    docs[docId] = { s3Key, text, uploadedAt: new Date().toISOString(), userId, originalName: fileName };

    // remove tmp file
    fs.unlink(filePath, ()=>{});

    res.json({ ok: true, docId, hasText: !!text });
  } catch (err) {
    console.error('Upload error', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Upload failed', details: err?.message || String(err) });
  }
});

// Create PayPal order (checkout) - returns approval url
app.post('/api/create-paypal-order', async (req, res) => {
  try {
    const { userId, amount = '15.00', description = 'Project Brief Analyzer - 50 credits' } = req.body || {};
    const order = await createPayPalOrder({ amount, description, userId });
    res.json({ id: order.id, approvalUrl: order.approvalUrl });
  } catch (err) {
    console.error('PayPal create order error', err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message || 'PayPal create failed' });
  }
});

// Capture PayPal order after user approves (PayPal will redirect to return_url with token param)
app.get('/api/capture-paypal-order', async (req, res) => {
  try {
    const token = req.query.token || req.query.orderId || null;
    if (!token) return res.status(400).send('Missing token');
    // token is the order ID to capture
    const captureData = await capturePayPalOrder(token);

    // Extract custom_id (userId) and amount from captureData
    const purchaseUnit = (captureData.purchase_units && captureData.purchase_units[0]) || null;
    const customId = purchaseUnit?.custom_id || 'anonymous';
    const capture = purchaseUnit?.payments?.captures?.[0] || null;
    const amount = capture?.amount?.value || '15.00';

    // Compute credits (example: $15 -> 50 credits)
    const creditsToAdd = Math.round((parseFloat(amount) / 15) * 50) || 50;
    users[customId] = users[customId] || { credits: 0 };
    users[customId].credits += creditsToAdd;

    console.log(`PayPal payment captured for ${customId}. Added credits: ${creditsToAdd}`);

    // Redirect to a success page on your frontend (or return JSON)
    const redirectTo = `${process.env.BASE_URL}/paypal-success?userId=${customId}&credits=${users[customId].credits}`;
    return res.redirect(redirectTo);
  } catch (err) {
    console.error('PayPal capture error', err && err.stack ? err.stack : err);
    return res.status(500).send('Capture failed: ' + (err?.message || String(err)));
  }
});

// PayPal webhook (optional) - logs events. For production, verify signatures.
app.post('/paypal-webhook', express.json(), (req, res) => {
  try {
    const event = req.body;
    console.log('PayPal webhook event:', JSON.stringify(event, null, 2));
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error', err && err.stack ? err.stack : err);
    res.sendStatus(500);
  }
});

// Analyze endpoint - uses extracted text (MVP)
app.post('/api/analyze', async (req, res) => {
  try {
    const { docId, userId } = req.body;
    if (!docId || !docs[docId]) return res.status(400).json({ error: 'docId missing or not found' });

    // Check credits
    const uid = userId || docs[docId].userId || 'anonymous';
    users[uid] = users[uid] || { credits: 0 };
    if ((users[uid].credits || 0) <= 0) {
      return res.status(402).json({ error: 'Insufficient credits. Please purchase credits.' });
    }

    const fullText = docs[docId].text || '';
    // If empty, you should OCR the S3 PDF (upgrade later). For MVP we'll warn.
    if (!fullText.trim()) {
      return res.status(400).json({ error: 'No extractable text found in PDF. Consider using scanned/OCR documents or enable OCR.' });
    }

    const systemPrompt = `You are an expert project manager and proposal reviewer. Given the client brief text below, produce JSON with keys:
- overview (2-3 sentence summary)
- deliverables (array of objects {title, description, acceptance_criteria})
- milestones (array of {title, duration_weeks})
- risks (array of {risk, mitigation})
- clarifying_questions (grouped object with keys: Budget, Scope, Timeline, Resources -> arrays of questions)
- sources (if possible)
- confidence_score (0-1)

If info is missing, explicitly say what is missing. Return valid JSON only.`;

    const userPrompt = `Client brief text:\n\n${fullText}\n\nNow analyze the brief as described above. Return ONLY valid JSON.`;

    // Call OpenAI Chat Completions (REST)
    const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 1200,
        temperature: 0.0
      })
    });
    const openaiData = await openaiResp.json();
    const text = openaiData.choices?.[0]?.message?.content || '';

    // Try to parse JSON safely
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = { parse_error: true, raw: text };
    }

    // Deduct 1 credit (example)
    users[uid].credits -= 1;

    res.json({ ok: true, docId, result: parsed, remainingCredits: users[uid].credits });
  } catch (err) {
    console.error('Analyze error', err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message || 'Analyze failed' });
  }
});

// Endpoint to check user credits (Wix can call this)
app.get('/api/user-credits', (req, res) => {
  const userId = req.query.userId || 'anonymous';
  const c = (users[userId] && users[userId].credits) || 0;
  res.json({ userId, credits: c });
});

// ----------------- /api/upload-by-url (improved) -----------------
app.post('/api/upload-by-url', express.json(), async (req, res) => {
  try {
    const { fileUrl, userId, originalFileName } = req.body || {};
    if (!fileUrl) return res.status(400).json({ error: 'fileUrl missing in request body' });

    // Quick guard: wix internal doc scheme cannot be fetched from server
    if (typeof fileUrl === 'string' && fileUrl.startsWith('wix:document://')) {
      console.warn('Received wix:document URL from client; cannot download from server:', fileUrl);
      return res.status(400).json({
        error: 'Unfetchable file URL provided. Use Wix File Upload (Upload Button) which returns a public https://static.wixstatic.com URL, or convert the document to a public URL before sending.'
      });
    }

    // Log incoming request briefly
    console.log('/api/upload-by-url starting download:', fileUrl, 'userId:', userId, 'origName:', originalFileName);

    let resp;
    try {
      // Optionally add a User-Agent; some hosts require it
      resp = await fetch(fileUrl, { headers: { 'User-Agent': 'ProjectBriefAgent/1.0 (+https://your-domain.example)' } });
    } catch (err) {
      console.error('/api/upload-by-url fetch threw', err && err.message ? err.message : err);
      return res.status(502).json({ error: 'fetch threw an exception', details: String(err?.message || err) });
    }

    if (!resp.ok) {
      // try to read a small portion of the body for useful debugging (avoid huge returns)
      let bodyText = '<no-body>';
      try {
        const txt = await resp.text();
        bodyText = txt ? (txt.length > 1000 ? txt.slice(0,1000) + '...[truncated]' : txt) : '<empty>';
      } catch (e) {
        bodyText = `<failed-to-read-body: ${String(e?.message || e)}>`;
      }
      console.error(`/api/upload-by-url download failed: status=${resp.status} ${resp.statusText} body=${bodyText}`);
      return res.status(502).json({ error: `Failed to download file: ${resp.status} ${resp.statusText}`, bodySnippet: bodyText });
    }

    // read into buffer
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Try pdf parsing (lazy import)
    let text = '';
    try {
      const pdfModule = await import('pdf-parse');
      const pdfFunc = pdfModule.default || pdfModule;
      const parsed = await pdfFunc(buffer);
      text = parsed.text || '';
    } catch (err) {
      console.warn('pdf-parse failed on downloaded file', err?.message || err);
      text = '';
    }

    // Upload buffer to S3
    const s3Key = `uploads/${Date.now()}-${(originalFileName || 'file.pdf').replace(/\s+/g, '_')}`;
    await new Promise((resolve, reject) => {
      s3.putObject({ Bucket: process.env.S3_BUCKET, Key: s3Key, Body: buffer }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // create doc record
    const docId = `doc-${Date.now()}`;
    docs[docId] = {
      s3Key,
      text,
      uploadedAt: new Date().toISOString(),
      userId: userId || 'anonymous',
      originalName: originalFileName || 'file.pdf'
    };

    console.log('/api/upload-by-url succeeded for docId', docId, 's3Key', s3Key, 'hasText', !!text);
    return res.json({ ok: true, docId, hasText: !!text });
  } catch (err) {
    console.error('/api/upload-by-url ERROR', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err?.message || 'download failed' });
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
