// D-Line beheer: lokale aanvulling op CMND & Control.
// Start: node server.js  (geen npm-packages nodig)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const demo = require('./drivers/demo');
const sicp = require('./drivers/sicp');
const control = require('./drivers/control');

const ROOT = __dirname;
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const cfg = readJson('config.json');
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
      for (const k of CONTROL_FIELDS) prev[k] = d[k];
      return prev;
    });
    byId = new Map(devices.map((d) => [d.id, d]));
    controlSettings = await control.loadSettings(cfg.db).catch(() => ({}));
    controlError = null;
    // Status live uitlezen (alleen-lezen SICP-queries) bij ondersteunde schermen.
    await pool(devices.filter((d) => supportInfo(d).supported), cfg.batchSize, (d) =>
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

function firmwareCatalog() {
  if (!fs.existsSync(FW_DIR)) return {};
  const out = {};
  for (const series of fs.readdirSync(FW_DIR)) {
    const file = path.join(FW_DIR, series, 'update.zip');
    const vfile = path.join(FW_DIR, series, 'version.txt');
    if (!fs.existsSync(file) || !fs.existsSync(vfile)) continue;
    out[series.toUpperCase()] = { file, version: fs.readFileSync(vfile, 'utf8').trim(), size: fs.statSync(file).size };
  }
  return out;
}

function publicDevice(d) {
  const { ftp, ...rest } = d; // FTP-wachtwoord nooit naar de browser
  const fw = firmwareCatalog()[seriesOf(d.model)];
  return { ...rest, ...supportInfo(d), hasFtp: !!(ftp && ftp.user), fwAvailable: fw ? fw.version : null };
}

// ---------- acties ----------

const actions = [];
try {
  const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean);
  for (const l of lines.slice(-200)) actions.push(JSON.parse(l));
} catch { /* nog geen historie */ }

const ACTION_TYPES = ['power', 'powerSave', 'source', 'bootSource', 'schedule', 'refresh', 'screenshot', 'firmware'];

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
  if (!dev) {
    t.status = 'mislukt';
    t.detail = 'Scherm staat niet meer in Control';
    t.doneAt = new Date().toISOString();
    return;
  }
  try {
    // Aan/uit wacht op het opstarten; schema en uitlezen doen meerdere commando's. Daarom ruimere time-out.
    // Firmware: upload + herstart + teruglezen, dat duurt al gauw een half uur.
    let ms = ['power', 'schedule', 'refresh', 'source'].includes(action.type) ? cfg.timeoutMs + 40000 : cfg.timeoutMs * 2;
    let params = action.params;
    if (action.type === 'firmware') {
      ms = ((cfg.firmwareWaitMinutes || 25) + 30) * 60000;
      const fw = firmwareCatalog()[seriesOf(dev.model)];
      params = { ...action.params, resolved: fw ? { [dev.id]: fw } : {}, onStep: (d, msg) => { t.detail = msg; } };
    }
    const res = await withTimeout(driver.execute(dev, action.type, params), ms);
    t.status = res.ok ? 'bevestigd' : res.noReply ? 'geen_reactie' : 'mislukt';
    t.detail = res.ok ? res.detail || '' : res.error;
  } catch (e) {
    t.status = e.blocked ? 'niet_getest' : e.timeout ? 'geen_reactie' : 'mislukt';
    t.detail = e.message;
  }
  t.doneAt = new Date().toISOString();
}

async function runAction(action) {
  // Firmware standaard één scherm tegelijk.
  const n = action.type === 'firmware' ? (cfg.firmwareConcurrency || 1) : cfg.batchSize;
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
  for (const id of deviceIds) {
    const dev = byId.get(id);
    if (!dev) continue;
    const s = supportInfo(dev);
    if (!s.supported) skipped.push({ deviceId: id, reason: s.reason });
    else if (type === 'firmware' && !firmwareCatalog()[seriesOf(dev.model)]) skipped.push({ deviceId: id, reason: `Geen firmware in map voor serie ${seriesOf(dev.model)}` });
    else if (type === 'firmware' && actions.some((a) => a.type === 'firmware' && !a.finishedAt && a.targets.some((x) => x.deviceId === id))) {
      skipped.push({ deviceId: id, reason: 'Er loopt al een firmware-upgrade op dit scherm' });
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

const os = require('os');
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
        controlError, ftp: await ftpCheck(),
      });
    }
    if (req.method === 'GET' && p === '/api/devices') return send(res, 200, devices.map(publicDevice));
    if (req.method === 'GET' && p === '/api/firmware') {
      return send(res, 200, { dir: FW_DIR, series: Object.fromEntries(Object.entries(firmwareCatalog()).map(([k, v]) => [k, { version: v.version, size: v.size }])) });
    }
    if (req.method === 'GET' && p === '/api/actions') return send(res, 200, [...actions].reverse().slice(0, 50));
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
