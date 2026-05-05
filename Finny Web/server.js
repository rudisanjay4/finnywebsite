require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const MERCHANT_CODE = process.env.DUITKU_MERCHANT_CODE || '';
const API_KEY = process.env.DUITKU_API_KEY || '';
const BASE_URL = process.env.DUITKU_BASE_URL || 'https://api-sandbox.duitku.com';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');

const PLAN_AMOUNTS = {
  lite: { monthly: 4900, yearly: 49000 },
  pro: { monthly: 14900, yearly: 149000 },
};

function loadPayments() {
  if (!fs.existsSync(PAYMENTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function savePayments(data) {
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(data, null, 2));
}

function generateReference() {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FINNY_WEB_${ts}_${rand}`;
}

// POST /api/create-payment
app.post('/api/create-payment', async (req, res) => {
  const { plan, period, telegramUsername } = req.body;

  if (!['lite', 'pro'].includes(plan)) {
    return res.status(400).json({ error: 'Plan tidak valid. Pilih lite atau pro.' });
  }
  if (!['monthly', 'yearly'].includes(period)) {
    return res.status(400).json({ error: 'Period tidak valid. Pilih monthly atau yearly.' });
  }
  if (!telegramUsername || telegramUsername.trim().length < 2) {
    return res.status(400).json({ error: 'Username Telegram tidak valid.' });
  }

  const amount = PLAN_AMOUNTS[plan][period];
  const reference = generateReference();
  const callbackUrl = `${WEBHOOK_DOMAIN}/api/payment/callback`;
  const returnUrl = `${WEBHOOK_DOMAIN}/payment/return?reference=${reference}`;
  const itemName = `Paket ${plan.charAt(0).toUpperCase() + plan.slice(1)} ${period === 'monthly' ? 'Bulanan' : 'Tahunan'}`;
  const timestamp = new Date().toISOString();

  // SHA256 signature: merchantCode + reference + amount + callbackUrl + returnUrl + apiKey
  const signatureStr = MERCHANT_CODE + reference + amount + callbackUrl + returnUrl + API_KEY;
  const signature = crypto.createHash('sha256').update(signatureStr).digest('hex');

  const payments = loadPayments();
  payments[reference] = {
    reference,
    telegramUsername: telegramUsername.trim().replace(/^@/, ''),
    plan,
    period,
    amount,
    status: 'pending',
    createdAt: timestamp,
  };
  savePayments(payments);

  try {
    const response = await axios.post(
      `${BASE_URL}/webapi/api/merchant/invoice`,
      {
        merchantCode: MERCHANT_CODE,
        reference,
        amount,
        currency: 'IDR',
        callbackUrl,
        returnUrl,
        expirationTime: 1440,
        itemName,
        customerVaName: telegramUsername.trim().replace(/^@/, ''),
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-duitku-signature': signature,
          'x-duitku-timestamp': timestamp,
          'x-duitku-merchantcode': MERCHANT_CODE,
        },
      }
    );

    const { statusCode, paymentUrl } = response.data;
    if (statusCode !== '00') {
      return res.status(502).json({ error: 'Gagal membuat invoice. Silakan coba lagi.' });
    }

    payments[reference].duitkuReference = response.data.referenceNo;
    savePayments(payments);

    res.json({ paymentUrl, reference });
  } catch (err) {
    console.error('Duitku create invoice error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Gagal menghubungi payment gateway. Silakan coba lagi.' });
  }
});

// POST /api/payment/callback — webhook dari Duitku
app.post('/api/payment/callback', (req, res) => {
  const { merchantCode, paymentId, paymentAmount, merchantOrderId, resultCode, signature } = req.body;

  // Verifikasi signature: format baru MD5(merchantCode + amount + apiKey + merchantOrderId)
  const expectedNew = crypto
    .createHash('md5')
    .update(merchantCode + paymentAmount + API_KEY + merchantOrderId)
    .digest('hex');

  // Format lama (fallback): MD5(merchantCode + paymentId + amount + apiKey)
  const expectedOld = crypto
    .createHash('md5')
    .update(merchantCode + paymentId + paymentAmount + API_KEY)
    .digest('hex');

  const receivedSig = (signature || req.headers['x-duitku-signature'] || '').toLowerCase();

  if (receivedSig !== expectedNew.toLowerCase() && receivedSig !== expectedOld.toLowerCase()) {
    console.warn('Invalid Duitku callback signature', { receivedSig, expectedNew, expectedOld });
    return res.status(400).send('Invalid signature');
  }

  const payments = loadPayments();
  const reference = merchantOrderId;

  if (!payments[reference]) {
    return res.status(404).send('Reference not found');
  }

  // resultCode 00 = sukses
  if (resultCode === '00') {
    payments[reference].status = 'paid';
    payments[reference].paymentId = paymentId;
    payments[reference].paidAt = new Date().toISOString();
  } else {
    payments[reference].status = 'failed';
    payments[reference].resultCode = resultCode;
  }

  savePayments(payments);
  console.log(`Payment callback: ${reference} → ${payments[reference].status}`);
  res.status(200).send('OK');
});

// GET /payment/return — return page setelah checkout
app.get('/payment/return', (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-return.html'));
});

// GET /api/verify-payment/:reference — untuk bot Telegram verifikasi kode
app.get('/api/verify-payment/:reference', (req, res) => {
  const payments = loadPayments();
  const payment = payments[req.params.reference];

  if (!payment) {
    return res.status(404).json({ error: 'Kode referensi tidak ditemukan.' });
  }
  if (payment.status !== 'paid') {
    return res.status(402).json({ error: 'Pembayaran belum selesai.', status: payment.status });
  }

  res.json({
    reference: payment.reference,
    telegramUsername: payment.telegramUsername,
    plan: payment.plan,
    period: payment.period,
    amount: payment.amount,
    paidAt: payment.paidAt,
  });
});

// GET / — landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Finny website server running on http://localhost:${PORT}`);
});
