// Koppeling met de signageOS REST API (https://docs.signageos.io/api/).
// Gebruikt een organisatie-token (signageOS Box -> Organizations): X-Auth "tokenId:tokenSecret".
// Schermen worden aan Control gekoppeld op serienummer, niet op IP.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settings(cfg) {
  const s = cfg.signageos || {};
  return { base: (s.baseUrl || 'https://api.signageos.io').replace(/\/$/, ''), tokenId: s.tokenId || '', tokenSecret: s.tokenSecret || '' };
}

const enabled = (cfg) => { const s = settings(cfg); return !!(s.tokenId && s.tokenSecret); };

// Fout met code voor de foutcatalogus.
const sosError = (code, msg) => Object.assign(new Error(msg), { code });

async function request(cfg, method, path, body, { raw = false } = {}) {
  const s = settings(cfg);
  if (!s.tokenId || !s.tokenSecret) throw sosError('SOS_NO_TOKEN', 'Geen signageOS-token ingesteld (signageos.tokenId/tokenSecret in config.local.json)');
  const url = /^https?:/.test(path) ? path : `${s.base}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-Auth': `${s.tokenId}:${s.tokenSecret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 403) throw sosError('SOS_AUTH', `signageOS weigert het token (HTTP ${res.status})`);
  if (res.status === 402) throw sosError('SOS_NO_ENTITLEMENT', 'Deze functie zit niet in het signageOS-abonnement (HTTP 402 Payment Required)');
  if (res.status === 404) throw sosError('SOS_NOT_FOUND', `signageOS: niet gevonden (${path})`);
  if (res.status === 429) throw sosError('SOS_RATE', 'signageOS: te veel verzoeken (HTTP 429); probeer het zo opnieuw');
  if (!res.ok) throw sosError('SOS_ERROR', `signageOS gaf HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (raw) return res;
  const text = await res.text();
  return { data: text ? JSON.parse(text) : null, headers: res.headers };
}

// Alle pagina's ophalen via de Link-header (rel="next").
async function getAll(cfg, path) {
  const out = [];
  let next = path;
  for (let i = 0; next && i < 50; i++) {
    const { data, headers } = await request(cfg, 'GET', next);
    if (Array.isArray(data)) out.push(...data);
    const link = headers.get('link') || '';
    const m = link.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    next = m ? m[1] : null;
  }
  return out;
}

const norm = (v) => String(v || '').trim().toUpperCase();

// Apparaten in de organisatie, geïndexeerd op serienummer.
async function devicesBySerial(cfg) {
  const list = await getAll(cfg, '/v1/device?limit=1000');
  const map = new Map();
  for (const d of list) if (d.serialNumber) map.set(norm(d.serialNumber), d);
  return map;
}

// Firmwaretype zonder schermmaat: catalogus "philips_55bdl4550d" en apparaat "philips_bdl4550d" zijn dezelfde familie.
const typeFamily = (t) => String(t || '').toLowerCase().replace(/^philips_[0-9]+/, 'philips_');

// Firmwarecatalogus van signageOS (eens per 10 minuten opgehaald; zoeken op type werkt niet in de API).
let catalogCache = { at: 0, list: null };
async function catalog(cfg) {
  if (!catalogCache.list || Date.now() - catalogCache.at > 10 * 60000) catalogCache = { at: Date.now(), list: await getAll(cfg, '/v2/firmware?limit=100') };
  return catalogCache.list;
}

// Firmware voor de firmwaretypes van de gekoppelde schermen. Exact de PPDS-versie (bv. FB01.20) komt bovenaan.
async function findFirmware(cfg, { version, firmwareTypes = [] }) {
  const fams = new Set(firmwareTypes.map(typeFamily));
  const v = norm(version);
  return (await catalog(cfg))
    .filter((f) => f.published !== false && fams.has(typeFamily(f.firmwareType)))
    .map((f) => ({ ...f, exact: !!v && norm(f.manufacturerVersion) === v }))
    .sort((x, y) => Number(y.exact) - Number(x.exact) || String(y.manufacturerVersion).localeCompare(String(x.manufacturerVersion)));
}

// Firmware-upgrade via signageOS: opdracht geven en wachten tot het apparaat de nieuwe versie meldt.
async function upgradeFirmware(cfg, uid, firmwareVersionUid, { expectVersion, waitMinutes = 40, onStep } = {}) {
  await request(cfg, 'PUT', `/v2/device/${encodeURIComponent(uid)}/firmware`, { firmwareVersionUid });
  if (onStep) onStep('opdracht naar signageOS verstuurd; scherm downloadt en installeert zelf', 'starten');
  const deadline = Date.now() + waitMinutes * 60000;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(30000);
    try {
      const { data } = await request(cfg, 'GET', `/v1/device/${encodeURIComponent(uid)}`);
      last = data && data.firmwareVersion;
      if (onStep) onStep(last ? `bezig, signageOS meldt firmware ${last}` : 'bezig, scherm herstart', 'herstart');
      if (expectVersion && last && norm(last).includes(norm(expectVersion))) return { ok: true, version: last };
    } catch { /* tijdelijk niet bereikbaar tijdens de herstart */ }
  }
  return { ok: false, version: last };
}

// Screenshot via signageOS: maken en wachten tot hij in de lijst staat; geeft de afbeelding terug.
async function screenshot(cfg, uid, { waitSeconds = 60 } = {}) {
  const since = new Date(Date.now() - 5000).toISOString();
  await request(cfg, 'POST', `/v1/device/${encodeURIComponent(uid)}/screenshot`);
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const { data } = await request(cfg, 'GET', `/v1/device/${encodeURIComponent(uid)}/screenshot?takenSince=${encodeURIComponent(since)}&limit=1`);
    const shot = Array.isArray(data) && data[0];
    if (shot && shot.uri) {
      const img = await fetch(shot.uri);
      if (!img.ok) throw sosError('SOS_ERROR', `Screenshot niet op te halen (HTTP ${img.status})`);
      const body = Buffer.from(await img.arrayBuffer());
      // signageOS levert het bestand als application/octet-stream; type afleiden uit de eerste bytes.
      const contentType = body[0] === 0x89 && body[1] === 0x50 ? 'image/png' : body[0] === 0xff && body[1] === 0xd8 ? 'image/jpeg' : img.headers.get('content-type') || 'image/png';
      return { contentType, body, takenAt: shot.takenAt };
    }
  }
  throw sosError('SOS_TIMEOUT', 'signageOS heeft binnen een minuut geen screenshot aangeleverd (staat het scherm online?)');
}

// Power-acties: SYSTEM_REBOOT, DISPLAY_POWER_ON, DISPLAY_POWER_OFF, APP_RESTART, ...
async function powerAction(cfg, uid, action) {
  await request(cfg, 'POST', `/v1/device/${encodeURIComponent(uid)}/power-action`, { devicePowerAction: action });
}

// Verbindingstest: token geldig en hoeveel apparaten zichtbaar.
async function check(cfg) {
  const devs = await getAll(cfg, '/v1/device?limit=1000');
  return { devices: devs.length };
}

module.exports = { enabled, devicesBySerial, findFirmware, upgradeFirmware, screenshot, powerAction, check };
