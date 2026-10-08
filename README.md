# DatçaMis API

Bağımsız commerce API. Frontend ile yalnızca HTTP JSON konuşur; ortak paket veya monorepo yoktur.

## Yığın

Node.js, TypeScript, Fastify, PostgreSQL, Prisma, Zod, Argon2id, httpOnly çerez içinde JWT erişim jetonu ve döndürülen yenileme jetonu.

## Ortam

`.env.example` dosyasını `.env` olarak kopyalayın. Development ve production sırları, veritabanı ve origin listesi ayrıdır. Ödeme, kargo ve S3/R2 alanları credential gelene kadar boş bırakılır; sağlayıcı katmanı `unconfigured` döner.

Yerel küme bu makinede `127.0.0.1:5434` üzerindedir. Başlatmak için:

```powershell
..\scripts yoksa PostgreSQL bin:
& "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" -D "..\.local-pgdata" -l "..\.local-pg.log" -o "-p 5434" start
```

## Komutlar

```bash
npm run db:deploy
npm run db:seed
npm run dev
npm run typecheck
npm test
```

Seed fiyat, stok ve metinler test kaydıdır. Yönetici e-postası `SEED_ADMIN_EMAIL` değerindedir.

## Sözleşme

Tüm yanıtlar `{ data, meta? }` veya `{ error: { code, message, details? } }` şeklindedir. Para alanları kuruş cinsinden tam sayıdır (`priceAmount`, `totalAmount`). Sipariş satırları ürün adı, SKU ve birim tutarını sipariş anında kopyalar.
