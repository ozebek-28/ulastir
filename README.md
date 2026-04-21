# Şoför Takip — Otomasyon Servisi

Araç konumlarını takip eder, zone giriş/çıkışlarını yakalar, otomatik sefer oluşturur. Günlük snapshot ve aylık prim skoru için Supabase RPC fonksiyonlarını tetikler.

## Mimari

```
┌─────────────┐   her 30s   ┌──────────────────┐
│   Arvento   │ ──────────▶ │  Bu servis       │
│  (veya sim) │             │  (otomasyon.js)  │
└─────────────┘             └────────┬─────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │     Supabase     │
                            │  zones, trips,   │
                            │  zone_events...  │
                            └──────────────────┘
```

Arvento API key'i yoksa **simulation** modunda çalışır: şoförlerin plakalarını alır, zone'lar arasında rastgele konumlar üretir, tüm pipeline'ı (zone event → trip oluşturma → skor) canlı ortamda olduğu gibi test eder.

## Gerekli Environment Variables

| Variable | Zorunlu | Açıklama |
|----------|---------|----------|
| `SUPABASE_URL` | ✅ | `https://xxx.supabase.co` |
| `SUPABASE_KEY` | ✅ | Supabase anon key |
| `ARVENTO_API_KEY` | ❌ | Yoksa simulation modu |
| `ARVENTO_API_URL` | ❌ | Default: `https://web.arvento.com/rest` |
| `LOCATION_POLL_SECONDS` | ❌ | Default: `30` |

## Lokal Test

```bash
npm install
cp .env.example .env
# .env dosyasını aç, SUPABASE_URL ve SUPABASE_KEY'i doldur
npm start
```

Konsol çıktısında şunu görmelisin:

```
═══════════════════════════════════════
 Şoför Takip — Otomasyon Servisi v1.0
  Mod: SIMULATION
  Supabase: https://xxx.supabase.co
═══════════════════════════════════════
[Cache] 4 zone, 8 şoför yüklendi
[Zamanlayıcı] Konum polling: her 30s
[Poll] 8 araç konumu alındı
🟢 GİRİŞ: 34 AB 112 → Fabrika
🔴 ÇIKIŞ: 34 AB 112 ← Fabrika
✅ Sefer: 34 AB 112 | Fabrika → Depo | 0.5s | Kontrat: var
```

## Production Deploy — Railway (önerilen, ücretsiz test için)

Railway ücretsiz kredi verir (~$5/ay), bu servis çok az kaynak kullandığı için pratikte bedava çalışır.

### 1. GitHub'a Push

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADIN/sofor-takip.git
git push -u origin main
```

> ⚠️ `.env` dosyasını **ASLA** commit etme. `.gitignore` zaten engelliyor ama yine de push öncesi `git status` ile kontrol et.

### 2. Railway Kurulum

1. [railway.app](https://railway.app) → GitHub ile giriş
2. **New Project** → **Deploy from GitHub repo** → az önce push'ladığın repoyu seç
3. Railway otomatik algılayıp `npm start` komutunu çalıştırır
4. **Variables** sekmesine git, şunları ekle:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - (Arvento key gelince) `ARVENTO_API_KEY`
5. **Deployments** sekmesinden logları izle

### 3. Logları İzleme

Railway Dashboard → servise tıkla → **Deployments** → **View Logs**.

Her 30 saniyede `[Poll] N araç konumu alındı` görmelisin. Supabase tarafında `zone_events` ve `trips` tabloları dolmaya başlamalı.

### 4. Durdurma / Silme

Railway'de proje → **Settings** → **Delete Project**. Kredi harcamasın diye test bittiğinde kapat.

## Production Deploy — Vercel (alternatif)

Vercel **serverless**, bu yüzden `setInterval` çalışmaz. Vercel'e deploy etmek için kodu cron-tetiklemeli API route'lara çevirmek gerekir (şu an bu repoda yok). Railway çalışır durumdayken Vercel gerekmiyor.

## Supabase Tarafı

İlk kurulum için Supabase SQL Editor'de sırasıyla çalıştır:

1. `supabase_tam_schema_v2.sql` — ana şema (routes, drivers, zones, contracts, trips, zone_events, performance_scores)
2. `supabase_vehicle_states.sql` — araç durum tablosu
3. `supabase_otomasyon.sql` — günlük snapshot ve aylık skor fonksiyonları + pg_cron

Bu servis çalışırken Supabase tarafında `pg_cron` de paralel çalışır; yani günlük snapshot hem bu servisten hem Supabase'den tetiklenebilir (idempotent, sorun yok).

## Güvenlik Notu

- Supabase `anon` key tarayıcıdan da kullanılabilen public bir key. Ama yine de git'e gömülmemeli — RLS politikaları değiştiğinde veya yanlış key'i paylaşmamak için.
- Arvento key geldiğinde de **kesinlikle** environment variable olarak ekleyin, koda yazmayın.

## Sorun Giderme

**`[Poll] 0 araç konumu alındı`** → `drivers` tablosunda `is_active=true` ve `vehicle_plate` dolu kayıt yok. Supabase'den kontrol edin.

**`[Uyarı] Zone tanımlanmamış`** → `zones` tablosu boş veya hepsi `is_active=false`. En az bir zone ekleyin.

**`Supabase [401]`** → `SUPABASE_KEY` yanlış. Supabase Dashboard → Settings → API → `anon public` key'i kopyalayın.
