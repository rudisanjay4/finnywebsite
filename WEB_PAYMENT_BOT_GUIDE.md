# Web Payment Integration — Bot Fly.io

Dokumen ini berisi apa yang perlu ditambahkan ke **bot Fly.io** agar integrasi payment dari website `finny.id` bisa berjalan.

---

## Konteks

Website `finny.id` (Netlify) sudah punya:
- Pricing page dengan toggle Bulanan/Tahunan
- Checkout modal (pilih plan + periode → bayar)
- Tombol "Pilih Lite/Pro" → hit `POST /api/web-payment/create` ke Fly.io
- Setelah bayar → Duitku redirect ke `/payment/return` (sudah ada di bot)

Yang belum ada di bot: route web payment baru + command `/aktivasi`.

---

## 1. Tambah CORS

Di entry point bot (`app.js` / `index.js`), tambahkan **sebelum** route lain:

```javascript
app.use((req, res, next) => {
  const allowed = process.env.FRONTEND_URL || 'https://finny.id';
  const origin = req.headers.origin;
  if (origin === allowed) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
```

**Secret yang perlu di-set:**
```bash
fly secrets set FRONTEND_URL=https://finny.id --app finny-bot-staging
```

---

## 2. Buat Route Baru `routes/web-payment.js`

```javascript
const express = require('express');
const router = express.Router();
const duitku = require('../services/duitku');
const db = require('../services/db'); // sesuaikan path

// Pricing (sama dengan PLAN_AMOUNTS di services/duitku.js)
const PLAN_AMOUNTS = {
  lite: { monthly: 4900, yearly: 49000 },
  pro:  { monthly: 14900, yearly: 149000 },
};

function generateReference() {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FINNY_WEB_${ts}_${rand}`;
}

// POST /api/web-payment/create
// Dipanggil dari website finny.id saat user klik "Bayar Sekarang"
router.post('/create', async (req, res) => {
  const { plan, period } = req.body;

  if (!['lite', 'pro'].includes(plan)) {
    return res.status(400).json({ error: 'Plan tidak valid.' });
  }
  if (!['monthly', 'yearly'].includes(period)) {
    return res.status(400).json({ error: 'Period tidak valid.' });
  }

  const amount = PLAN_AMOUNTS[plan][period];
  const reference = generateReference();
  const itemName = `Paket ${plan === 'lite' ? 'Lite' : 'Pro'} ${period === 'monthly' ? 'Bulanan' : 'Tahunan'}`;

  try {
    // Pakai createInvoice() yang sudah ada di services/duitku.js
    // Sesuaikan parameter dengan signature fungsi yang ada
    const { paymentUrl } = await duitku.createInvoice({
      reference,
      amount,
      itemName,
      // returnUrl otomatis dari WEBHOOK_DOMAIN di services/duitku.js
    });

    // Simpan ke payments table di DB
    // Kolom yang dibutuhkan: reference, plan, period, amount, status, gateway, created_at
    await db.createPayment({
      reference,
      plan,
      period,
      amount,
      status: 'pending',
      gateway: 'duitku',
      merchant_order_id: reference,
    });

    res.json({ paymentUrl, reference });
  } catch (err) {
    console.error('web-payment create error:', err);
    res.status(502).json({ error: 'Gagal membuat invoice. Coba lagi.' });
  }
});

// GET /api/web-payment/verify/:reference
// Dipanggil bot saat user ketik /aktivasi <kode>
router.get('/verify/:reference', async (req, res) => {
  const { reference } = req.params;

  const payment = await db.getPaymentByReference(reference);

  if (!payment) {
    return res.status(404).json({ error: 'Kode tidak ditemukan.' });
  }
  if (payment.status !== 'paid') {
    return res.status(402).json({ error: 'Pembayaran belum selesai.', status: payment.status });
  }
  if (payment.activated_at) {
    return res.status(409).json({ error: 'Kode sudah pernah digunakan.' });
  }

  res.json({
    reference: payment.reference,
    plan: payment.plan,
    period: payment.period,
    amount: payment.amount,
    paidAt: payment.paid_at,
  });
});

// POST /api/web-payment/activate
// Dipanggil bot setelah berhasil aktifkan plan, untuk tandai kode sudah dipakai
router.post('/activate', async (req, res) => {
  const { reference, telegramUserId } = req.body;

  if (!reference || !telegramUserId) {
    return res.status(400).json({ error: 'reference dan telegramUserId wajib diisi.' });
  }

  const payment = await db.getPaymentByReference(reference);
  if (!payment)          return res.status(404).json({ error: 'Kode tidak ditemukan.' });
  if (payment.status !== 'paid') return res.status(402).json({ error: 'Belum dibayar.' });
  if (payment.activated_at)      return res.status(409).json({ error: 'Sudah digunakan.' });

  await db.markPaymentActivated(reference, telegramUserId);

  res.json({ ok: true, plan: payment.plan, period: payment.period });
});

module.exports = router;
```

**Daftarkan route di `app.js`:**
```javascript
const webPayment = require('./routes/web-payment');
app.use('/api/web-payment', webPayment);
```

---

## 3. Update DB — Tambah Kolom `activated_by` & `activated_at`

Tabel `payments` perlu dua kolom baru:

```sql
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS activated_by BIGINT,   -- telegram user_id yang aktivasi
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP; -- waktu aktivasi
```

Fungsi DB yang perlu ada:

```javascript
// Ambil payment berdasarkan reference (bukan payment_id)
db.getPaymentByReference(reference)

// Tandai kode sudah dipakai
db.markPaymentActivated(reference, telegramUserId)
// → UPDATE payments SET activated_by=$1, activated_at=NOW() WHERE reference=$2
```

---

## 4. Tambah Command `/aktivasi` di `handlers/Commands.js`

```javascript
if (command === 'aktivasi') {
  const kode = args[0];

  if (!kode || !kode.startsWith('FINNY_WEB_')) {
    return ctx.reply(
      '❌ Format salah.\n\nGunakan: /aktivasi <kode_referensi>\nContoh: /aktivasi FINNY_WEB_1234_ABC'
    );
  }

  try {
    // 1. Verifikasi kode
    const verifyRes = await fetch(
      `${process.env.WEBHOOK_DOMAIN}/api/web-payment/verify/${kode}`
    );
    const data = await verifyRes.json();

    if (verifyRes.status === 404) return ctx.reply('❌ Kode tidak ditemukan. Pastikan kode sudah benar.');
    if (verifyRes.status === 402) return ctx.reply('❌ Pembayaran untuk kode ini belum selesai.');
    if (verifyRes.status === 409) return ctx.reply('❌ Kode ini sudah pernah digunakan.');
    if (!verifyRes.ok)            return ctx.reply('❌ Gagal verifikasi. Coba lagi atau hubungi @finnyadmin.');

    const userId = ctx.from.id;

    // 2. Aktifkan plan di DB
    // Hitung expires_at berdasarkan period
    const months = data.period === 'yearly' ? 12 : 1;
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + months);

    await db.setUserPlan(userId, data.plan, 'duitku');
    // Jika setUserPlan belum set plan_expires_at, update manual:
    // await db.query('UPDATE users SET plan_expires_at=$1 WHERE user_id=$2', [expiresAt, userId]);

    // 3. Tandai kode sudah dipakai
    await fetch(`${process.env.WEBHOOK_DOMAIN}/api/web-payment/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: kode, telegramUserId: userId }),
    });

    // 4. Konfirmasi ke user
    const planLabel  = data.plan === 'lite' ? 'Lite' : 'Pro';
    const periodLabel = data.period === 'monthly' ? 'Bulanan' : 'Tahunan';
    const tglExpiry  = expiresAt.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

    return ctx.reply(
      `🎉 Paket ${planLabel} berhasil diaktifkan!\n\n` +
      `📦 Paket  : ${planLabel} (${periodLabel})\n` +
      `📅 Aktif s/d : ${tglExpiry}\n\n` +
      `Ketik /status untuk lihat detail akun kamu.`
    );

  } catch (err) {
    console.error('aktivasi error:', err);
    return ctx.reply('❌ Terjadi kesalahan. Silakan coba lagi.');
  }
}
```

---

## 5. Update Callback Handler `/payment/callback`

Pastikan callback yang sudah ada juga handle reference dari `FINNY_WEB_*` — khususnya saat update status ke `paid`. Tidak ada perubahan logic, hanya pastikan `merchant_order_id` tersimpan di kolom `reference` agar `getPaymentByReference()` bisa menemukannya.

---

## Checklist Testing Staging

- [ ] `POST https://finny-bot-staging.fly.dev/api/web-payment/create` — response `{ paymentUrl, reference }`
- [ ] Buka `paymentUrl` di browser → Duitku sandbox checkout muncul
- [ ] Bayar dengan test card Duitku → callback diterima → status `paid` di DB
- [ ] `/aktivasi FINNY_WEB_...` di bot → plan aktif, pesan sukses
- [ ] `/aktivasi` kode yang sama lagi → ❌ "Kode sudah pernah digunakan"
- [ ] `/status` di bot → tampilkan plan + tanggal expiry

---

## Ringkasan Alur Final

```
finny.id (Netlify)
  User klik "Pilih Lite" → modal → klik "Bayar Sekarang"
      ↓
  POST /api/web-payment/create  (finny-bot-staging.fly.dev)
      → simpan ke payments table (status: pending)
      → buat invoice Duitku
      ← { paymentUrl, reference: "FINNY_WEB_..." }
      ↓
  Browser redirect ke Duitku sandbox
      ↓ user bayar
  POST /payment/callback  (sudah ada)
      → update payments: status = paid
      ↓
  GET /payment/return  (sudah ada)
      → tampilkan kode referensi + instruksi /aktivasi
      ↓
  User ke Telegram → /aktivasi FINNY_WEB_...
      → verify: paid? belum dipakai?
      → setUserPlan()
      → markPaymentActivated()
      → 🎉 "Paket Lite berhasil diaktifkan!"
```
