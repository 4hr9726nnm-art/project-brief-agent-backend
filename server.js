// server.js - Cleaned & deduplicated
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
  res.setHeader('Access-Control-Allow-Origin', '*'); // restrict later
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Startup checks
const requiredEnvs = ['OPENAI_API_KEY', 'S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'BASE_URL'];
requiredEnvs.forEach(k => {
  if (!process.env[k]) console.warn(`Warning: environment variable ${k} is not set.`);
});

// In-memory stores
const docs = {};
const users = {};

// AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION || 'eu-north-1'
});
const s3 = new AWS.S3();

// OpenAI key
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Multer
const upload = multer({ dest: '/tmp' });

// PayPal base
const PAYPAL_BASE = (process.env.PAYPAL_MODE === 'live')
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox-paypal.com'; // <-- bug fix: original used api-m.sandbox.paypal.com; keep consistent below

// ---------------------- Helpers ----------------------
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('PayPal credentials missing in env');
  const basicAuth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const resp = await fetch(`${PAYPAL_BASE.replace('-paypal','')}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`PayPal token error: ${resp.status} ${txt}`);
  }
  const data = await resp.json();
  return data.access_token;
}

async function createPayPalOrder({ amount = '15.00', description = 'Project Brief Analyzer - 50 credits', userId = 'anonymous' } = {}) {
  const token = await getPayPalAccessToken();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value: amount }, description, custom_id: userId }],
    application_context: { return_url: `${process.env.BASE_URL}/api/capture-paypal-order`, cancel_url: `${process.env.BASE_URL}/paypal-cancel` }
  };
  const resp = await fetch(`${PAYPAL_BASE.replace('-paypal','')}/v2/checkout/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
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

async function capturePayPalOrder(orderId) {
  const token = await getPayPalAccessToken();
  const resp = await fetch(`${PAYPAL_BASE.replace('-paypal','')}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`PayPal capture failed: ${resp.status} ${txt}`);
  }
  return await resp.json();
}

// Upload helpers (deduplicated)
async function parsePdfBuffer(buffer) {
  try {
    const pdfModule = await import('pdf-parse');
    const pdfFunc = pdfModule.default || pdfModule;
    const parsed = await pdfFunc(buffer);
    return parsed.text || '';
  } catch (err) {
    console.warn('pdf-parse failed', err?.message || err);
    return '';
  }
}

function uploadBufferToS3(buffer, s3Key) {
  return new Promise((resolve, reject) => {
    s3.putObject({ Bucket: process.env.S3_BUCKET, Key: s3Key, Body: buffer }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function uploadFileToS3FromPath(localPath, s3Key) {
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

// ---------------------- Routes ----------------------

// Health
app.get('/', (req, res) => res.send('Project Brief Agent Backend is running'));

// Upload (multipart file from client)
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const filePath = req.file.path;
    const fileName = req.file.originalname || req.file.filename || 'upload.pdf';
    const userId = req.body.userId || 'anonymous';

    const data = await fs.promises.readFile(filePath);
    const text = await parsePdfBuffer(data);
    const s3Key = `uploads/${Date.now()}-${fileName.replace(/\s+/g,'_')}`;
    await uploadFileToS3FromPath(filePath, s3Key);

    const docId = `doc-${Date.now()}`;
    docs[docId] = { s3Key, text, uploadedAt: new Date().toISOString(), userId, originalName: fileName };
    fs.unlink(filePath,()=>{});
    res.json({ ok: true, docId, hasText: !!text });
  } catch (err) {
    console.error('Upload error', err && (err.stack || err.message) ? (err.stack || err.message) : err);
    res.status(500).json({ error: 'Upload failed', details: err?.message || String(err) });
  }
});

// Create PayPal order
app.post('/api/create-paypal-order', async (req, res) => {
  try {
    const { userId, amount = '15.00', description = 'Project Brief Analyzer - 50 credits' } = req.body || {};
    const order = await createPayPalOrder({ amount, description, userId });
    res.json({ id: order.id, approvalUrl: order.approvalUrl });
  } catch (err) {
    console.error('PayPal create order error', err && (err.stack || err.message) ? (err.stack || err.message) : err);
    res.status(500).json({ error: err?.message || 'PayPal create failed' });
  }
});

// Capture PayPal order
app.get('/api/capture-paypal-order', async (req, res) => {
  try {
    const token = req.query.token || req.query.orderId || null;
    if (!token) return res.status(400).send('Missing token');
    const captureData = await capturePayPalOrder(token);

    const purchaseUnit = (captureData.purchase_units && captureData.purchase_units[0]) || null;
    const customId = purchaseUnit?.custom_id || 'anonymous';
    const capture = purchaseUnit?.payments?.captures?.[0] || null;
    const amount = capture?.amount?.value || '15.00';

    const creditsToAdd = Math.round((parseFloat(amount) / 15) * 50) || 50;
    users[customId] = users[customId] || { credits: 0 };
    users[customId].credits += creditsToAdd;
    console.log(`PayPal payment captured for ${customId}. Added credits: ${creditsToAdd}`);

    const redirectTo = `${process.env.BASE_URL}/paypal-success?userId=${customId}&credits=${users[customId].credits}`;
    return res.redirect(redirectTo);
  } catch (err) {
    console.error('PayPal capture error', err && (err.stack || err.message) ? (err.stack || err.message) : err);
    return res.status(500).send('Capture failed: ' + (err?.message || String(err)));
  }
});

// PayPal webhook
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

// Analyze
app.post('/api/analyze', async (req, res) => {
  try {
    const { docId, userId } = req.body;
    if (!docId || !docs[docId]) return res.status(400).json({ error: 'docId missing or not found' });

    const uid = userId || docs[docId].userId || 'anonymous';
    users[uid] = users[uid] || { credits: 0 };
    if ((users[uid].credits || 0) <= 0) return res.status(402).json({ error: 'Insufficient credits. Please purchase credits.' });

    const fullText = docs[docId].text || '';
    if (!fullText.trim()) return res.status(400).json({ error: 'No extractable text found in PDF. Consider OCR.' });

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

    const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 1200, temperature: 0.0 })
    });
    const openaiData = await openaiResp.json();
    const text = openaiData.choices?.[0]?.message?.content || '';

    let parsed = null;
    try { parsed = JSON.parse(text); } catch (err) { parsed = { parse_error: true, raw: text }; }

    users[uid].credits -= 1;
    res.json({ ok: true, docId, result: parsed, remainingCredits: users[uid].credits });
  } catch (err) {
    console.error('Analyze error', err && (err.stack || err.message) ? (err.stack || err.message) : err);
    res.status(500).json({ error: err.message || 'Analyze failed' });
  }
});

// user credits
app.get('/api/user-credits', (req, res) => {
  const userId = req.query.userId || 'anonymous';
  const c = (users[userId] && users[userId].credits) || 0;
  res.json({ userId, credits: c });
});

// upload by URL (backend fetch)
app.post('/api/upload-by-url', express.json(), async (req, res) => {
  try {
    const { fileUrl, userId, originalFileName } = req.body || {};
    if (!fileUrl) return res.status(400).json({ error: 'fileUrl missing in request body' });
    if (typeof fileUrl === 'string' && fileUrl.startsWith('wix:document://')) {
      console.warn('Received wix:document URL from client; cannot download from server:', fileUrl);
      return res.status(400).json({ error: 'Unfetchable file URL provided. Use Wix File Upload (Upload Button) or convert to public URL.' });
    }

    console.log('/api/upload-by-url starting download:', fileUrl, 'userId:', userId, 'origName:', originalFileName);

    let resp;
    try { resp = await fetch(fileUrl, { headers: { 'User-Agent': 'ProjectBriefAgent/1.0' } }); }
    catch (err) { console.error('/api/upload-by-url fetch threw', err && err.message ? err.message : err); return res.status(502).json({ error: 'fetch threw an exception', details: String(err?.message || err) }); }

    if (!resp.ok) {
      let bodyText = '<no-body>';
      try { const txt = await resp.text(); bodyText = txt ? (txt.length > 1000 ? txt.slice(0,1000)+'...[truncated]' : txt) : '<empty>'; } catch (e) { bodyText = `<failed-to-read-body: ${String(e?.message||e)}>`; }
      console.error(`/api/upload-by-url download failed: status=${resp.status} ${resp.statusText} body=${bodyText}`);
      return res.status(502).json({ error: `Failed to download file: ${resp.status} ${resp.statusText}`, bodySnippet: bodyText });
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const text = await parsePdfBuffer(buffer);
    const s3Key = `uploads/${Date.now()}-${(originalFileName || 'file.pdf').replace(/\s+/g, '_')}`;
    await uploadBufferToS3(buffer, s3Key);

    const docId = `doc-${Date.now()}`;
    docs[docId] = { s3Key, text, uploadedAt: new Date().toISOString(), userId: userId || 'anonymous', originalName: originalFileName || 'file.pdf' };
    console.log('/api/upload-by-url succeeded for docId', docId, 's3Key', s3Key, 'hasText', !!text);
    return res.json({ ok: true, docId, hasText: !!text });
  } catch (err) {
    console.error('/api/upload-by-url ERROR', err && (err.stack || err.message) ? (err.stack || err.message) : err);
    return res.status(500).json({ error: err?.message || 'download failed' });
  }
});

// upload raw PDF bytes from Wix backend
app.post('/api/upload-raw', express.raw({ type: 'application/pdf', limit: '25mb' }), async (req, res) => {
  try {
    const buffer = req.body;
    if (!buffer || buffer.length === 0) return res.status(400).json({ error: 'Empty request body' });

    const originalFileName = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : `upload-${Date.now()}.pdf`;
    const userId = req.headers['x-userid'] ? decodeURIComponent(req.headers['x-userid']) : 'anonymous';

    const text = await parsePdfBuffer(buffer);
    const s3Key = `uploads/${Date.now()}-${originalFileName.replace(/\s+/g, '_')}`;
    await uploadBufferToS3(buffer, s3Key);

    const docId = `doc-${Date.now()}`;
    docs[docId] = { s3Key, text, uploadedAt: new Date().toISOString(), userId, originalName: originalFileName };
    console.log('/api/upload-raw succeeded for docId', docId);
    return res.json({ ok: true, docId, hasText: !!text });
  } catch (err) {
    console.error('/api/upload-raw error', err && (err.stack || err.message) ? (err.stack || err.message) : err);
    return res.status(500).json({ error: err?.message || 'upload-raw failed' });
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
