# Integrasi Payment Duitku ke Finny Bot

## 📋 Overview

Implementasi lengkap payment gateway Duitku untuk mendukung tier system (Free, Lite, Pro) pada Finny Bot. Fitur ini memungkinkan user mengupgrade dari paket gratis ke Lite (Rp 4.900/bulan atau Rp 49.000/tahun) atau Pro (Rp 14.900/bulan atau Rp 149.000/tahun) dengan payment gateway Duitku.

**Status**: Deployed pada **staging** terhubung ke **Duitku Sandbox**. Belum di-merge ke main menunggu approval dari Duitku.

---

## 🔄 Payment Flow

```
User di Telegram Bot
    ↓
/upgrade atau feature limit → Mini App button
    ↓
GET /upgrade → pricing page (3 paket: Free, Lite, Pro)
    ↓ User klik "Pilih Lite" / "Pilih Pro"
GET /upgrade/confirm?plan=lite
    → Period selector (Bulanan/Tahunan)
    → Harga dinamis dari PLAN_AMOUNTS
    ↓ User klik "Bayar Sekarang"
POST /upgrade/pay
    → Create invoice via Duitku API (SHA256 signature)
    → Return paymentUrl + reference
    ↓
Browser redirect ke Duitku checkout (sandbox)
    ↓ User bayar
POST /payment/callback (webhook dari Duitku)
    → Verifikasi signature (MD5 fallback, new format)
    → Update users.plan + users.plan_expires_at
    → Insert payment record ke payments table
    → Send Telegram notification "🎉 Aktif!"
    ↓
GET /payment/return
    → Confirmation page (Telegram.WebApp.close())
```

---

## 📝 Files Modified

### 1. **services/duitku.js**

**Fungsi**: Service untuk komunikasi dengan Duitku API.

**Key Changes**:
- `createInvoice()` — Membuat invoice dengan SHA256 signature di header
  - Endpoint: `https://api-sandbox.duitku.com/webapi/api/merchant/invoice` (sandbox)
  - Headers: `x-duitku-signature`, `x-duitku-timestamp`, `x-duitku-merchantcode`
  - Body: JSON dengan `amount`, `reference`, `notificationUrl`, `returnUrl`, dll
  
- `verifySignature()` — Verifikasi callback dari Duitku
  - Format baru (preferred): MD5(`merchantCode + amount + apiKey + merchantOrderId`)
  - Format lama (fallback): MD5(`merchantCode + paymentId + amount + apiKey`)
  - Log signature yang diterima vs expected untuk debugging

- `PLAN_AMOUNTS` — Single source of truth untuk pricing
  ```javascript
  PLAN_AMOUNTS = {
    lite: { monthly: 4900, yearly: 49000 },
    pro: { monthly: 14900, yearly: 149000 }
  }
  ```

### 2. **routes/upgrade.js**

**Fungsi**: Pricing page dan payment initiation.

**Key Changes**:
- `/upgrade` — Render `upgrade.html` (3 paket pricing cards)
- `/upgrade/confirm` — Period selector + harga dinamis
  - Import `PLAN_AMOUNTS` dari `services/duitku.js` (sinkronisasi harga)
  - UI: Button untuk Monthly/Yearly, price display, loading overlay
- `/upgrade/pay` — POST endpoint untuk initiate payment
  - Validasi: `userId`, `plan` (lite/pro), `period` (monthly/yearly)
  - Call `duitku.createInvoice()` → return `paymentUrl` + `reference`

**Loading State**:
- Overlay dengan spinner saat menunggu invoice creation
- Prevent double-click: `isProcessing` flag
- Error message yang informatif jika gagal

### 3. **routes/payment.js**

**Fungsi**: Callback handler dan return page.

**Key Changes**:
- `/payment/callback` — Webhook dari Duitku
  - Extract: `merchantCode`, `paymentId`, `paymentAmount`, `signature`, `merchantOrderId`
  - Verifikasi signature dengan `duitku.verifySignature()`
  - Update user: `db.setUserPlan(userId, plan, 'duitku')`
  - Insert payments table: `user_id`, `payment_id`, `plan`, `period`, `status: 'paid'`, `gateway: 'duitku'`, `expires_at`
  - Send Telegram notification: "🎉 Paket Lite aktif sampai [tanggal]"

- `/payment/return` — Post-payment confirmation
  - Success/failure page
  - **PENTING**: Gunakan `Telegram.WebApp.close()` bukan `window.close()`
  - Fallback ke `window.close()` untuk non-Mini-App context
  - Auto-close 3 detik pada sukses

### 4. **handlers/Commands.js**

**Fungsi**: Bot commands.

**Key Changes**:
- `/status` — Status akun user
  ```
  📊 Status Akun Kamu

  Paket: Lite ✅
  Aktif sampai: 3 Mei 2027
  Sisa waktu: 365 hari

  Scan & voice bulan ini: 12 dari ∞
  ```
  - Query: `db.getUserPlan()`, `users.plan_expires_at`, media count

- `/admin activate` — Admin manually activate user
  - Update `users` table + insert `payments` table
  - Payment record: `gateway: 'manual'`, `status: 'paid'`, `reference: admin-<adminId>`

### 5. **jobs/scheduler.js**

**Fungsi**: Scheduled cron jobs.

**Key Changes**:
- **Renewal Reminder H-7** (jam 09:30 WIB / 02:30 UTC)
  ```javascript
  cron.schedule('30 2 * * *', async () => {
    // Cari user dengan plan_expires_at 6-8 hari ke depan
    // Send: "Langganan [Lite/Pro] akan berakhir dalam 7 hari"
    // Button: "🔄 Perpanjang Sekarang" → web_app /upgrade
  })
  ```

- **Plan Expiry Downgrade** (jam 00:00 WIB / 17:00 UTC)
  - Auto-downgrade ke Free jika `plan_expires_at` < now
  - Include `plan_source: ['cancelled', 'duitku', 'manual']`
  - Send detailed notification tentang batasan Free:
    - Scan & voice: 30x/bulan (vs unlimited di Lite)
    - Histori: 3 bulan (vs 12 bulan di Lite)
    - Budget: 1 kategori (vs unlimited di Lite)

### 6. **templates/upgrade.html**

**Fungsi**: Pricing page UI (Telegram Mini App).

**Key Changes**:
- 3 paket cards: Free (Gratis selamanya), Lite (POPULER badge), Pro
- Setiap paket: nama, harga, deskripsi, fitur list, button action
- **PENTING**: `selectPlan()` redirect semua plan (free, lite, pro) ke `/upgrade/confirm?plan=<plan>`
  - Hapus toast "Segera Hadir" yang blocking payment flow
  - Direct redirect untuk smooth UX

---

## 🔐 Security & API Details

### Duitku API Format (New)

**Create Invoice**:
```http
POST https://api-sandbox.duitku.com/webapi/api/merchant/invoice
x-duitku-signature: SHA256(merchant_code + invoice_reference + invoice_amount + webhook_url + return_url + api_key)
x-duitku-timestamp: 2024-12-30T10:00:00+07:00
x-duitku-merchantcode: FINNY_BOT

{
  "merchantCode": "FINNY_BOT",
  "reference": "FINNY_<userId>_<timestamp>",
  "amount": 4900,
  "currency": "IDR",
  "callbackUrl": "https://finny-bot.fly.dev/payment/callback",
  "returnUrl": "https://finny-bot.fly.dev/payment/return?reference=FINNY_...",
  "expirationTime": 1440,
  "itemName": "Paket Lite Bulanan",
  ...
}
```

**Response**:
```json
{
  "statusCode": "00",
  "statusMessage": "Success",
  "referenceNo": "DS29948265O7VC8F2FP37IY6",
  "paymentUrl": "https://app-sandbox.duitku.com/..."
}
```

**Callback Signature Verification**:
- New format: MD5(`merchantCode + amount + apiKey + merchantOrderId`)
- Old format (fallback): MD5(`merchantCode + paymentId + amount + apiKey`)
- Header: `X-DUITKU-SIGNATURE` (case-insensitive)

---

## 📊 Database Schema

### users table
```sql
user_id              BIGINT PRIMARY KEY
plan                 VARCHAR (free | lite | pro)
plan_expires_at      TIMESTAMP -- NULL jika plan = free
plan_source          VARCHAR (duitku | cancelled | manual | expired)
```

### payments table
```sql
id                   SERIAL PRIMARY KEY
user_id              BIGINT REFERENCES users
payment_id           VARCHAR UNIQUE -- dari Duitku atau generated
plan                 VARCHAR (lite | pro)
period               VARCHAR (monthly | yearly)
amount               INTEGER (Rp)
status               VARCHAR (pending | paid | failed | cancelled)
gateway              VARCHAR (duitku | manual | ...)
reference            VARCHAR -- Duitku reference atau admin note
merchant_order_id    VARCHAR
paid_at              TIMESTAMP
expires_at           TIMESTAMP
created_at           TIMESTAMP DEFAULT NOW()
updated_at           TIMESTAMP DEFAULT NOW()
```

---

## ✅ Verification Checklist

### Local Testing
- [ ] `npm test` — semua unit tests pass
- [ ] `npm run lint` — no linting errors

### Staging E2E Flow
1. **Pricing Page**
   - [ ] Open `/upgrade` di Telegram Mini App
   - [ ] Verify 3 paket cards render dengan harga correct

2. **Lite Selection**
   - [ ] Click "Pilih Lite"
   - [ ] Verify redirect ke `/upgrade/confirm?plan=lite`
   - [ ] Period selector (Bulanan/Tahunan) render dengan harga dari `PLAN_AMOUNTS`

3. **Payment Initiation**
   - [ ] Click "Bayar Sekarang"
   - [ ] Verify loading overlay appears
   - [ ] Verify redirect ke Duitku sandbox checkout URL
   - [ ] Check browser console: no JS errors

4. **Sandbox Payment**
   - [ ] Complete payment di Duitku sandbox (use test card)
   - [ ] Verify callback received: check server logs untuk signature verification
   - [ ] Check database: `payments` table has new record dengan `status: 'paid'`

5. **Activation**
   - [ ] Check `users` table: `plan` updated to 'lite', `plan_expires_at` set correctly
   - [ ] Verify Telegram notification sent: "🎉 Paket Lite aktif sampai [tanggal]"
   - [ ] `/status` command shows updated plan info

6. **Return Page**
   - [ ] Verify `/payment/return` displays confirmation
   - [ ] Click close button: Mini App closes (gunakan Telegram.WebApp.close)

7. **Cron Jobs**
   - [ ] Set user `plan_expires_at` to 7 days ahead
   - [ ] Wait for 09:30 WIB (02:30 UTC) → verify renewal reminder sent
   - [ ] Set `plan_expires_at` to past date
   - [ ] Wait for 00:00 WIB (17:00 UTC) → verify auto-downgrade + notification

### Production Pre-Launch
- [ ] Duitku approval received (merchant account approved)
- [ ] Switch to production Duitku API endpoint (`api.duitku.com`)
- [ ] Update env vars: `DUITKU_MERCHANT_CODE`, `DUITKU_API_KEY` (production)
- [ ] Update `WEBHOOK_DOMAIN` untuk production URL
- [ ] Merge feature branch ke main
- [ ] Deploy to production
- [ ] Test full flow dengan real payment method

---

## 🚀 Deployment Notes

### Staging (Current)
- Branch: `develop`
- Duitku: **Sandbox** (`api-sandbox.duitku.com`)
- Fly.io app: `finny-bot-staging`
- Auto-deployed saat push ke `develop`

### Production (Pending Approval)
- Branch: `main`
- Duitku: **Production** (`api.duitku.com`)
- Fly.io app: `finny-bot`
- Manual approval required sebelum deploy

---

## 🐛 Known Issues & Fixes

### Fixed Issues

1. **"Segera Hadir" Toast Blocking Payment**
   - **Root Cause**: Commit `1f9a301` added after tier system merge, added blocking toast untuk Lite/Pro
   - **Fix**: Remove `showComingSoon()` logic, direct redirect untuk semua plan

2. **Signature Verification Format**
   - **Root Cause**: Duitku API format berubah, callback menggunakan format baru
   - **Fix**: Try new format first (MD5 with `merchantOrderId`), fallback to old format dengan detailed logging

3. **Mini App Close Button**
   - **Root Cause**: `window.close()` tidak bekerja di Telegram Mini App
   - **Fix**: Use `Telegram.WebApp.close()` dengan fallback

4. **Price Hardcoding**
   - **Root Cause**: Harga di `/upgrade/confirm` hardcoded, tidak sinkron dengan `PLAN_AMOUNTS`
   - **Fix**: Import `PLAN_AMOUNTS` dari `services/duitku.js`, single source of truth

5. **Double-Click Prevention**
   - **Root Cause**: User bisa click "Bayar Sekarang" multiple times, create multiple invoices
   - **Fix**: `isProcessing` flag + disabled button state + loading overlay

---

## 📞 Support & Contacts

- **Duitku Support**: [Duitku Docs](https://docs.duitku.com)
- **Email**: financialfinny@gmail.com
- **Merchant Code**: FINNY_BOT (sandbox), TBD (production)

---

## 📚 Related Files

- Implementation: `services/duitku.js`, `routes/upgrade.js`, `routes/payment.js`, `handlers/Commands.js`, `jobs/scheduler.js`, `templates/upgrade.html`
- Database: `migrations/` untuk `users` dan `payments` table schema
- Environment: `.env.example` dengan `DUITKU_MERCHANT_CODE`, `DUITKU_API_KEY`, `WEBHOOK_DOMAIN`

---

**Last Updated**: 5 Mei 2026  
**Status**: ✅ Deployed to Staging (Sandbox)  
**Next**: Awaiting Duitku approval for production launch
