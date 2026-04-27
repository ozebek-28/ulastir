# CLAUDE.md — Proje Rehberi

Bu dosya Claude Code için proje rehberidir. Her oturumun başında okunur. Kod yazmadan önce buradaki kurallara uy. Yapı: önce projenin teknik mimarisi (Code tarafından repo incelenerek çıkarıldı), sonra proje sahibiyle yapılan kararlar (sabit kurallar olarak uy).

---

# 1. Teknik Mimari (repodan çıkarıldı)

## 1.1 Proje Özeti
**Ulaştır Şoför Performans ve Operasyon Takip Sistemi.** Araç GPS konumlarını Arvento'dan SOAP üzerinden çeker, Supabase'e yazar, zone giriş/çıkışlarını yakalar, otomatik sefer kaydı oluşturur ve aylık prim skoru hesaplar.

Şu an repo sadece **Node.js otomasyon servisi**ni içeriyor (Railway'de canlı). Frontend (Next.js) henüz yok — bu projeye eklenecek.

## 1.2 Klasör Yapısı (mevcut)

```
/
├── otomasyon.js               Ana Node.js servis (Arvento poll + zone motor + cron)
├── zone_engine.js             Eski/alternatif motor (Arvento REST varsayan, kullanılmıyor pratikte)
├── package.json               Node 18+, deps: dotenv, node-cron, node-fetch v2
├── supabase_tam_schema_v2.sql Ana şema (routes, drivers, zones, contracts, trips, zone_events, performance_scores) + view'lar
├── supabase_vehicle_states.sql vehicle_states tablosu (anlık zone durumu)
├── supabase_otomasyon.sql     daily_snapshots tablosu + take_daily_snapshot() + calc_monthly_scores() RPC'leri + pg_cron schedule'ları
├── .env.example               Env şablon (DİKKAT: stale — aşağıya bak)
├── .gitignore
└── README.md                  Railway deploy ve sorun giderme
```

**Frontend gelince eklenecek:** `/frontend` klasörü (Next.js, ayrı npm projesi).

## 1.3 Servis Mimarisi (otomasyon.js)

```
┌─────────────┐  SOAP/30s   ┌──────────────────┐
│   Arvento   │ ──────────▶ │  otomasyon.js    │
│  (SOAP WS)  │             │  (Railway)       │
└─────────────┘             └────────┬─────────┘
                                     │ REST
                                     ▼
                            ┌──────────────────┐
                            │     Supabase     │
                            │  PostgREST + RLS │
                            └──────────────────┘
```

**Akış:**
1. `start()` → env doğrula (fail-fast), cache yükle, health server başlat, polling interval kur, cron'ları kur.
2. `pollLocations()` her `LOCATION_POLL_SECONDS` (default 30) saniyede:
   - Cache 5 dakikadan eskiyse `refreshCache()` (zones + drivers).
   - `fetchArventoPositions()` → Arvento SOAP `GetVehicleStatus`.
   - Her pozisyon için `processPosition()` → zone tespit, zone değişimi, sefer oluşturma, vehicle_states upsert.
3. `cron`: 23:59 TR → `take_daily_snapshot` RPC; her ayın 1'i 00:01 TR → `calc_monthly_scores` RPC.

**Health endpoint:** `PORT` env varsa HTTP server açılır. `GET /` → `{status, zones, drivers, arventoPlateMap}` JSON.

## 1.4 Arvento SOAP Entegrasyonu

- **Endpoint:** `http://ws.arvento.com/v1/report.asmx` (default, env ile override edilebilir).
- **Auth:** `ARVENTO_USERNAME` + `ARVENTO_PIN1` + `ARVENTO_PIN2` (her SOAP body'sine eklenir).
- **Çağrılan metodlar:**
  - `GetLicensePlateNodeMappings` — Device_No → Plaka eşleşmesi (15 dakika cache).
  - `GetNodes` — fallback (ilki boş dönerse).
  - `GetVehicleStatus` — anlık konum (lat/lng/speed/timestamp).
- **Tag tolerance:** Arvento sürümleri farklı tag isimleri kullanır (`Device_x0020_No`, `DeviceNo`, `Node` vb.) — `pickFirst()` ile çoklu deneme yapılır. XML escape karakterleri (`x0020` = boşluk, `x002F` = `/`) elle decode edilir.
- **DEBUG:** İlk çağrıda her metod için ham XML'in ilk 3000 karakteri loglanır (`debugArventoLogged` flag'i).
- **Plate mapping:** `plateByDeviceNo` Map cache; eşleşmeyen device'lar `skippedNoPlate` sayacında atlanır.

## 1.5 Supabase Veri Modeli

| Tablo | Amaç | Önemli alanlar |
|-------|------|----------------|
| `routes` | Hat tanımları + referans metrikler (yakıt, süre, rölanti, boş km, sefer/gün) | `code`, `ref_*`, `min_trips_required`, `min_km_required`, `is_pilot` |
| `drivers` | Şoför + araç plakası eşleşmesi | `vehicle_plate`, `route_id`, `is_active` |
| `zones` | Coğrafi bölgeler (yükleme/boşaltma noktaları) | `latitude`, `longitude`, `radius_meters`, `zone_type` ∈ {yukleme, bosaltma, her_ikisi} |
| `contracts` | Zone A ↔ Zone B kontratları + fiyat | `origin_zone_id`, `destination_zone_id`, `price_type` ∈ {sabit, ton_bazli, karma}, `fixed_price_tl`, `price_per_ton_tl` |
| `trips` | Sefer kayıtları (otomatik veya manuel) | `data_source` ∈ {manual, arvento_csv, arvento_api}, `is_excluded`, hesaplanan: `empty_km_pct`, `fuel_per_100km`, `trip_revenue_tl` |
| `zone_events` | Her zone giriş/çıkış olayı | `event_type` ∈ {giris, cikis} |
| `vehicle_states` | Aracın anlık zone durumu (1 satır/araç, unique plate) | `current_zone_id`, `active_trip_origin_zone_id`, `active_trip_started_at` |
| `performance_scores` | Aylık şoför skoru (driver × yıl × ay unique) | `weighted_score`, `performance_index`, `bonus_band` ∈ {yuksek, normal, dusuk, yok}, `has_sufficient_data` |
| `daily_snapshots` | Günlük operasyon özeti | `snapshot_date` unique |

## 1.6 View'lar

- `daily_summary` — `trips`'ten günlük toplam sefer/araç/ton/yakıt/idle/boş km/gelir.
- `driver_performance_30d` — Son 30 günde her şoförün ortalama metrikleri ve hat referansından sapması (`fuel_delta`, `duration_delta`, `idle_delta`, `empty_km_delta`).
- `route_stats_30d` — Hat bazında 30 günlük ortalama + standart sapma (skor hesabında kullanılır).
- `contract_revenue_summary` — Kontrat bazında toplam sefer/ton/gelir.

## 1.7 İş Kuralları

**Zone tespit (Haversine):**
- Araç pozisyonu zone merkezinden `radius_meters` içindeyse o zone'da sayılır.
- Aynı anda birden fazla zone'a denk gelirse `zones.find()` ile **ilk eşleşen** alınır (sıra deterministik değil; zone'ları çakıştırma).

**Sefer (trip) oluşturma:**
- Zone A'dan çıkış → bir süre dışarıda → Zone B'ye giriş = sefer.
- `vehicle_states.active_trip_origin_zone_id` zone'dan çıkışta set edilir, başka zone'a girişte `createTrip` çağrılır.
- Kontrat eşleşmesi A→B veya B→A (yön ayırt edilmez).
- `trip_duration_hr` = (ended_at − started_at) saat cinsinden.
- `data_source = 'arvento_api'` otomatik gelen seferler için.

**Trigger `calc_trip_metrics()` (trips tablosu, before insert/update):**
- `empty_km_pct = empty_km / total_km × 100`
- `fuel_per_100km = fuel_liters / total_km × 100`
- `trip_revenue_tl`:
  - `sabit` → `fixed_price_tl`
  - `ton_bazli` → `price_per_ton_tl × cargo_tons`
  - `karma` → `fixed_price_tl + (price_per_ton_tl × cargo_tons)`
  - Ton önceliği: `cargo_tons_confirmed` > `cargo_tons` > 0.

**Aylık prim skoru `calc_monthly_scores()`:**
- Yeterlilik: en az 10 sefer **VE** 500 km — yoksa `bonus_band='yok'`, `has_sufficient_data=false`.
- Z-skor mantığı: her metrik için `(hat_ortalaması − şoför_ortalaması) / hat_stddev` (yakıt/süre/idle/boş km — düşük olan iyi; sefer/gün ters: `(şoför − hat) / stddev`).
- Ağırlıklar: yakıt %30, süre %25, rölanti %15, boş km %15, sefer %15.
- `performance_index = 100 + 10 × weighted_score`.
- Bant: `≥110 yuksek`, `≥105 normal`, `≥100 dusuk`, `<100 yok`.

**pg_cron + Node cron paralel çalışır:**
- `take_daily_snapshot` ve `calc_monthly_scores` hem Supabase pg_cron'dan hem otomasyon.js'ten tetiklenir.
- Idempotent (`on conflict do update`) — sorun yok ama gözlem altında (bkz. teknik borç).

## 1.8 Komutlar

```bash
npm install          # bağımlılıklar
npm start            # production: node otomasyon.js
npm run dev          # geliştirme: node --watch otomasyon.js
```

**Env (otomasyon.js için zorunlu):**
- `SUPABASE_URL`, `SUPABASE_KEY` (anon)
- `ARVENTO_USERNAME`, `ARVENTO_PIN1`, `ARVENTO_PIN2`
- Opsiyonel: `ARVENTO_API_URL`, `LOCATION_POLL_SECONDS`, `PORT`

## 1.9 Kod Tarzı (mevcut Node.js servisinde gözlemlenen)

- CommonJS (`require`), Node 18+.
- `async/await` her yerde, `.then()` zinciri yok.
- Türkçe konsol logları (`[Cache]`, `[Poll]`, `[Arvento]`, `[Cron]`, emoji prefix `🟢🔴✅`).
- Türkçe yorumlar, İngilizce identifier'lar.
- Yorum başlıkları `// ── Başlık ──` veya `// ====...===` blokları.
- Basit fonksiyonlar, helper'lar dosya içinde (haversine, XML decode, escape).
- Hata yönetimi: kritik kodda `try/catch`, kritik olmayan beklenen hatalarda boş catch (örn. kontrat bulunamadı).
- Cache pattern: in-memory Map/array + zaman damgası + TTL kontrolü.

## 1.10 Deploy

- **Otomasyon servisi:** Railway (ücretsiz kredi, `npm start` otomatik). Frontend GELDİĞİNDE Vercel.
- **Supabase:** Hosted (us-east, plan: free veya pro — değişebilir).
- Production env Railway/Vercel panelinden, asla repoda değil.

---

# 2. Proje Sahibiyle Kararlaştırılan Bilgiler (Bekir ile yapıldı, sabit kural)

## 2.1 Çalışma şekli (yeni iş bölümü)
- **Bekir** (proje sahibi): vizyon, karar, prompt onayı. Manuel kod yazmıyor.
- **Claude** (sohbet asistanı, başka bir oturum): strateji, planlama, prompt yazımı, Bekir'le diyalog.
- **Claude Code** (sen): tüm uygulama. Dosya oluşturma, kod yazımı, kütüphane kurulumu, git komutları, dev server çalıştırma.
- Sen Bekir'le doğrudan teknik detayları konuşmak yerine, gelen prompt'a göre uygula. Belirsizlik varsa kısa ve net soru sor, varsayım yapma.

## 2.2 Kullanıcılar (frontend için)
- Sahibi (uzaktan, ABD'den)
- Ofisteki operasyon sorumlusu (Türkiye'de)
- Şoförler frontend'i KULLANMAYACAK. Performans bilgileri yönetim tarafından sözlü açıklanacak.

## 2.3 Frontend kararları (v1)
- **Stack:** Next.js 14+ App Router, TypeScript, Tailwind CSS
- **Harita kütüphanesi:** Leaflet + OpenStreetMap (Google Maps KULLANMA — faturalandırma istemiyoruz)
- **Auth:** Şu an BYPASS (MVP). Ama sayfaları `(authenticated)` route group ile sarmaya hazır şekilde organize et.
- **Hosting:** Vercel (frontend), Railway (otomasyon servisi zaten orada)
- **Konum:** `/frontend` klasörü (kök dizinde, Node.js servisinden ayrı npm projesi)
- **Dil:** TypeScript
- **UI dili:** Türkçe (variable/function isimleri İngilizce)

## 2.4 v1 Sayfa Listesi (öncelik sırasıyla)
1. `/` (anasayfa) → Canlı Harita: araçlar + zone'lar + rotalar üst üste; çalışmayan ve rota dışı araç uyarıları
2. `/dashboard` → Günlük Özet: `daily_summary` view'ından metrik kartları
3. `/performance` → Şoför Performans Tablosu: `driver_performance_30d` + `performance_scores` (aylık prim bandı)
4. `/zones` → Zone Yönetimi: harita üzerinden ekle/düzenle, yarıçap ayarla
5. `/drivers` → Şoför ve Araç CRUD ekranı
6. `/contracts` → Kontrat CRUD + fiyat geçmişi

## 2.5 V2'ye ertelenen kararlar (v1'de YAPMA)
- Gerçek "rota dışı" tespiti (OSRM/Directions ile polyline). v1'de sadece "zone'larda olmayan veya N saattir hareketsiz araç" uyarısı yeterli.
- Supabase Auth (şu an bypass)
- Şoförlerin kendi performans ekranı
- Quarry sistemi adaptasyonu (ayrı proje olacak)

## 2.6 Mevcut teknik borç (v1'de elleme, sadece bil)
- RLS policy'leri tüm tablolarda açık (`using true, with check true`). Frontend auth eklenince daraltılacak.
- Trip detection'da min süre/min mesafe filtresi yok (GPS jitter yanlış sefer oluşturabilir)
- `driver_id` mapping live Arvento için tam değil (plakayla eşleştirme yapılıyor)
- pg_cron + Node cron paralel çalışıyor (idempotent, sorun yok ama gözlem altında)
- `.env.example` stale: hâlâ `ARVENTO_API_KEY` yazıyor, oysa `otomasyon.js` v2.3 `ARVENTO_USERNAME/PIN1/PIN2` istiyor. Yeni env değişikliği yaparken bu dosyayı da güncelle.
- `zone_engine.js` repoda duruyor ama kullanılmıyor (otomasyon.js'in eski/REST varsayan versiyonu). v1'de elleme.

## 2.7 Bekir'in çalışma tarzı (önemli)
- Önce planla, sonra kod yaz. Karmaşık değişikliklerde önce ne yapacağını anlat.
- Adım adım git. Madde bittikten sonra durup teyit bekle.
- Varsayım yapma, belirsizlikte sor.
- Hata olursa sessizce devam etme, dur ve söyle.
- Kısa ve net konuş, dolduruşlu metin yazma.
- Türkçe yorumlar ve UI metinleri.

## 2.8 Güvenlik (sıkı)
- `.env`, `.env.local` ASLA commit edilmez
- Gerçek `SUPABASE_KEY`, `ARVENTO_PIN`, vb. kod içine yazılmaz, sadece `.env.example`/`.env.local.example`'da boş şablon
- Frontend'de `NEXT_PUBLIC_` prefix'li env'ler tarayıcıya açılır → sadece anon key, `service_role` key ASLA
- Yeni env eklendiğinde `README.md` ve `.env.example` güncellensin

## 2.9 Stil
- Sade tasarım. Dekoratif animasyon, gradient, gölge yok. Düz yüzey, ince kenar, açık tema.
- `async/await` kullan, callback veya `.then()` zinciri değil.
- Dosya başına bir sorumluluk.
- Hata yönetimi: kritik kodda `try/catch` zorunlu.
