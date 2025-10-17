// server.js - Quick MVP with PayPal
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import pdf from 'pdf-parse';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import paypal from '@paypal/checkout-server-sdk';
dotenv.config();

const app = express();
app.use(express.json());

// In-memory stores (swap with DB in production)
const docs = {};   // docId -> { s3Key, text, uploadedAt, userId }
const users = {};  // userId -> { credits: number, email }

// ---------- AWS S3 Setup ----------
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION || 'us-east-1'
});
const s3 = new AWS.S3();

// ---------- PayPal Setup ----------
const environment = process.env.PAYPAL_MODE === 'live'
  ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
  : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
const paypalClient = new paypal.core.PayPalHttpClient(environment);

// ---------- OpenAI Setup ----------
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ---------- Multer ----------
const upload = multer({ dest: '/tmp' });

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

// Upload PDF
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const userId = req.body.userId || 'anonymous';

    const s3Key = `uploads/${Date.now()}-${fileName}`;
    const data = await fs.promises.readFile(filePath);

    // Try text extraction via pdf-parse
    let text = '';
    try {
      const parsed = await pdf(data);
      text = parsed.text || '';
    } catch (err) {
      text = '';
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
    console.error('Upload error', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Create PayPal order (checkout)
app.post('/api/create-paypal-order', async (req, res) => {
  try {
    const { userId, amount = '15.00', description = 'Project Brief Analyzer - 50 credits' } = req.body;
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: amount },
        description,
        custom_id: userId || 'anonymous'
      }],
      application_context: {
        return_url: `${process.env.BASE_URL}/paypal-success`,
        cancel_url: `${process.env.BASE_URL}/paypal-cancel`
      }
    });

    const order = await paypalClient.execute(request);
    const approvalUrl = order.result.links.find(l => l.rel === 'approve')?.href;
    res.json({ id: order.result.id, approvalUrl });
  } catch (err) {
    console.error('PayPal create order error', err);
    res.status(500).json({ error: err.message });
  }
});

// Capture PayPal order after user approves (GET redirect endpoint)
app.get('/api/capture-paypal-order', async (req, res) => {
  try {
    const { token } = req.query; // PayPal returns token param
    if (!token) return res.status(400).send('Missing token');

    const request = new paypal.orders.OrdersCaptureRequest(token);
    request.requestBody({});
    const capture = await paypalClient.execute(request);
    const order = capture.result;
    const customId = order.purchase_units?.[0]?.custom_id || 'anonymous';

    // Grant credits (example: $15 -> 50 credits)
    const amount = order.purchase_units[0].payments.captures[0].amount.value;
    const creditsToAdd = Math.round((parseFloat(amount) / 15) * 50) || 50;

    users[customId] = users[customId] || { credits: 0 };
    users[customId].credits += creditsToAdd;

    console.log(`PayPal payment captured for ${customId}. Added credits: ${creditsToAdd}`);

    // Redirect to a success page on your frontend or show a simple success text
    return res.redirect(`${process.env.BASE_URL}/paypal-success?userId=${customId}&credits=${users[customId].credits}`);
  } catch (err) {
    console.error('PayPal capture error', err);
    return res.status(500).send('Capture failed');
  }
});

// PayPal webhook (optional, recommended for reliability)
app.post('/paypal-webhook', express.json(), (req, res) => {
  try {
    const event = req.body;
    // Example: if event.resource contains capture details
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' || event.event_type === 'PAYMENT.CAPTURE.DENIED') {
      const customId = event.resource?.custom_id || event.resource?.invoice_id || 'unknown';
      console.log('PayPal webhook event for', customId, event.event_type);
      // Mark or add credits here if you prefer webhooks
      // NOTE: in sandbox, structure may differ; log event to inspect.
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error', err);
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
    console.error('Analyze error', err);
    res.status(500).json({ error: err.message || 'Analyze failed' });
  }
});

// Endpoint to check user credits (Wix can call this)
app.get('/api/user-credits', (req, res) => {
  const userId = req.query.userId || 'anonymous';
  const c = (users[userId] && users[userId].credits) || 0;
  res.json({ userId, credits: c });
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
