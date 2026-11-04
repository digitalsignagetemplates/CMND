// D-Line beheer: lokale aanvulling op CMND & Control.
// Start: node server.js  (geen npm-packages nodig)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const demo = require('./drivers/demo');
const sicp = require('./drivers/sicp');
const control = require('./drivers/control');
const onelink = require('./drivers/onelink'); // alleen nog voor het lezen van OTA-metadata uit update.zip
const ppdskb = require('./drivers/ppdskb');
const errors = require('./drivers/errors');
const https = require('https');
const os = require('os');

const ROOT = __dirname;
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
// config.local.json (niet in git) overschrijft config.json, bv. voor wachtwoorden.
const cfg = require('./drivers/config').loadConfig(ROOT);
const profiles = readJson('profiles.json');
const profile = profiles.dline;
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const AUDIT = path.join(DATA_DIR, 'acties.jsonl');

// ---------- schermen ----------

function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function supportInfo(dev) {
  if (dev.identityMismatch) {
    return { supported: false, reason: `Op ${dev.ip} antwoordt een ander apparaat (${dev.identityMismatch.model || '?'}, serienr ${dev.identityMismatch.serial || '?'}). Werk het IP-adres bij in Control.` };
  }
  if (!new RegExp(cfg.modelPattern, 'i').test(dev.model || '')) return { supported: false, reason: 'Geen Philips-signagemodel (xxBDLnnnnX)' };
  // Control slaat de Android-versie niet op; onbekend telt als toegestaan (alle D-Line vanaf 4550D draaien Android 8+).
  if (!dev.android) return { supported: true, reason: 'Android-versie niet bekend in Control' };
  if (compareVersion(dev.android, cfg.minAndroid) < 0) {
    return { supported: false, reason: `Android ${dev.android || '?'} is lager dan minimum ${cfg.minAndroid}` };
  }
  return { supported: true, reason: '' };
}

let devices = [];
let byId = new Map();
let controlError = null;
let controlSettings = {};

// Verwerkt items met maximaal n tegelijk.
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// Velden die uit Control komen; de rest (live SICP-waarden) blijft van het bestaande object.
const CONTROL_FIELDS = ['controlId', 'name', 'ip', 'sicpPort', 'group', 'model', 'android', 'firmware', 'serial', 'sicpVersion', 'powerRaw', 'controlSource', 'raw', 'ftp'];

// Control-modus: schermlijst komt uit smartcontroldb. Bestaande scherm-objecten
// worden ter plekke bijgewerkt, zodat lopende acties op hetzelfde object blijven werken.
let syncing = false;
async function syncControl() {
  if (syncing) return;
  syncing = true;
  try {
    const fresh = await control.loadDevices(cfg.db);
    devices = fresh.map((d) => {
      const prev = byId.get(d.id);
      if (!prev) return d;
      if (prev.ip !== d.ip) { prev.identityMismatch = null; prev.slowReadAt = 0; } // nieuw IP in Control: meteen opnieuw controleren
      for (const k of CONTROL_FIELDS) prev[k] = d[k];
      return prev;
    });
    byId = new Map(devices.map((d) => [d.id, d]));
    controlSettings = await control.loadSettings(cfg.db).catch(() => ({}));
    controlError = null;
    // Status live uitlezen (alleen-lezen SICP-queries) bij ondersteunde schermen.
    // Ook schermen met een identiteitsprobleem blijven we (alleen-lezend) controleren.
    await pool(devices.filter((d) => supportInfo(d).supported || d.identityMismatch), cfg.batchSize, (d) =>
      withTimeout(sicp.execute(d, 'refresh', { quick: true }, profile, cfg), cfg.timeoutMs * 3)
        .catch(() => { d.power = 'onbekend'; }));
  } catch (e) {
    controlError = e.message;
    console.error('Control-database niet leesbaar:', e.message);
  } finally {
    syncing = false;
  }
}

if (cfg.mode === 'demo') {
  devices = demo.createDemoDevices();
} else if (cfg.mode === 'control') {
  // wordt bij het starten en daarna periodiek geladen
} else {
  const file = path.join(ROOT, cfg.devicesFile);
  if (!fs.existsSync(file)) {
    console.error(`Bestand ${cfg.devicesFile} ontbreekt. Kopieer devices.example.json en vul de schermen in.`);
    process.exit(1);
  }
  devices = readJson(cfg.devicesFile).map((d) => ({
    power: 'onbekend', powerSaveMode: null, smartPower: null, bootSource: null, schedule: [], lastSeen: null, ...d,
  }));
}
if (cfg.mode !== 'control') byId = new Map(devices.map((d) => [d.id, d]));

const driver = {
  execute: (dev, type, params) => (cfg.mode === 'demo'
    ? demo.execute(dev, type, params)
    : sicp.execute(dev, type, params, profile, cfg)),
  screenshot: (dev) => (cfg.mode === 'demo' ? demo.screenshot(dev) : sicp.screenshot(dev, cfg)),
};

// ---------- firmware ----------
// Map: firmware/<serie>/update.zip + version.txt, bv. firmware/4650D/ met "1.028".

const FW_DIR = path.resolve(ROOT, cfg.firmwareDir || 'firmware');
const seriesOf = (model) => (String(model || '').match(/BDL(\d{4}[A-Z])/i) || [])[1]?.toUpperCase() || null;

// Klaargezette firmware (gedownload of handmatig neergezet).
function firmwareCatalog() {
  if (!fs.existsSync(FW_DIR)) return {};
  const out = {};
  for (const series of fs.readdirSync(FW_DIR)) {
    const file = path.join(FW_DIR, series, 'update.zip');
    const vfile = path.join(FW_DIR, series, 'version.txt');
    if (!fs.existsSync(file) || !fs.existsSync(vfile)) continue;
    let source = {};
    try { source = JSON.parse(fs.readFileSync(path.join(FW_DIR, series, 'source.json'), 'utf8')); } catch { /* handmatig neergezet */ }
    out[series.toUpperCase()] = { file, version: fs.readFileSync(vfile, 'utf8').trim(), size: fs.statSync(file).size, ...source };
  }
  return out;
}

// Nieuwste firmware per serie volgens de PPDS-kennisbank (kb-catalog.json -> pagina per serie).
const KB_CATALOG = path.join(ROOT, 'kb-catalog.json');
let latest = { series: {}, error: null, loadedAt: null, errors: {} };
async function loadLatest() {
  let catalog = {};
  try { catalog = JSON.parse(fs.readFileSync(KB_CATALOG, 'utf8')).series || {}; } catch (e) {
    latest = { series: {}, error: `kb-catalog.json niet leesbaar: ${e.message}`, loadedAt: null, errors: {} };
    return;
  }
  const series = {};
  const errors = {};
  await Promise.all(Object.entries(catalog).map(async ([s, page]) => {
    try {
      const kb = await ppdskb.fetchSeries(page.contentId, page.page, cfg);
      const a = kb.android;
      series[s.toUpperCase()] = {
        version: a ? a.version : null, // Android-firmware, bv. FB01.20 (zoals SICP 0xA1 0x03 hem meldt)
        label: a ? a.label : null,
        file: a ? a.file : null,
        url: a && a.installable ? a.url : null,
        manual: a && !a.installable ? a.href : null,
        scaler: kb.scaler ? kb.scaler.version : null,
        platform: kb.platform,
        page: page.page,
        releaseNotes: kb.releaseNotes,
        instructions: kb.instructions,
      };
    } catch (e) { errors[s.toUpperCase()] = e.message; }
  }));
  const failed = Object.keys(errors);
  latest = {
    series, errors, loadedAt: new Date().toISOString(),
    error: failed.length && !Object.keys(series).length ? `PPDS-kennisbank niet bereikbaar: ${errors[failed[0]]}` : null,
  };
}
const latestReady = loadLatest();

const downloads = {}; // serie -> { state, received, total, error }

function httpDownload(url, dest, onProgress, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 8) return reject(new Error('Te veel doorverwijzingen'));
    const req = https.get(url, { headers: { 'User-Agent': 'dline-beheer' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(httpDownload(new URL(res.headers.location, url).href, dest, onProgress, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download gaf HTTP ${res.statusCode}`)); }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => { received += c.length; onProgress(received, total); });
      res.pipe(out);
      out.on('finish', () => resolve({ received, total }));
      out.on('error', reject);
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Download afgebroken door de server')));
    });
    // Valt de verbinding 60 s stil, dan afbreken in plaats van eindeloos "bezig".
    req.setTimeout(60000, () => req.destroy(new Error('Download staat 60 seconden stil; verbinding verbroken')));
    req.on('error', reject);
  });
}

// Loopt er een firmware-upgrade voor schermen van deze serie? Dan het bestand niet vervangen.
function upgradeRunning(series) {
  return actions.some((a) => a.type === 'firmware' && !a.finishedAt
    && a.targets.some((t) => !t.doneAt && seriesOf((byId.get(t.deviceId) || {}).model) === series));
}

async function downloadFirmware(series) {
  const info = latest.series[series];
  if (!info) throw new Error('Serie niet gevonden in de PPDS-kennisbank');
  if (!info.url) throw new Error('Voor deze serie is geen los update.zip beschikbaar; volg de instructies van PPDS');
  if (downloads[series] && downloads[series].state === 'bezig') throw new Error('Download loopt al');
  const dir = path.join(FW_DIR, series);
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, 'update.zip.part');
  const st = downloads[series] = { state: 'bezig', received: 0, total: 0, error: null };
  try {
    await httpDownload(info.url, part, (r, t) => { st.received = r; st.total = t; });
    const head = Buffer.alloc(2);
    const fd = fs.openSync(part, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    if (head.toString() !== 'PK') throw new Error('Gedownload bestand is geen zip (link verlopen of inlog vereist?)');
    if (st.total && st.received !== st.total) throw new Error('Download onvolledig');
    const ota = (() => { try { return onelink.otaInfo(part); } catch { return null; } })();
    // Is er intussen een upgrade gestart, dan het bestand dat wordt geüpload niet vervangen.
    if (upgradeRunning(series)) throw new Error('Er is intussen een firmware-upgrade voor deze serie gestart; download niet geplaatst. Probeer het na afloop opnieuw');
    fs.renameSync(part, path.join(dir, 'update.zip'));
    fs.writeFileSync(path.join(dir, 'version.txt'), info.version);
    fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ source: 'PPDS-kennisbank', page: info.page, platform: info.platform, url: info.url, downloadedAt: new Date().toISOString(), ota }, null, 2));
    st.state = 'klaar';
  } catch (e) {
    try { fs.unlinkSync(part); } catch { /* al weg */ }
    st.state = 'mislukt';
    st.error = e.message;
  }
}

// Controle: het apparaat in de OTA-metadata (bv. "BDL3650Q") moet bij de serie passen.
// Zonder metadata kan het niet automatisch; dan geldt de handmatige bevestiging.
// Sommige firmware noemt een interne codenaam (bv. "sugarcane"); die kan per serie worden
// toegestaan in config (otaAliases), maar alleen nadat PPDS heeft bevestigd dat ze bij elkaar horen.
function otaMismatch(series, ready) {
  const dev = ready && ready.ota && ready.ota.device;
  if (!dev) return null;
  if (dev.toUpperCase().includes(series.toUpperCase())) return null;
  const aliases = ((cfg.otaAliases || {})[series.toUpperCase()] || []).map((a) => String(a).toUpperCase());
  return aliases.includes(dev.toUpperCase()) ? null : dev;
}

function firmwareOverview() {
  const ready = firmwareCatalog();
  const used = new Set(devices.map((d) => seriesOf(d.model)).filter(Boolean));
  const all = new Set([...used, ...Object.keys(ready)]);
  const out = {};
  for (const s of all) {
    const l = latest.series[s] || null;
    out[s] = {
      inUse: devices.filter((d) => seriesOf(d.model) === s).length,
      latest: l && { version: l.version, label: l.label, file: l.file, scaler: l.scaler, platform: l.platform, page: l.page, manual: l.manual, releaseNotes: l.releaseNotes, instructions: l.instructions },
      kbError: latest.errors[s] || (latest.loadedAt && !l && s ? 'Serie staat niet in kb-catalog.json' : null),
      ready: ready[s] ? { version: ready[s].version, size: ready[s].size, ota: ready[s].ota || null, downloadedAt: ready[s].downloadedAt || null, mismatch: otaMismatch(s, ready[s]) } : null,
      download: downloads[s] || null,
      // Via de tool alleen met een los update.zip (Android-firmware, SICP 0x20).
      upgradable: !!(l && l.url),
    };
  }
  return out;
}

// `cat` = firmwareCatalog(), één keer per verzoek gelezen en voor alle schermen gebruikt.
function publicDevice(d, cat) {
  const { ftp, ...rest } = d; // FTP-wachtwoord nooit naar de browser
  const s = seriesOf(d.model);
  const l = latest.series[s];
  const ready = cat[s];
  return {
    ...rest, ...supportInfo(d), hasFtp: !!(ftp && ftp.user),
    fwAvailable: ready ? ready.version : null,
    fwLatest: l ? l.version : null,
    fwLatestScaler: l ? l.scaler : null,
  };
}

// ---------- acties ----------

const actions = [];
try {
  const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean);
  for (const l of lines.slice(-200)) actions.push(JSON.parse(l));
  // Oudere acties hebben nog geen foutcode: alsnog afleiden uit de melding.
  for (const a of actions) {
    for (const t of a.targets) if (!t.code && ['mislukt', 'geen_reactie'].includes(t.status)) t.code = errors.classify(t.detail);
  }
} catch { /* nog geen historie */ }

const ACTION_TYPES = ['power', 'powerSave', 'source', 'bootSource', 'schedule', 'refresh', 'screenshot', 'firmware', 'restart'];

function validate(type, params) {
  if (!ACTION_TYPES.includes(type)) return `Onbekende actie: ${type}`;
  if (type === 'power' && !['on', 'off'].includes(params.state)) return 'Kies aan of uit';
  if (type === 'powerSave' && !profile.powerSaveModes[params.mode]) return 'Ongeldige power-save-modus';
  if (type === 'powerSave' && params.smartPower && !profile.smartPower[params.smartPower]) return 'Ongeldige SmartPower-stand';
  if ((type === 'bootSource' || type === 'source') && !profile.sources.some((s) => s.id === params.source)) return 'Ongeldige bron';
  if (type === 'source' && params.source === 'last') return '"Laatste bron" kan alleen als opstartbron';
  if (type === 'schedule') {
    if (!Array.isArray(params.entries) || !params.entries.length) return 'Geen schemaregels';
    if (params.entries.length > 7) return 'Maximaal 7 schemaregels (zoveel pagina\'s heeft het scherm)';
    for (const e of params.entries) {
      if (!Array.isArray(e.days) || !e.days.length) return 'Elke schemaregel heeft minstens één dag nodig';
      if (!/^\d{2}:\d{2}$/.test(e.on) || !/^\d{2}:\d{2}$/.test(e.off)) return 'Tijden als UU:MM';
      if (e.source && !profile.sources.some((s) => s.id === e.source)) return 'Ongeldige bron in schema';
    }
  }
  return null;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('geen antwoord binnen time-out'), { timeout: true })), ms)),
  ]);
}

function persist(action) {
  fs.appendFileSync(AUDIT, JSON.stringify(action) + '\n');
}

async function runTarget(action, t) {
  const dev = byId.get(t.deviceId);
  t.status = 'verstuurd';
  t.sentAt = new Date().toISOString();
  t.phase = action.type === 'firmware' ? 'voorcontrole' : null;
  if (!dev) {
    t.status = 'mislukt';
    t.code = 'NOT_IN_CONTROL';
    t.detail = 'Scherm staat niet meer in Control';
    t.doneAt = new Date().toISOString();
    return;
  }
  let done = false; // na afloop geen late voortgangsmeldingen meer overnemen
  try {
    // Aan/uit wacht op het opstarten; schema en uitlezen doen meerdere commando's. Daarom ruimere time-out.
    // Firmware: upload + herstart + teruglezen, dat duurt al gauw een half uur.
    let ms = ['power', 'schedule', 'refresh', 'source'].includes(action.type) ? cfg.timeoutMs + 40000 : cfg.timeoutMs * 2;
    if (action.type === 'restart') ms = 240000; // herstart + wachten tot het scherm terug is
    let params = action.params;
    if (action.type === 'firmware') {
      ms = ((cfg.firmwareWaitMinutes || 25) + 30) * 60000;
      const s = seriesOf(dev.model);
      const fw = firmwareCatalog()[s];
      // Platform uit source.json, anders van de PPDS-pagina (bv. bij handmatig neergezette firmware).
      if (fw && !fw.platform && latest.series[s]) fw.platform = latest.series[s].platform;
      params = {
        ...action.params,
        resolved: fw ? { [dev.id]: fw } : {},
        onStep: (d, msg, phase) => { if (!done) { t.detail = msg; if (phase) t.phase = phase; } },
      };
    }
    const res = await withTimeout(driver.execute(dev, action.type, params), ms);
    done = true;
    t.status = res.ok ? 'bevestigd' : res.noReply ? 'geen_reactie' : 'mislukt';
    t.detail = res.ok ? res.detail || '' : res.error;
    t.code = res.code || (res.ok ? null : errors.classify(res.error));
  } catch (e) {
    done = true;
    t.status = e.blocked ? 'niet_getest' : e.timeout ? 'geen_reactie' : 'mislukt';
    t.detail = e.message;
    t.code = e.blocked ? 'NOT_TESTED' : e.timeout ? (action.type === 'firmware' ? 'FW_TIMEOUT' : 'NO_REPLY') : errors.classify(e.message);
  }
  if (t.status === 'bevestigd' && action.type === 'firmware' && t.code !== 'FW_ALREADY_CURRENT') t.phase = 'klaar';
  t.doneAt = new Date().toISOString();
}

// CSV per actie (puntkomma, met BOM zodat Excel de tekens goed toont).
function actionCsv(a) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Scherm', 'IP', 'Model', 'Status', 'Fase', 'Foutcode', 'Probleem', 'Wat te doen', 'Technische melding', 'Verstuurd', 'Klaar'];
  const rows = a.targets.map((t) => {
    const dev = byId.get(t.deviceId) || {};
    const e = t.code ? errors.CATALOG[t.code] || {} : {};
    return [t.name, dev.ip, dev.model, t.status, t.phase || '', t.code || '', e.title || '', e.fix || '', t.detail || '', t.sentAt || '', t.doneAt || ''];
  });
  for (const s of a.skipped || []) {
    const dev = byId.get(s.deviceId) || {};
    rows.push([dev.name || s.deviceId, dev.ip, dev.model, 'overgeslagen', '', s.code || '', '', '', s.reason, '', '']);
  }
  return `﻿${[head, ...rows].map((r) => r.map(q).join(';')).join('\r\n')}`;
}

async function runAction(action) {
  // Firmware standaard één scherm tegelijk.
  // Firmware: standaard één scherm tegelijk; de gebruiker kan tot firmwareMaxConcurrency kiezen.
  const n = action.type === 'firmware'
    ? Math.max(1, Math.min(Number(action.params.concurrency) || cfg.firmwareConcurrency || 1, cfg.firmwareMaxConcurrency || 3))
    : cfg.batchSize;
  await pool(action.targets, n, (t) => runTarget(action, t));
  action.finishedAt = new Date().toISOString();
  persist(action);
}

function createAction(body, user) {
  const { type, params = {}, deviceIds = [] } = body;
  const err = validate(type, params);
  if (err) return { error: err };
  const targets = [];
  const skipped = [];
  const fwCat = type === 'firmware' ? firmwareCatalog() : {}; // één keer van schijf lezen
  for (const id of deviceIds) {
    const dev = byId.get(id);
    if (!dev) continue;
    const s = supportInfo(dev);
    if (!s.supported) skipped.push({ deviceId: id, name: dev.name, code: dev.identityMismatch ? 'IDENTITY_MISMATCH' : 'NAV', reason: s.reason });
    else if (type === 'firmware' && !fwCat[seriesOf(dev.model)]) skipped.push({ deviceId: id, name: dev.name, code: 'FW_NO_FILE', reason: `Geen firmware in map voor serie ${seriesOf(dev.model)}` });
    else if (type === 'firmware' && otaMismatch(seriesOf(dev.model), fwCat[seriesOf(dev.model)])) {
      skipped.push({ deviceId: id, name: dev.name, code: 'FW_OTA_MISMATCH', reason: `Klaargezette firmware is volgens het bestand voor ${otaMismatch(seriesOf(dev.model), fwCat[seriesOf(dev.model)])}, niet voor ${seriesOf(dev.model)}` });
    }
    else if (type === 'firmware' && actions.some((a) => a.type === 'firmware' && !a.finishedAt && a.targets.some((x) => x.deviceId === id))) {
      skipped.push({ deviceId: id, name: dev.name, code: 'FW_BUSY', reason: 'Er loopt al een firmware-upgrade op dit scherm' });
    }
    else targets.push({ deviceId: id, name: dev.name, status: 'wachtrij', detail: '' });
  }
  if (!targets.length) return { error: type === 'firmware' ? 'Geen geselecteerd scherm heeft firmware klaarstaan in de map' : 'Geen ondersteunde schermen geselecteerd', skipped };
  if (type === 'firmware' && params.confirm !== 'UPGRADE') return { error: 'Bevestig de firmware-upgrade door UPGRADE te typen' };
  const action = {
    id: crypto.randomUUID(), type, params, user, createdAt: new Date().toISOString(),
    finishedAt: null, targets, skipped,
  };
  actions.push(action);
  if (actions.length > 200) actions.shift();
  runAction(action);
  return { action };
}

// ---------- FTP-controle voor screenshots ----------

const net = require('net');

function localIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const end = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1500, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

async function ftpCheck() {
  const ip = controlSettings.server_ip;
  if (!ip) return null;
  const port = Number(controlSettings.default_ftp_settings_port) || 21;
  const ips = localIps();
  return { ip, port, localIps: ips, isThisPc: ips.includes(ip), listening: await portOpen(ip, port) };
}

// ---------- http ----------

const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkAuth(req) {
  if (!cfg.auth.user) return 'lokaal';
  const [, b64] = (req.headers.authorization || '').split(' ');
  const decoded = Buffer.from(b64 || '', 'base64').toString();
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const u = decoded.slice(0, i);
  const p = decoded.slice(i + 1);
  return safeEqual(u, cfg.auth.user) && safeEqual(p, cfg.auth.password) ? u : null;
}

// Alleen verzoeken van de eigen pagina: JSON (afgedwongen preflight) en, als de
// browser een Origin meestuurt, dezelfde host. Voorkomt dat een andere website
// via de browser van een beheerder acties start.
function sameOrigin(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 1e6) { reject(Object.assign(new Error('Verzoek te groot'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const user = checkAuth(req);
  if (!user) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="D-Line beheer"' });
    return res.end();
  }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/info') {
      return send(res, 200, {
        mode: cfg.mode, minAndroid: cfg.minAndroid, profile, timeoutMs: cfg.timeoutMs,
        controlError, ftp: await ftpCheck(), errors: errors.CATALOG,
      });
    }
    if (req.method === 'GET' && p === '/api/devices') {
      await latestReady; // eerste raadpleging van de PPDS-kennisbank afwachten (nieuwste versies)
      const cat = firmwareCatalog();
      return send(res, 200, devices.map((d) => publicDevice(d, cat)));
    }
    if (req.method === 'GET' && p === '/api/firmware') {
      await latestReady;
      return send(res, 200, { dir: FW_DIR, kbError: latest.error, loadedAt: latest.loadedAt, series: firmwareOverview() });
    }
    if (req.method === 'POST' && p === '/api/firmware/preflight') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Verzoek niet toegestaan (alleen vanuit de tool zelf)' });
      const body = await readBody(req);
      const cat = firmwareCatalog();
      const ids = (body.deviceIds || []).filter((id) => byId.has(id));
      const results = {};
      await pool(ids, cfg.batchSize, async (id) => {
        const dev = byId.get(id);
        const s = seriesOf(dev.model);
        const fw = cat[s] ? { ...cat[s] } : null;
        if (fw && !fw.platform && latest.series[s]) fw.platform = latest.series[s].platform;
        const r = await withTimeout(sicp.preflight(dev, fw, profile, cfg), cfg.timeoutMs * 6)
          .catch((e) => ({ checks: [{ key: 'online', label: 'Bereikbaar', ok: false, text: e.message, code: 'NO_REPLY' }], ready: false, at: new Date().toISOString() }));
        // Firmwarebestand voor een ander apparaat telt ook als blokkade.
        if (fw && otaMismatch(s, fw)) {
          r.checks.push({ key: 'ota', label: 'Firmware voor dit model', ok: false, text: `bestand is voor ${otaMismatch(s, fw)}`, code: 'FW_OTA_MISMATCH' });
          r.ready = false;
        }
        dev.preflight = r;
        results[id] = r;
      });
      return send(res, 200, { results });
    }
    if (req.method === 'POST' && (p === '/api/firmware/download' || p === '/api/firmware/reload')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Verzoek niet toegestaan (alleen vanuit de tool zelf)' });
      const body = await readBody(req);
      if (p === '/api/firmware/reload') { await loadLatest(); return send(res, 200, { ok: !latest.error, error: latest.error }); }
      const s = String(body.series || '').toUpperCase();
      if (!latest.series[s]) return send(res, 400, { error: 'Onbekende serie' });
      if (downloads[s] && downloads[s].state === 'bezig') return send(res, 409, { error: 'Download loopt al' });
      if (upgradeRunning(s)) return send(res, 409, { error: 'Er loopt een firmware-upgrade voor deze serie; ophalen kan na afloop' });
      downloadFirmware(s); // loopt op de achtergrond; voortgang via GET /api/firmware
      return send(res, 202, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/actions') return send(res, 200, [...actions].reverse().slice(0, 50));
    const csv = p.match(/^\/api\/actions\/([^/]+)\/csv$/);
    if (req.method === 'GET' && csv) {
      const a = actions.find((x) => x.id === csv[1]);
      if (!a) return send(res, 404, { error: 'Actie niet gevonden' });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="actie-${a.type}-${a.createdAt.slice(0, 19).replace(/[:T]/g, '-')}.csv"`,
        'Cache-Control': 'no-store',
      });
      return res.end(actionCsv(a));
    }
    if (req.method === 'POST' && p === '/api/actions') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Verzoek niet toegestaan (alleen vanuit de tool zelf)' });
      const r = createAction(await readBody(req), user);
      return send(res, r.error ? 400 : 201, r);
    }
    const shot = p.match(/^\/api\/devices\/([^/]+)\/screenshot$/);
    if (req.method === 'GET' && shot) {
      const dev = byId.get(decodeURIComponent(shot[1]));
      if (!dev) return send(res, 404, { error: 'Onbekend scherm' });
      const img = driver.screenshot(dev);
      if (!img) return send(res, 404, { error: 'Geen screenshot beschikbaar (scherm slaapt, of geen bestand in de FTP-map)' });
      return send(res, 200, img.body, img.contentType);
    }
    if (req.method === 'GET') {
      const pub = path.join(ROOT, 'public') + path.sep;
      const file = path.join(pub, p === '/' ? 'index.html' : path.normalize(p).replace(/^([/\\])+/, ''));
      if (file.startsWith(pub) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), STATIC[path.extname(file)] || 'application/octet-stream');
      }
    }
    send(res, 404, { error: 'Niet gevonden' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
});

if (cfg.mode === 'demo') setInterval(() => demo.poll(devices), cfg.pollSeconds * 1000);
if (cfg.mode === 'control') setInterval(syncControl, cfg.pollSeconds * 1000);

// Poort: --port 8091 bij het starten, anders omgevingsvariabele PORT, anders config.json.
// Zonder expliciete --port/PORT probeert de tool de volgende poorten als de ingestelde bezet is.
const argPort = (process.argv.find((a, i) => process.argv[i - 1] === '--port') || '');
const explicitPort = Number(argPort) || Number(process.env.PORT) || null;
let port = explicitPort || cfg.port;
let portTries = 0;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !explicitPort && portTries < 10) {
    console.log(`Poort ${port} is bezet door een ander programma; probeer ${port + 1}...`);
    portTries++;
    port++;
    server.listen(port, cfg.host);
    return;
  }
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPoort ${port} is al in gebruik door een ander programma op deze pc.`);
    console.error('Kies een andere poort: pas "port" aan in config.json, of start met bijvoorbeeld:');
    console.error('    node server.js --port 8091\n');
  } else {
    console.error('Server kon niet starten:', e.message);
  }
  process.exit(1);
});

(cfg.mode === 'control' ? syncControl() : Promise.resolve()).then(() => {
  server.once('listening', () => {
    const host = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
    const url = `http://${host}:${port}`;
    console.log(`D-Line beheer (${cfg.mode}) draait op ${url} - ${devices.length} schermen`);
    if (controlError) console.log(`Let op: Control-database niet leesbaar: ${controlError}`);
    console.log('Laat dit venster open zolang je de tool gebruikt. Sluiten = tool stoppen.');
    // start.cmd zet DLINE_OPEN=1: dan meteen de browser openen.
    if (process.env.DLINE_OPEN === '1' && process.platform === 'win32') {
      require('child_process').exec(`start "" "${url}"`);
    }
  });
  server.listen(port, cfg.host);
});
