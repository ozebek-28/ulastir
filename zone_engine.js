// ============================================================
// Zone Giriş / Çıkış Motoru — v1.0
// ============================================================
// Bu dosya iki modda çalışır:
//   SIMULATION: Arvento olmadan test etmek için
//   LIVE:       Arvento API key gelince aktif olur
//
// Çalıştırma seçenekleri:
//   1. Tarayıcıda (dashboard widget içinde)
//   2. Node.js: node zone_engine.js
//   3. Supabase Edge Function (cron job)
// ============================================================

const CONFIG = {
  SUPABASE_URL: (typeof process !== 'undefined' && process.env && process.env.SUPABASE_URL) || '',
  SUPABASE_KEY: (typeof process !== 'undefined' && process.env && process.env.SUPABASE_KEY) || '',

  // Arvento API — key environment variable olarak verilmeli
  ARVENTO_API_URL: (typeof process !== 'undefined' && process.env && process.env.ARVENTO_API_URL) || 'https://web.arvento.com/rest',
  ARVENTO_API_KEY: (typeof process !== 'undefined' && process.env && process.env.ARVENTO_API_KEY) || null,

  // Motor ayarları
  POLL_INTERVAL_MS: 30000,   // 30 saniyede bir konum sorgula
  MODE: 'simulation',         // 'simulation' | 'live'
};

// ============================================================
// YARDIMCI: Haversine mesafe hesabı (metre)
// İki GPS koordinatı arasındaki gerçek mesafeyi verir
// ============================================================
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Dünya yarıçapı metre
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ============================================================
// YARDIMCI: Araç bir zone içinde mi?
// ============================================================
function isInZone(vehicleLat, vehicleLng, zone) {
  const dist = haversineMeters(vehicleLat, vehicleLng, zone.latitude, zone.longitude);
  return dist <= zone.radius_meters;
}

// ============================================================
// SUPABASE: Temel API çağrısı
// ============================================================
async function sbFetch(path, opts = {}) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/' + path;
  const headers = {
    'apikey': CONFIG.SUPABASE_KEY,
    'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    ...opts.headers,
  };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) throw new Error(`Supabase hata [${res.status}]: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// ============================================================
// ARVENTO: Araç konumlarını çek
// API key gelince MODE='live' yapın
// ============================================================
async function fetchVehiclePositions() {
  if (CONFIG.MODE === 'simulation') {
    // Simülasyon modu — gerçek araçlar ve zone'lar kullanılır
    // Test için araçları zone'lar arasında hareket ettiririz
    return null; // Simülatör kendi konumlarını üretir
  }

  // LIVE mod — Arvento REST API
  const res = await fetch(`${CONFIG.ARVENTO_API_URL}/vehicles/positions`, {
    headers: {
      'Authorization': 'Bearer ' + CONFIG.ARVENTO_API_KEY,
      'Content-Type': 'application/json',
    }
  });
  if (!res.ok) throw new Error('Arvento API hatası: ' + res.status);
  const data = await res.json();

  // Arvento yanıtını standart formata çevir
  return data.vehicles?.map(v => ({
    plate:    v.plate || v.vehiclePlate || v.licensePlate,
    lat:      parseFloat(v.latitude || v.lat),
    lng:      parseFloat(v.longitude || v.lng),
    speed:    parseFloat(v.speed || 0),
    driverId: v.driverId || null,
    at:       v.timestamp || new Date().toISOString(),
  })) || [];
}

// ============================================================
// MOTOR: Tek araç için konum işle
// ============================================================
async function processVehiclePosition(vehicle, zones, drivers) {
  const { plate, lat, lng, speed, at } = vehicle;
  const log = [];

  // 1. Araç hangi zone içinde?
  const currentZone = zones.find(z => isInZone(lat, lng, z)) || null;

  // 2. Aracın önceki durumunu al
  const states = await sbFetch(`vehicle_states?vehicle_plate=eq.${encodeURIComponent(plate)}&limit=1`);
  const prevState = states[0] || null;
  const prevZoneId = prevState?.current_zone_id || null;
  const currentZoneId = currentZone?.id || null;

  // 3. Zone değişti mi?
  const zoneChanged = prevZoneId !== currentZoneId;

  if (zoneChanged) {
    // ÇIKIŞ olayı
    if (prevZoneId) {
      const exitZone = zones.find(z => z.id === prevZoneId);
      log.push(`🔴 ÇIKIŞ: ${plate} → ${exitZone?.name}`);

      await sbFetch('zone_events', {
        method: 'POST',
        body: JSON.stringify({
          occurred_at:   at,
          vehicle_plate: plate,
          driver_id:     prevState?.driver_id || null,
          zone_id:       prevZoneId,
          event_type:    'cikis',
          latitude:      lat,
          longitude:     lng,
          speed_kmh:     speed,
        })
      });
    }

    // GİRİŞ olayı
    if (currentZoneId) {
      log.push(`🟢 GİRİŞ: ${plate} → ${currentZone?.name}`);

      await sbFetch('zone_events', {
        method: 'POST',
        body: JSON.stringify({
          occurred_at:   at,
          vehicle_plate: plate,
          driver_id:     prevState?.driver_id || null,
          zone_id:       currentZoneId,
          event_type:    'giris',
          latitude:      lat,
          longitude:     lng,
          speed_kmh:     speed,
        })
      });

      // SEFERİ TESPİT ET
      // Araç daha önce bir zone'dan çıktı ve şimdi başka bir zone'a girdi
      if (prevState?.active_trip_origin_zone_id && currentZoneId !== prevState.active_trip_origin_zone_id) {
        await createTrip({
          plate,
          driverId:    prevState.driver_id,
          originZoneId: prevState.active_trip_origin_zone_id,
          destZoneId:   currentZoneId,
          startedAt:    prevState.active_trip_started_at,
          endedAt:      at,
          zones,
        });
        log.push(`✅ SEFERTESPİT: ${plate} → sefer oluşturuldu`);
      }
    }
  }

  // 4. Araç durumunu güncelle
  const newState = {
    vehicle_plate:              plate,
    last_lat:                   lat,
    last_lng:                   lng,
    last_speed_kmh:             speed,
    last_seen_at:               at,
    current_zone_id:            currentZoneId,
    zone_entered_at:            zoneChanged && currentZoneId ? at : prevState?.zone_entered_at,
    // Sefer başlangıcı: zone'dan çıkınca kaydedilir
    active_trip_origin_zone_id: !currentZoneId && prevZoneId ? prevZoneId : (currentZoneId ? null : prevState?.active_trip_origin_zone_id),
    active_trip_started_at:     !currentZoneId && prevZoneId ? at : (currentZoneId ? null : prevState?.active_trip_started_at),
    updated_at:                 new Date().toISOString(),
  };

  if (prevState) {
    await sbFetch(`vehicle_states?vehicle_plate=eq.${encodeURIComponent(plate)}`, {
      method: 'PATCH',
      body: JSON.stringify(newState),
    });
  } else {
    await sbFetch('vehicle_states', {
      method: 'POST',
      body: JSON.stringify(newState),
    });
  }

  return log;
}

// ============================================================
// MOTOR: Sefer oluştur
// Zone A çıkış + Zone B giriş tespit edilince çağrılır
// ============================================================
async function createTrip({ plate, driverId, originZoneId, destZoneId, startedAt, endedAt, zones }) {
  // İlgili kontratı bul (A→B veya B→A)
  const contracts = await sbFetch(
    `contracts?is_active=eq.true&or=(and(origin_zone_id.eq.${originZoneId},destination_zone_id.eq.${destZoneId}),and(origin_zone_id.eq.${destZoneId},destination_zone_id.eq.${originZoneId}))`
  );
  const contract = contracts[0] || null;

  // Süreyi hesapla
  const durationHr = startedAt && endedAt
    ? (new Date(endedAt) - new Date(startedAt)) / 3600000
    : null;

  // Şoförün hattını bul
  let routeId = null;
  if (driverId) {
    const drivers = await sbFetch(`drivers?id=eq.${driverId}&select=route_id`);
    routeId = drivers[0]?.route_id || null;
  }

  const trip = {
    vehicle_plate:    plate,
    driver_id:        driverId || null,
    route_id:         routeId,
    contract_id:      contract?.id || null,
    origin_zone_id:   originZoneId,
    dest_zone_id:     destZoneId,
    trip_date:        (startedAt || endedAt || new Date().toISOString()).split('T')[0],
    started_at:       startedAt,
    ended_at:         endedAt,
    trip_duration_hr: durationHr ? Math.round(durationHr * 100) / 100 : null,
    data_source:      'arvento_api',
  };

  await sbFetch('trips', {
    method: 'POST',
    body: JSON.stringify(trip),
  });

  console.log(`✅ Sefer oluşturuldu: ${plate} | ${originZoneId} → ${destZoneId} | Kontrat: ${contract?.name || 'yok'}`);
}

// ============================================================
// MOTOR: Ana döngü
// ============================================================
async function runEngine(onLog) {
  console.log('🚀 Zone motoru başlatıldı — mod:', CONFIG.MODE);

  // Zone'ları ve şoförleri yükle
  const zones   = await sbFetch('zones?is_active=eq.true');
  const drivers = await sbFetch('drivers?is_active=eq.true');

  if (!zones.length) {
    console.warn('⚠️ Hiç zone tanımlanmamış — önce zone ekleyin');
    return;
  }

  console.log(`📍 ${zones.length} zone yüklendi:`, zones.map(z => z.name).join(', '));

  if (CONFIG.MODE === 'live') {
    // Gerçek Arvento verisi
    const positions = await fetchVehiclePositions();
    for (const vehicle of positions) {
      const logs = await processVehiclePosition(vehicle, zones, drivers);
      logs.forEach(l => { console.log(l); onLog && onLog(l); });
    }
  }

  // Simülasyon modunda dış simülatör çağırır processVehiclePosition'ı
  return { zones, drivers };
}

// ============================================================
// EXPORT (Node.js veya Supabase Edge Function için)
// ============================================================
if (typeof module !== 'undefined') {
  module.exports = { runEngine, processVehiclePosition, haversineMeters, isInZone, CONFIG };
}
