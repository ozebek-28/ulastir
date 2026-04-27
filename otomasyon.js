// ============================================================
// Şoför Takip Sistemi — Node.js Otomasyon Servisi v2.3
// ============================================================
// v2.3 değişiklikleri:
//  - Simulation modu tamamen kaldırıldı
//  - Arvento env'leri eksikse servis açılmıyor (fail-fast)
//
// v2.0 özellikleri:
//  - Arvento SOAP Web Service entegrasyonu (GetVehicleStatus)
//  - Plaka eşleştirmesi (GetLicensePlateNodeMappings) cache'li
//  - ARVENTO_USERNAME + PIN1 + PIN2 ile auth
//
// Ortam değişkenleri (.env / Railway):
//   SUPABASE_URL          (zorunlu)
//   SUPABASE_KEY          (zorunlu)
//   ARVENTO_USERNAME      (zorunlu)
//   ARVENTO_PIN1          (zorunlu)
//   ARVENTO_PIN2          (zorunlu)
//   ARVENTO_API_URL       (opsiyonel, default: http://ws.arvento.com/v1/report.asmx)
//   LOCATION_POLL_SECONDS (opsiyonel, default: 30)
// ============================================================

require('dotenv').config();

const cron  = require('node-cron');
const fetch = require('node-fetch');

// ── Konfigürasyon ──────────────────────────────────────────
const CONFIG = {
  SUPABASE_URL:     process.env.SUPABASE_URL,
  SUPABASE_KEY:     process.env.SUPABASE_KEY,

  ARVENTO_API_URL:  process.env.ARVENTO_API_URL  || 'http://ws.arvento.com/v1/report.asmx',
  ARVENTO_USERNAME: process.env.ARVENTO_USERNAME,
  ARVENTO_PIN1:     process.env.ARVENTO_PIN1,
  ARVENTO_PIN2:     process.env.ARVENTO_PIN2,

  LOCATION_POLL_SECONDS: parseInt(process.env.LOCATION_POLL_SECONDS || '30', 10),
};

// ── Env doğrulama — fail-fast ──────────────────────────────
const requiredEnv = [
  ['SUPABASE_URL',     CONFIG.SUPABASE_URL],
  ['SUPABASE_KEY',     CONFIG.SUPABASE_KEY],
  ['ARVENTO_USERNAME', CONFIG.ARVENTO_USERNAME],
  ['ARVENTO_PIN1',     CONFIG.ARVENTO_PIN1],
  ['ARVENTO_PIN2',     CONFIG.ARVENTO_PIN2],
];
const missing = requiredEnv.filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`❌ HATA: Şu environment variable(lar) tanımlı değil: ${missing.join(', ')}`);
  console.error('   Railway → Variables sekmesinden ekleyin ve servisi yeniden başlatın.');
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

async function sbRpc(funcName) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/${funcName}`, {
    method:  'POST',
    headers: SB_HEADERS,
    body:    '{}',
  });
  if (!res.ok) throw new Error(`RPC ${funcName} hata: ${await res.text()}`);
  return res.json().catch(() => null);
}

// ── Haversine ──────────────────────────────────────────────
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
let zonesCache        = [];
let driversCache      = [];
let cacheLoadedAt     = null;
// Arvento: Device_No → { plate, group } eşleşmesi
// group ileride filtreleme için kullanılır (BİNEK ARAÇLAR, İŞ MAKİNALARI, ASSAN LİMAN gibi)
let plateByDeviceNo   = new Map();
let plateMapLoadedAt  = null;

async function refreshCache() {
  zonesCache   = await sb('zones?is_active=eq.true');
  driversCache = await sb('drivers?is_active=eq.true');
  cacheLoadedAt = new Date();
  console.log(`[Cache] ${zonesCache.length} zone, ${driversCache.length} şoför yüklendi`);
}

// ── Arvento SOAP yardımcıları ──────────────────────────────
// SOAP zarfını oluştur
function buildSoapEnvelope(method, params) {
  const inner = Object.entries(params)
    .map(([k, v]) => `<${k}>${escapeXml(v ?? '')}</${k}>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <${method} xmlns="http://www.arvento.com/">
      ${inner}
    </${method}>
  </soap:Body>
</soap:Envelope>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Çok basit XML parse — bir tag içindeki değeri yakalar (tüm occurences)
function xmlTagValues(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decodeXml(m[1]));
  return out;
}
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Arvento DataSet/DiffGram cevapları sürüme göre <Table> ya da <T diffgr:id="T1" ...> kullanır.
// Lookahead tag adının tam "Table" veya "T" olmasını garanti eder (TestData/Title vb. yakalanmaz).
function splitArventoRows(xml) {
  if (!xml) return [];
  return xml.split(/<(?:Table|T)(?=\s|>)/).slice(1);
}

// Arvento'ya SOAP request at, raw XML döner
async function arventoCall(method, extraParams = {}) {
  const params = {
    Username: CONFIG.ARVENTO_USERNAME,
    PIN1:     CONFIG.ARVENTO_PIN1,
    PIN2:     CONFIG.ARVENTO_PIN2,
    ...extraParams,
  };
  const body = buildSoapEnvelope(method, params);
  const res = await fetch(CONFIG.ARVENTO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction':   `"http://www.arvento.com/${method}"`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Arvento ${method} HTTP ${res.status}`);
  const xml = await res.text();
  // Basit hata kontrolü
  if (xml.includes('<faultstring>')) {
    const fault = xmlTagValues(xml, 'faultstring')[0] || 'unknown';
    throw new Error(`Arvento SOAP Fault: ${fault}`);
  }
  return xml;
}

// DEBUG: İlk çağrıda ham XML'i logla (format anlamak için)
let debugArventoLogged = { GetLicensePlateNodeMappings: false, GetVehicleStatus: false, GetVehicleInfo: false, GetNodes: false };
async function arventoCallDebug(method, extraParams = {}) {
  const xml = await arventoCall(method, extraParams);
  if (!debugArventoLogged[method]) {
    debugArventoLogged[method] = true;
    console.log(`\n===== ARVENTO DEBUG: ${method} =====`);
    console.log(xml.substring(0, 3000));
    console.log(`===== END ${method} =====\n`);
  }
  return xml;
}

// Device_No → Plaka eşleşmesini çek (15 dakikada bir yenilenir)
async function refreshPlateMapping() {
  // GetLicensePlateNodeMappings dene
  let xml;
  try {
    xml = await arventoCallDebug('GetLicensePlateNodeMappings', { Language: '1' });
  } catch (e) {
    console.error('[Arvento] GetLicensePlateNodeMappings hata:', e.message);
    xml = '';
  }

  // Fallback: GetVehicleInfo ve GetNodes birleştirerek eşleşme kur
  // (GetLicensePlateNodeMappings bazı hesaplarda boş dönebilir)
  const map = new Map();

  // Farklı tag isimlerini dene (Arvento versiyona göre değişir)
  const possibleDeviceTags = ['Device_x0020_No', 'Device_x0020_ID', 'Node', 'Device_No', 'DeviceNo'];
  const possiblePlateTags  = ['License_x0020_Plate', 'LicensePlate', 'License_Plate'];
  const possibleGroupTags  = ['NodeGroup', 'Node_x0020_Group', 'Group_x0020_Name', 'Group'];

  const ingestRows = (rows) => {
    for (const row of rows) {
      let dev, plate, group;
      for (const t of possibleDeviceTags) {
        const v = xmlTagValues(row, t)[0];
        if (v) { dev = v; break; }
      }
      for (const t of possiblePlateTags) {
        const v = xmlTagValues(row, t)[0];
        if (v) { plate = v; break; }
      }
      for (const t of possibleGroupTags) {
        const v = xmlTagValues(row, t)[0];
        if (v) { group = v; break; }
      }
      if (dev && plate) {
        map.set(String(dev).trim(), {
          plate: String(plate).trim(),
          group: group ? String(group).trim() : null,
        });
      }
    }
  };

  ingestRows(splitArventoRows(xml));

  // Hâlâ boşsa GetNodes ile dene
  if (map.size === 0) {
    try {
      const xml2 = await arventoCallDebug('GetNodes', { Group: '' });
      ingestRows(splitArventoRows(xml2));
    } catch (e) {
      console.error('[Arvento] GetNodes hata:', e.message);
    }
  }

  plateByDeviceNo  = map;
  plateMapLoadedAt = new Date();
  console.log(`[Arvento] Plaka eşleşmesi: ${map.size} araç`);
  if (map.size > 0) {
    // İlk 3 eşleşmeyi göster
    let i = 0;
    for (const [dev, info] of map) {
      console.log(`[Arvento]   ${dev} → ${info.plate}${info.group ? ` (${info.group})` : ''}`);
      if (++i >= 3) break;
    }
  }
}

// ── Arvento: Araç konumlarını al ───────────────────────────
async function fetchArventoPositions() {
  // Plaka eşleşmesi 15 dakikadan eskiyse yenile
  if (!plateMapLoadedAt || Date.now() - plateMapLoadedAt > 15 * 60 * 1000) {
    try {
      await refreshPlateMapping();
    } catch (e) {
      console.error('[Arvento] Plaka eşleşmesi çekilemedi:', e.message);
    }
  }

  const xml = await arventoCallDebug('GetVehicleStatus', { Language: '1' });

  // Response: her araç için bir <Table> veya <T diffgr:id="T1" ...> bloğu (Arvento sürüme göre değişir)
  const rows = splitArventoRows(xml);
  const out = [];
  let skippedNoPlate = 0;
  let skippedNoDevice = 0;

  // Arvento PDF'e göre tag isimleri farklı sürümlerde değişebiliyor
  const deviceTags = ['Device_x0020_No', 'Device_x0020_ID', 'Node', 'Device_No', 'DeviceNo'];
  const latTags    = ['Latitude', 'Lat'];
  const lngTags    = ['Longitude', 'Lng', 'Long'];
  const speedTags  = ['Speed', 'Speed_x0020_km_x002F_h'];
  const dtTags     = ['GMT_x0020_Date_x002F_Time', 'GMT_Date_Time', 'Date_x002F_Time', 'LocalDateTime'];

  const pickFirst = (row, tags) => {
    for (const t of tags) {
      const v = xmlTagValues(row, t)[0];
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };

  for (const row of rows) {
    const deviceNo = pickFirst(row, deviceTags);
    const latRaw   = pickFirst(row, latTags);
    const lngRaw   = pickFirst(row, lngTags);
    const speedRaw = pickFirst(row, speedTags);
    const dt       = pickFirst(row, dtTags);

    if (!deviceNo) { skippedNoDevice++; continue; }

    const lat   = parseFloat(latRaw);
    const lng   = parseFloat(lngRaw);
    const speed = parseFloat(speedRaw || '0');

    if (isNaN(lat) || isNaN(lng)) continue;

    const entry = plateByDeviceNo.get(String(deviceNo).trim());
    const plate = entry?.plate;
    if (!plate) {
      skippedNoPlate++;
      continue;
    }

    out.push({
      plate,
      driverId: null,
      lat,
      lng,
      speed: isNaN(speed) ? 0 : speed,
      at: dt ? new Date(dt).toISOString() : new Date().toISOString(),
    });
  }

  if (skippedNoPlate > 0 || skippedNoDevice > 0) {
    console.log(`[Arvento] Atlanan: ${skippedNoPlate} plakasız, ${skippedNoDevice} cihazsız`);
  }
  return out;
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
  } else {
    // Plakaya göre şoför bul
    const drv = driversCache.find(d => d.vehicle_plate === plate);
    if (drv) routeId = drv.route_id || null;
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

// ── Health endpoint ────────────────────────────────────────
function startHealthServer() {
  const port = process.env.PORT;
  if (!port) return;
  const http = require('http');
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      zones: zonesCache.length,
      drivers: driversCache.length,
      arventoPlateMap: plateByDeviceNo.size,
    }));
  }).listen(port, () => {
    console.log(`[Health] HTTP server port ${port} üzerinde dinliyor`);
  });
}

// ── Servis başlatma ────────────────────────────────────────
async function start() {
  console.log('═══════════════════════════════════════');
  console.log(' Şoför Takip — Otomasyon Servisi v2.3');
  console.log(`  Supabase:  ${CONFIG.SUPABASE_URL}`);
  console.log(`  Arvento:   ${CONFIG.ARVENTO_API_URL}`);
  console.log(`  Kullanıcı: ${CONFIG.ARVENTO_USERNAME}`);
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
