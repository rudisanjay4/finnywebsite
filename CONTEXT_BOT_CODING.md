# Konteks Coding — Bot Finny (Fly.io)

Dokumen ini adalah referensi lengkap sebelum mulai coding perubahan di bot. Baca sampai selesai sebelum menyentuh kode.

---

## Gambaran Sistem

```
finny.id (Netlify — static HTML)
    ↕ HTTP (fetch)
finny-bot-staging.fly.dev (Bot Telegram — Express.js)
    ↕ Supabase JS SDK
Supabase (PostgreSQL)
    ↕ Webhook
Duitku (Payment Gateway)
```

- **Frontend** sudah selesai di-deploy ke main. Tidak perlu diubah lagi.
- **Bot** yang perlu diupdate — inilah yang akan dikerjakan.
- **Supabase** perlu 1 perubahan schema saja.

---

## Alur Lengkap (End-to-End)

```
1. User buka finny.id → klik "Pilih Lite/Pro"
2. Modal checkout muncul → user isi email + pilih periode → klik "Bayar Sekarang"
3. Frontend: POST /api/web-payment/create  { plan, period, email }
4. Bot: generate reference "FINNY_WEB_<ts>_<rand>", buat invoice Duitku,
         simpan ke tabel subscriptions (status: pending)
         → response: { paymentUrl, reference }
5. Frontend: redirect browser ke paymentUrl (halaman Duitku)
6. User bayar di Duitku
7. Duitku: POST /payment/callback ke bot
8. Bot: update subscriptions status → 'paid', kirim email kode aktivasi ke user
9. Duitku: redirect user ke /payment/return (halaman konfirmasi)
10. User buka Telegram → ketik /aktivasi FINNY_WEB_...
11. Bot: verifikasi kode → aktifkan plan → update subscriptions
        → balas konfirmasi ke user
```

---

## Database — Tabel `subscriptions`

### Schema yang sudah ada

| Kolom | Tipe | Keterangan |
|---|---|---|
| `user_id` | BIGINT | Telegram user ID (diisi saat /aktivasi) |
| `plan` | VARCHAR | `lite` atau `pro` |
| `period` | VARCHAR | `monthly` atau `yearly` |
| `amount` | INTEGER | Nominal dalam rupiah (4900, 49000, dll) |
| `gateway` | VARCHAR | Selalu `duitku` untuk web payment |
| `gateway_trx_id` | VARCHAR | Reference code: `FINNY_WEB_<ts>_<rand>` |
| `status` | VARCHAR | `pending` → `paid` → (setelah /aktivasi: update user) |
| `paid_at` | TIMESTAMP | Diisi saat Duitku callback masuk |
| `expires_at` | TIMESTAMP | Diisi saat user jalankan /aktivasi |
| `created_at` | TIMESTAMP | Diisi saat record dibuat |

### Perubahan schema yang perlu dijalankan di Supabase

```sql
ALTER TABLE subscriptions ADD COLUMN email VARCHAR;
```

Kolom `email` dibutuhkan untuk:
- Kirim kode aktivasi ke email user setelah bayar
- Fitur "kirim ulang kode" jika user lupa

---

## API Endpoints yang Perlu Dibuat/Diubah di Bot

### 1. `POST /api/web-payment/create` ← **UBAH**

Sudah ada, tapi perlu menerima `email` dan menyimpannya ke DB.

**Request dari frontend:**
```json
{ "plan": "lite", "period": "monthly", "email": "user@gmail.com" }
```

**Yang perlu diubah:**
- Tambah `email` dari `req.body`
- Simpan `email` ke tabel `subscriptions` saat insert

**Response (tidak berubah):**
```json
{ "paymentUrl": "https://...", "reference": "FINNY_WEB_1234_ABC" }
```

---

### 2. `POST /payment/callback` ← **UBAH**

Sudah ada. Perlu ditambah: kirim email ke user setelah status jadi `paid`.

**Yang perlu ditambah setelah update status:**
```
ambil data subscription (termasuk email) by gateway_trx_id
→ jika email ada → kirim email kode aktivasi
```

---

### 3. `GET /api/web-payment/verify/:reference` ← **TIDAK BERUBAH**

Dipanggil oleh bot sendiri saat user ketik `/aktivasi`. Verifikasi apakah kode valid, sudah dibayar, dan belum dipakai.

---

### 4. `POST /api/web-payment/activate` ← **TIDAK BERUBAH**

Dipanggil oleh bot sendiri setelah verifikasi sukses. Tandai kode sudah dipakai dan update `user_id` + `expires_at`.

---

### 5. `POST /api/web-payment/resend-code` ← **BARU**

Dipanggil dari frontend ketika user klik "Kirim Ulang Kode Aktivasi".

**Request:**
```json
{ "email": "user@gmail.com" }
```

**Logic:**
1. Validasi email ada
2. Cari subscription by email, status `paid`, order by `paid_at` DESC, limit 1
3. Jika tidak ketemu → 404
4. Kirim ulang email kode aktivasi
5. Response `{ ok: true }`

---

## Email — Setup & Template

### Konfigurasi (nodemailer + Gmail)

```js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'financialfinny@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD  // App Password, bukan password Google biasa
  }
});
```

**Cara buat Gmail App Password:**
Google Account → Security → 2-Step Verification → App passwords → buat baru → copy hasilnya

**Set ke Fly.io:**
```bash
fly secrets set GMAIL_APP_PASSWORD=xxxx --app finny-bot-staging
```

### Template Email

```js
async function sendActivationEmail(email, reference, plan, period) {
  const planLabel   = plan === 'lite' ? 'Lite' : 'Pro';
  const periodLabel = period === 'monthly' ? 'Bulanan' : 'Tahunan';

  await transporter.sendMail({
    from: '"Finny" <financialfinny@gmail.com>',
    to: email,
    subject: `Kode Aktivasi Paket ${planLabel} Finny`,
    text: [
      `Halo! Pembayaran paket ${planLabel} (${periodLabel}) kamu berhasil.`,
      ``,
      `Kode aktivasi kamu: ${reference}`,
      ``,
      `Cara aktivasi:`,
      `1. Buka @fibuddy_bot di Telegram`,
      `2. Kirim perintah: /aktivasi ${reference}`,
      ``,
      `Simpan email ini jika sewaktu-waktu butuh kode lagi.`,
      ``,
      `— Tim Finny`
    ].join('\n')
  });
}
```

---

## Environment Variables

### Sudah ada (jangan diubah)
```
DUITKU_MERCHANT_CODE=...
DUITKU_API_KEY=...
WEBHOOK_DOMAIN=https://finny-bot-staging.fly.dev
FRONTEND_URL=https://finny.id
```

### Perlu ditambahkan
```
GMAIL_APP_PASSWORD=<app-password-16-karakter-dari-google>
```

---

## CORS

Bot perlu allow request dari `finny.id`. Tambahkan middleware ini **sebelum semua route** di `app.js`:

```js
app.use((req, res, next) => {
  const allowed = process.env.FRONTEND_URL || 'https://finny.id';
  const origin  = req.headers.origin;
  if (origin === allowed) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
```

---

## Harga (PLAN_AMOUNTS)

```js
const PLAN_AMOUNTS = {
  lite: { monthly: 4900,  yearly: 49000  },
  pro:  { monthly: 14900, yearly: 149000 },
};
```

---

## Format Reference Code

```js
function generateReference() {
  const ts   = Date.now();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FINNY_WEB_${ts}_${rand}`;
  // Contoh: FINNY_WEB_1746123456789_A3BX9Z
}
```

---

## Command `/aktivasi` di Bot

Dipanggil user lewat Telegram setelah bayar. Alur:

```
1. Parse kode dari args[0]
2. Validasi format: harus diawali "FINNY_WEB_"
3. Cari di tabel subscriptions by gateway_trx_id
4. Cek status = 'paid'
5. Cek user_id masih null (belum dipakai)
6. Hitung expires_at: +1 bulan (monthly) atau +12 bulan (yearly)
7. Update subscriptions: set user_id, expires_at
8. Update plan user di tabel users
9. Balas konfirmasi ke user
```

---

## Checklist Sebelum Deploy

- [ ] Jalankan `ALTER TABLE subscriptions ADD COLUMN email VARCHAR` di Supabase
- [ ] Set `GMAIL_APP_PASSWORD` di Fly.io secrets
- [ ] CORS middleware sudah dipasang sebelum semua route
- [ ] `POST /api/web-payment/create` menerima dan menyimpan `email`
- [ ] `POST /payment/callback` kirim email setelah status `paid`
- [ ] `POST /api/web-payment/resend-code` endpoint baru berjalan
- [ ] Command `/aktivasi` berjalan dan update tabel `subscriptions`

## Checklist Testing Staging

- [ ] `POST /api/web-payment/create` → response `{ paymentUrl, reference }`
- [ ] Buka `paymentUrl` → Duitku sandbox checkout muncul
- [ ] Bayar dengan test Duitku → callback masuk → status `paid` di DB
- [ ] Email kode aktivasi masuk ke inbox
- [ ] `/aktivasi FINNY_WEB_...` di bot → plan aktif, pesan sukses
- [ ] `/aktivasi` kode yang sama lagi → pesan error "sudah digunakan"
- [ ] Form "Kirim Ulang" di website dengan email yang sama → email terkirim ulang
- [ ] Form "Kirim Ulang" dengan email yang tidak ada → pesan error
