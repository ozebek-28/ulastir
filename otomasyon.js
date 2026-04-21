// ============================================================
// Şoför Takip Sistemi — Node.js Otomasyon Servisi
// ============================================================
// Kurulum:
//   npm install
//
// Çalıştırma:
//   npm start
//
// Ortam değişkenleri (.env dosyası — .env.example'a bakın):
//   SUPABASE_URL
//   SUPABASE_KEY
//   ARVENTO_API_KEY   (opsiyonel — yoksa simulation modunda çalışır)
//   ARVENTO_API_URL   (opsiyonel)
//   LOCATION_POLL_SECONDS (opsiyonel, default 30)
// ============================================================

require('dotenv').config();

const cron  = require('node-cron');
const fetch = require('node-fetch');

// ── Konfigürasyon ──────────────────────────────────────────
const CONFIG = {
  SUPABASE_URL:    process.env.SUPABASE_URL,
  SUPABASE_KEY:    process.env.SUPABASE_KEY,
  ARVENTO_API_URL: process.env.ARVENTO_API_URL || 'https://web.arvento.com/rest',
  ARVENTO_API_KEY: process.env.ARVENTO_API_KEY || null,

  // Mod: 'simulation' = test, 'live' = gerçek Arvento
  MODE: process.env.ARVENTO_API_KEY ? 'live' : 'simulation',

  // Kaç saniyede bir Arvento'dan konum çekilsin
  LOCATION_POLL_SECONDS: parseInt(process.env.LOCATION_POLL_SECONDS || '30', 10),
};

// Kritik env var'lar yoksa hata ver
if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY) {
  console.error('❌ HATA: SUPABASE_URL ve SUPABASE_KEY environment variable olarak tanımlanmalı.');
  console.error('   .env dosyası oluşturun veya Railway/Vercel panelinden ekleyin.');
  console.error('   Örnek için .env.example dosyasına bakın.');
  process.exit(1);
}

// ── Supabase yardımcısı ────────────────────────────────────
const SB_HEADERS = {
  'apikey':        CONFIG.SUPABASE_KEY,
  'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY,
  'Content-Type':  'application/json',
  'Prefer':        'return=representation',
};

async function sb(path, opts = {}) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${path}`, {
    headers: SB_HEADERS,
    ...opts,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase [${res.status}]: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// ── Supabase RPC çağrısı ───────────────────────────────────
async function sbRpc(funcName) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/${funcName}`, {
    method:  'POST',
    headers: SB_HEADERS,
    body:    '{}',
  });
  if (!res.ok) throw new Error(`RPC ${funcName} hata: ${await res.text()}`);
  return res.json().catch(() => null);
}

// ── Haversine mesafe ───────────────────────────────────────
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function isInZone(lat, lng, zone) {
  return haversineMeters(lat, lng, zone.latitude, zone.longitude) <= zone.radius_meters;
}

// ── Cache ──────────────────────────────────────────────────
let zonesCache   = [];
let driversCache = [];
let cacheLoadedAt = null;

async function refreshCache() {
  zonesCache   = await sb('zones?is_active=eq.true');
  driversCache = await sb('drivers?is_active=eq.true');
  cacheLoadedAt = new Date();
  console.log(`[Cache] ${zonesCache.length} zone, ${driversCache.length} şoför yüklendi`);
}

// ── Arvento API ────────────────────────────────────────────
async function fetchArventoPositions() {
  if (CONFIG.MODE === 'simulation') {
    // Simülasyon: rastgele araç konumları üret
    return driversCache
      .filter(d => d.vehicle_plate)
      .map(d => {
        const zone = zonesCache[Math.floor(Math.random() * (zonesCache.length + 2))];
        if (zone && Math.random() > 0.3) {
          return {
            plate:    d.vehicle_plate,
            driverId: d.id,
            lat:      parseFloat(zone.latitude)  + (Math.random()-0.5) * 0.001,
            lng:      parseFloat(zone.longitude) + (Math.random()-0.5) * 0.001,
            speed:    Math.round(Math.random() * 10),
            at:       new Date().toISOString(),
          };
        }
        return {
          plate:    d.vehicle_plate,
          driverId: d.id,
          lat:      39.9 + Math.random() * 1,
          lng:      32.8 + Math.random() * 1,
          speed:    Math.round(Math.random() * 80),
          at:       new Date().toISOString(),
        };
      });
  }

  // LIVE: Arvento REST API
  const res = await fetch(`${CONFIG.ARVENTO_API_URL}/vehicles/positions`, {
    headers: { 'Authorization': 'Bearer ' + CONFIG.ARVENTO_API_KEY },
  });
  if (!res.ok) throw new Error('Arvento API hatası: ' + res.status);
  const data = await res.json();

  return (data.vehicles || data.data || []).map(v => ({
    plate:    v.plate || v.vehiclePlate || v.licensePlate,
    driverId: null,
    lat:      parseFloat(v.latitude  || v.lat),
    lng:      parseFloat(v.longitude || v.lng),
    speed:    parseFloat(v.speed || 0),
    at:       v.timestamp || new Date().toISOString(),
  }));
}

// ── Sefer oluştur ──────────────────────────────────────────
async function createTrip({ plate, driverId, originZoneId, destZoneId, startedAt, endedAt }) {
  let contractId = null;
  let routeId    = null;

  try {
    const contracts = await sb(
      `contracts?is_active=eq.true` +
      `&or=(and(origin_zone_id.eq.${originZoneId},destination_zone_id.eq.${destZoneId}),` +
      `and(origin_zone_id.eq.${destZoneId},destination_zone_id.eq.${originZoneId}))`
    );
    contractId = contracts[0]?.id || null;
  } catch(e) { /* kontrat bulunamadı */ }

  if (driverId) {
    const drv = driversCache.find(d => d.id === driverId);
    routeId = drv?.route_id || null;
  }

  const durationHr = startedAt && endedAt
    ? Math.round((new Date(endedAt) - new Date(startedAt)) / 36000) / 100
    : null;

  const trip = {
    vehicle_plate:    plate,
    driver_id:        driverId,
    route_id:         routeId,
    contract_id:      contractId,
    origin_zone_id:   originZoneId,
    dest_zone_id:     destZoneId,
    trip_date:        (startedAt || endedAt || new Date().toISOString()).split('T')[0],
    started_at:       startedAt,
    ended_at:         endedAt,
    trip_duration_hr: durationHr,
    data_source:      'arvento_api',
  };

  await sb('trips', { method: 'POST', body: JSON.stringify(trip) });

  const oz = zonesCache.find(z => z.id === originZoneId);
  const dz = zonesCache.find(z => z.id === destZoneId);
  console.log(`✅ Sefer: ${plate} | ${oz?.name} → ${dz?.name} | ${durationHr?.toFixed(1) || '?'}s | Kontrat: ${contractId ? 'var' : 'yok'}`);
}

// ── Tek araç konumunu işle ────────────────────────────────
async function processPosition({ plate, driverId, lat, lng, speed, at }) {
  const currentZone   = zonesCache.find(z => isInZone(lat, lng, z)) || null;
  const currentZoneId = currentZone?.id || null;

  const states    = await sb(`vehicle_states?vehicle_plate=eq.${encodeURIComponent(plate)}&limit=1`);
  const prev      = states[0] || null;
  const prevZoneId = prev?.current_zone_id || null;
  const zoneChanged = prevZoneId !== currentZoneId;

  if (zoneChanged) {
    if (prevZoneId) {
      const ez = zonesCache.find(z => z.id === prevZoneId);
      console.log(`🔴 ÇIKIŞ: ${plate} ← ${ez?.name}`);
      await sb('zone_events', {
        method: 'POST',
        body: JSON.stringify({
          occurred_at:   at,
          vehicle_plate: plate,
          driver_id:     driverId || prev?.driver_id || null,
          zone_id:       prevZoneId,
          event_type:    'cikis',
          latitude:      lat,
          longitude:     lng,
          speed_kmh:     speed,
        }),
      });
    }

    if (currentZoneId) {
      console.log(`🟢 GİRİŞ: ${plate} → ${currentZone?.name}`);
      await sb('zone_events', {
        method: 'POST',
        body: JSON.stringify({
          occurred_at:   at,
          vehicle_plate: plate,
          driver_id:     driverId || prev?.driver_id || null,
          zone_id:       currentZoneId,
          event_type:    'giris',
          latitude:      lat,
          longitude:     lng,
          speed_kmh:     speed,
        }),
      });

      if (prev?.active_trip_origin_zone_id && currentZoneId !== prev.active_trip_origin_zone_id) {
        await createTrip({
          plate,
          driverId:      driverId || prev.driver_id,
          originZoneId:  prev.active_trip_origin_zone_id,
          destZoneId:    currentZoneId,
          startedAt:     prev.active_trip_started_at,
          endedAt:       at,
        });
      }
    }
  }

  const newState = {
    vehicle_plate:              plate,
    driver_id:                  driverId || prev?.driver_id || null,
    last_lat:                   lat,
    last_lng:                   lng,
    last_speed_kmh:             speed,
    last_seen_at:               at,
    current_zone_id:            currentZoneId,
    zone_entered_at:            zoneChanged && currentZoneId ? at : (prev?.zone_entered_at || null),
    active_trip_origin_zone_id: !currentZoneId && prevZoneId
      ? prevZoneId
      : (currentZoneId ? null : (prev?.active_trip_origin_zone_id || null)),
    active_trip_started_at: !currentZoneId && prevZoneId
      ? at
      : (currentZoneId ? null : (prev?.active_trip_started_at || null)),
    updated_at: new Date().toISOString(),
  };

  if (prev) {
    await sb(`vehicle_states?vehicle_plate=eq.${encodeURIComponent(plate)}`, {
      method: 'PATCH',
      body:   JSON.stringify(newState),
    });
  } else {
    await sb('vehicle_states', {
      method: 'POST',
      body:   JSON.stringify(newState),
    });
  }
}

// ── Ana konum döngüsü ─────────────────────────────────────
async function pollLocations() {
  try {
    if (!cacheLoadedAt || Date.now() - cacheLoadedAt > 5 * 60 * 1000) {
      await refreshCache();
    }
    if (!zonesCache.length) {
      console.warn('[Uyarı] Zone tanımlanmamış — önce zone ekleyin');
      return;
    }

    const positions = await fetchArventoPositions();
    console.log(`[Poll] ${positions.length} araç konumu alındı`);

    for (const pos of positions) {
      try {
        await processPosition(pos);
      } catch(e) {
        console.error(`[Hata] ${pos.plate}:`, e.message);
      }
    }
  } catch(e) {
    console.error('[Poll hatası]', e.message);
  }
}

// ── Sağlık kontrolü (Railway/Render için opsiyonel HTTP endpoint) ──
// Platform healthcheck isterse diye minimal HTTP server açar.
// Port yoksa açılmaz, sorun çıkarmaz.
function startHealthServer() {
  const port = process.env.PORT;
  if (!port) return;

  const http = require('http');
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      mode: CONFIG.MODE,
      zones: zonesCache.length,
      drivers: driversCache.length,
      lastPoll: cacheLoadedAt,
    }));
  }).listen(port, () => {
    console.log(`[Health] HTTP server port ${port} üzerinde dinliyor`);
  });
}

// ── Servis başlatma ────────────────────────────────────────
async function start() {
  console.log('═══════════════════════════════════════');
  console.log(' Şoför Takip — Otomasyon Servisi v1.0');
  console.log(`  Mod: ${CONFIG.MODE.toUpperCase()}`);
  console.log(`  Supabase: ${CONFIG.SUPABASE_URL}`);
  console.log('═══════════════════════════════════════');

  await refreshCache();
  startHealthServer();

  console.log(`[Zamanlayıcı] Konum polling: her ${CONFIG.LOCATION_POLL_SECONDS}s`);
  setInterval(pollLocations, CONFIG.LOCATION_POLL_SECONDS * 1000);
  await pollLocations();

  cron.schedule('59 20 * * *', async () => {
    console.log('[Cron] Günlük snapshot alınıyor...');
    try {
      await sbRpc('take_daily_snapshot');
      console.log('[Cron] Snapshot tamamlandı');
    } catch(e) {
      console.error('[Cron] Snapshot hatası:', e.message);
    }
  });

  cron.schedule('1 21 1 * *', async () => {
    console.log('[Cron] Aylık prim skorları hesaplanıyor...');
    try {
      await sbRpc('calc_monthly_scores');
      console.log('[Cron] Aylık skorlar tamamlandı');
    } catch(e) {
      console.error('[Cron] Skor hatası:', e.message);
    }
  });

  console.log('[Cron] Günlük snapshot: 23:59 TR');
  console.log('[Cron] Aylık skor:     Her ayın 1\'i 00:01 TR');
  console.log('[Hazır] Servis çalışıyor...\n');
}

start().catch(e => {
  console.error('Servis başlatılamadı:', e);
  process.exit(1);
});
