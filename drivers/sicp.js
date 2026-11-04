// SICP over LAN (TCP). Commando-codes komen uit profiles.json. Commando's die
// niet getest en niet gedocumenteerd zijn, worden niet verstuurd tenzij
// config.sicp.allowUnverified aan staat.

const net = require('net');
const fs = require('fs');
const path = require('path');
const ftp = require('./ftp');

const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildPacket(monitorId, data) {
  const bytes = [data.length + 4, monitorId, 0x00, ...data];
  bytes.push(bytes.reduce((c, b) => c ^ b, 0));
  return Buffer.from(bytes);
}

function sendRaw(dev, cfg, data) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: dev.ip, port: dev.sicpPort || cfg.sicp.port });
    let buf = Buffer.alloc(0);
    const done = (err, val) => { sock.destroy(); err ? reject(err) : resolve(val); };
    sock.setTimeout(cfg.timeoutMs, () => done(Object.assign(new Error('time-out'), { timeout: true })));
    sock.on('error', (e) => done(e));
    sock.on('connect', () => sock.write(buildPacket(cfg.sicp.monitorId, data)));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 1 && buf.length >= buf[0]) {
        const reply = buf.subarray(0, buf[0]);
        const chk = reply.subarray(0, -1).reduce((c, b) => c ^ b, 0);
        if (chk !== reply[reply.length - 1]) return done(new Error('ongeldige checksum in antwoord'));
        done(null, [...reply.subarray(3, -1)]);
      }
    });
  });
}

// Eén SICP-verbinding tegelijk per scherm: poll en acties wachten op elkaar,
// zodat een scherm nooit twee gelijktijdige verbindingen krijgt.
const queues = new Map();
function send(dev, cfg, data) {
  const key = `${dev.ip}:${dev.sicpPort || cfg.sicp.port}`;
  const run = (queues.get(key) || Promise.resolve()).then(() => sendRaw(dev, cfg, data));
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

function ackResult(data) {
  if (data[0] === 0x00 && data[1] === 0x06) return { ok: true };
  if (data[0] === 0x00 && data[1] === 0x15) return { ok: false, code: 'NACK', error: 'NACK (commando geweigerd)' };
  if (data[0] === 0x00 && data[1] === 0x18) return { ok: false, code: 'NAV', error: 'NAV (niet beschikbaar op dit model)' };
  return { ok: false, code: 'UNKNOWN', error: `onverwacht antwoord ${data.map((b) => b.toString(16)).join(' ')}` };
}

function command(profile, cfg, name) {
  const c = profile.sicp[name];
  const blocked = (msg) => Object.assign(new Error(msg), { blocked: true });
  if (!c || c.code == null) throw blocked(`Commando '${name}' is nog niet bekend voor dit model (SICP-documentatie nodig)`);
  // Officieel gedocumenteerde commando's (SICP-document van PPDS) mogen worden verstuurd;
  // ongedocumenteerde alleen na een test op een scherm.
  if (!c.verified && !c.documented && !cfg.sicp.allowUnverified) {
    throw blocked(`Commando '${name}' is nog niet getest; daarom niet verstuurd`);
  }
  return c;
}

const byteKey = (b) => `0x${b.toString(16).padStart(2, '0')}`;
const sourceId = (profile, code) => (code === 0 ? 'last' : profile.sources.find((s) => hex(s.sicpCode) === code)?.id || byteKey(code));
const keyFor = (map, value) => Object.keys(map).find((k) => map[k] === value);

// Per get-commando: hoe het antwoord in het scherm-object terechtkomt.
const READERS = {
  powerGet: (dev, d) => { dev.power = d[0] === 0x02 ? 'aan' : 'backlight_uit'; },
  sourceGet: (dev, d, profile) => { dev.currentSource = sourceId(profile, d[0]); },
  smartPowerGet: (dev, d, profile) => { dev.smartPower = profile.smartPowerCodes[byteKey(d[0])] || null; },
  powerSaveGet: (dev, d, profile) => { dev.powerSaveMode = profile.powerSaveCodes[byteKey(d[0])] || null; },
  bootSourceGet: (dev, d, profile) => { dev.bootSource = sourceId(profile, d[0]); dev.bootSourceExtra = d[1] ?? 0; },
  coldStartGet: (dev, d, profile) => { dev.coldStart = profile.coldStartCodes[byteKey(d[0])] || null; },
};

// Leest één waarde en werkt het scherm-object bij. Geeft false bij NAV, time-out
// of als het commando niet beschikbaar is.
async function read(dev, profile, cfg, name) {
  try {
    const c = command(profile, cfg, name);
    const d = await send(dev, cfg, [hex(c.code)]);
    if (d[0] !== hex(c.code)) return false;
    READERS[name](dev, d.slice(1), profile);
    return true;
  } catch { return false; }
}

// Leest serienummer (0x15) en model (0xA1 0x00) van het apparaat dat op dit IP antwoordt.
// Bij DHCP kan Control een oud IP hebben, waarop nu een ander scherm zit.
async function readIdentity(dev, cfg) {
  const asText = (d) => Buffer.from(d.slice(1)).toString('latin1').replace(/\0/g, '').trim();
  const s = await send(dev, cfg, [0x15]).catch(() => null);
  const m = await send(dev, cfg, [0xA1, 0x00]).catch(() => null);
  return {
    serial: s && s[0] === 0x15 ? asText(s) : null,
    model: m && m[0] === 0xA1 ? asText(m) : null,
  };
}

// Waarden die zelden veranderen (identiteit, firmware, platform) leest de periodieke poll
// maar eens per kwartier; acties controleren de identiteit altijd zelf vooraf.
const SLOW_MS = 15 * 60000;

async function refreshAll(dev, profile, cfg, full = true) {
  // Power eerst en verplicht: geen antwoord = scherm onbereikbaar.
  const c = command(profile, cfg, 'powerGet');
  const d = await send(dev, cfg, [hex(c.code)]);
  if (d[0] === hex(c.code)) READERS.powerGet(dev, d.slice(1), profile);
  dev.lastSeen = new Date().toISOString();
  const slow = full || !dev.slowReadAt || Date.now() - dev.slowReadAt > SLOW_MS || dev.identityMismatch;
  if (!slow) {
    for (const name of ['sourceGet', 'smartPowerGet', 'powerSaveGet', 'bootSourceGet', 'coldStartGet']) await read(dev, profile, cfg, name);
    return;
  }
  dev.slowReadAt = Date.now();
  // Klopt het apparaat op dit IP met wat Control verwacht?
  const id = await readIdentity(dev, cfg);
  const norm = (v) => String(v || '').replace(/\/\d+$/, '').trim().toUpperCase();
  const wrongSerial = id.serial && dev.serial && norm(id.serial) !== norm(dev.serial);
  const wrongModel = id.model && dev.model && norm(id.model) !== norm(dev.model);
  dev.identityMismatch = wrongSerial || wrongModel ? { model: id.model, serial: id.serial } : null;
  if (dev.identityMismatch) return; // verder niets uitlezen van een ander apparaat
  for (const name of ['sourceGet', 'smartPowerGet', 'powerSaveGet', 'bootSourceGet', 'coldStartGet']) {
    if (!(await read(dev, profile, cfg, name))) {
      if (name === 'smartPowerGet') dev.smartPower = null;
      if (name === 'powerSaveGet') dev.powerSaveMode = null;
      if (name === 'coldStartGet') dev.coldStart = null;
    }
  }
  const fw = await readFirmware(dev, profile, cfg, 0x03).catch(() => null);
  if (fw) dev.fwVersion = fw;
  const sc = await readFirmware(dev, profile, cfg, 0x01).catch(() => null);
  if (sc) dev.fwScaler = sc;
  const pl = await readPlatform(dev, cfg).catch(() => null);
  if (pl) dev.platformLive = pl;
}

// SICP 2.13 §3.2 "Model & Firmware Information" (0xA1):
//   0x03 = Android-firmware (FBxx.xx) -> dit werkt update.zip bij
//   0x01 = scaler-firmware (bv. 1.027; NAV als er geen scaler is)
async function readFirmware(dev, profile, cfg, which = 0x03) {
  const c = command(profile, cfg, 'firmwareGet');
  const d = await send(dev, cfg, [hex(c.code), which]);
  if (d[0] !== hex(c.code)) return null;
  return Buffer.from(d.slice(1)).toString('latin1').replace(/\0/g, '').trim() || null;
}

// SICP 2.13 §3.1 (0xA2 0x01): platformlabel, bv. "RK3399_NT68402_D". Staat ook op de PPDS-pagina.
async function readPlatform(dev, cfg) {
  const d = await send(dev, cfg, [0xA2, 0x01]);
  if (d[0] !== 0xA2) return null;
  return Buffer.from(d.slice(1)).toString('latin1').replace(/\0/g, '').trim() || null;
}

// Platform van het scherm vs. platform op de PPDS-pagina ("BDL3550Q 3.0" ~ "BDL3550Q").
const samePlatform = (a, b) => String(a || '').trim().split(/\s+/)[0].toUpperCase() === String(b || '').trim().split(/\s+/)[0].toUpperCase();

// Versies vergelijkbaar maken: 'V1.028' -> '1.028', 'FB02.12' -> '02.12' (zo meldt o.a. de Q-Line het via SICP).
const normVersion = (v) => String(v || '').trim().replace(/^v/i, '').replace(/^FB/i, '');
const sameVersion = (a, b) => normVersion(a) === normVersion(b);

// Schema-pagina volgens SICP 2.13 §10.1.3:
// [pagina<<4 | aan, start-uur, start-min, eind-uur, eind-min, bron, dagen, tag]
// dagen: bit0 = elke week, bit1 = ma … bit7 = zo.
function schedulePayload(profile, page, e) {
  const [sh, sm] = e.on.split(':').map(Number);
  const [eh, em] = e.off.split(':').map(Number);
  const src = profile.sources.find((s) => s.id === e.source);
  const days = e.days.reduce((b, d) => b | (1 << (d + 1)), 0x01);
  // Tag 0x00: de schermen melden bij o.a. Custom altijd tag 0 terug (getest op 50BDL4650D).
  return [(page << 4) | 0x01, sh, sm, eh, em, src && src.id !== 'last' ? hex(src.sicpCode) : 0x00, days, 0x00];
}

async function readSchedule(dev, profile, cfg) {
  const c = command(profile, cfg, 'scheduleGet');
  const pages = [];
  for (let p = 1; p <= 7; p++) {
    const d = await send(dev, cfg, [hex(c.code), p]).catch(() => null);
    if (!d || d[0] !== hex(c.code) || d.length < 9) { pages.push(null); continue; }
    // Q-Line meldt het paginanummer mee in de bovenste 4 bits (bv. 0x10); alleen de onderste telt.
    const [, enRaw, sh, sm, eh, em, src, days, tag] = d;
    const en = enRaw & 0x0F;
    // uur 24 / minuut 60 = NULL (geen tijd ingesteld)
    const t = (h, m) => (h === 24 || m === 60 ? null : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    pages.push({
      enabled: en === 0x01,
      on: t(sh, sm),
      off: t(eh, em),
      source: sourceId(profile, src),
      days: [0, 1, 2, 3, 4, 5, 6].filter((i) => days & (1 << (i + 1))),
      raw: [(p << 4) | en, sh, sm, eh, em, src, days, tag],
    });
  }
  return pages;
}

async function writePages(dev, profile, cfg, pages) {
  const reset = command(profile, cfg, 'scheduleReset');
  let res = ackResult(await send(dev, cfg, [hex(reset.code), 0x00]));
  if (!res.ok) return res;
  const set = command(profile, cfg, 'scheduleSet');
  for (let i = 0; i < pages.length; i++) {
    res = ackResult(await send(dev, cfg, [hex(set.code), ...pages[i]]));
    if (!res.ok) return { ok: false, code: res.code, error: `pagina ${i + 1}: ${res.error}` };
  }
  return { ok: true };
}

// Zet een waarde, controleert de ACK en leest alleen die waarde terug ter bevestiging.
async function setAndVerify(dev, profile, cfg, setName, payload, getName, check) {
  const c = command(profile, cfg, setName);
  const res = ackResult(await send(dev, cfg, [hex(c.code), ...payload]));
  if (!res.ok) return res;
  await sleep(800);
  if (!(await read(dev, profile, cfg, getName))) return { ok: false, noReply: true, code: 'NO_REPLY', error: 'ACK ontvangen, maar teruglezen gaf geen antwoord' };
  return check() ? { ok: true, detail: 'teruggelezen en gelijk' } : { ok: false, code: 'VERIFY_FAILED', error: 'ACK ontvangen, maar teruggelezen waarde wijkt af' };
}

async function execute(dev, type, params, profile, cfg) {
  // Vóór elke wijzigende actie controleren dat op dit IP echt het verwachte scherm zit.
  if (type !== 'refresh') {
    const id = await readIdentity(dev, cfg);
    const norm = (v) => String(v || '').replace(/\/\d+$/, '').trim().toUpperCase();
    if ((id.serial && dev.serial && norm(id.serial) !== norm(dev.serial)) || (id.model && dev.model && norm(id.model) !== norm(dev.model))) {
      dev.identityMismatch = { model: id.model, serial: id.serial };
      return { ok: false, code: 'IDENTITY_MISMATCH', error: `Niet uitgevoerd: op ${dev.ip} antwoordt ${id.model || '?'} (serienr ${id.serial || '?'}), niet ${dev.model}. Werk het IP-adres bij in Control.` };
    }
  }
  switch (type) {
    case 'refresh': {
      // Periodieke poll (quick): trage waarden maar eens per kwartier; "Uitlezen" leest alles.
      await refreshAll(dev, profile, cfg, !params.quick);
      // Het schema (7 pagina's) alleen bij een expliciete 'Uitlezen', niet bij elke periodieke poll.
      if (!params.quick) dev.schedule = await readSchedule(dev, profile, cfg).catch(() => dev.schedule);
      return { ok: true, detail: `power: ${dev.power}` };
    }
    case 'powerSave': {
      const code = keyFor(profile.powerSaveCodes, String(params.mode));
      const res = await setAndVerify(dev, profile, cfg, 'powerSaveSet', [hex(code)], 'powerSaveGet', () => dev.powerSaveMode === String(params.mode));
      if (!res.ok || !params.smartPower) return res;
      const sp = keyFor(profile.smartPowerCodes, params.smartPower);
      return setAndVerify(dev, profile, cfg, 'smartPowerSet', [hex(sp)], 'smartPowerGet', () => dev.smartPower === params.smartPower);
    }
    case 'source': {
      // Bron direct wisselen: [bron, playlist/tag, OSD-stijl, effect], zoals de voorbeelden in SICP 2.13.
      const src = profile.sources.find((s) => s.id === params.source);
      const c = command(profile, cfg, 'sourceSet');
      const res = ackResult(await send(dev, cfg, [hex(c.code), hex(src.sicpCode), 0x00, 0x01, 0x00]));
      if (!res.ok) return res;
      // Een app of mediaspeler heeft een paar seconden nodig om te starten.
      let answered = false;
      for (let i = 0; i < 6; i++) {
        await sleep(1500);
        answered = (await read(dev, profile, cfg, 'sourceGet')) || answered;
        if (dev.currentSource === params.source) return { ok: true, detail: 'gewisseld en teruggelezen' };
      }
      return answered
        ? { ok: false, code: 'VERIFY_FAILED', error: `ACK ontvangen, maar scherm meldt bron ${dev.currentSource}` }
        : { ok: false, noReply: true, code: 'NO_REPLY', error: 'ACK ontvangen, maar teruglezen gaf geen antwoord' };
    }
    case 'bootSource': {
      const src = profile.sources.find((s) => s.id === params.source);
      return setAndVerify(dev, profile, cfg, 'bootSourceSet', [hex(src.sicpCode), dev.bootSourceExtra || 0], 'bootSourceGet', () => dev.bootSource === params.source);
    }
    case 'power': {
      const c = command(profile, cfg, 'powerSet');
      const res = ackResult(await send(dev, cfg, [hex(c.code), hex(params.state === 'off' ? c.off : c.on)]));
      if (!res.ok) return res;
      dev.lastSeen = new Date().toISOString();
      // Tijdens het opstarten antwoordt het scherm een paar seconden met NAV; daarom opnieuw proberen.
      const want = params.state === 'off' ? 'backlight_uit' : 'aan';
      for (let i = 0; i < 6; i++) {
        await sleep(2500);
        if ((await read(dev, profile, cfg, 'powerGet')) && dev.power === want) return { ok: true, detail: 'teruggelezen en gelijk' };
      }
      // Bij uitzetten in power-save Mode 1/2 valt het netwerk weg; dat is dan verwacht gedrag.
      const hint = params.state === 'off' && ['1', '2'].includes(dev.powerSaveMode) ? ' (verwacht in power-save Mode 1/2: netwerk uit in standby)' : '';
      return { ok: false, noReply: true, code: 'NO_REPLY', error: `ACK ontvangen, maar status niet bevestigd${hint}` };
    }
    case 'schedule': {
      // SICP 2.13 §10.1: 7 pagina's. Eerst het huidige schema bewaren, dan resetten en
      // per regel een pagina zetten. Gaat dat mis, dan wordt het oude schema teruggezet.
      const old = await readSchedule(dev, profile, cfg);
      if (old.some((p) => p === null)) return { ok: false, code: 'NO_REPLY', error: 'Huidig schema kon niet volledig worden uitgelezen; niets gewijzigd' };
      const pages = params.entries.slice(0, 7).map((e, i) => schedulePayload(profile, i + 1, e));
      const res = await writePages(dev, profile, cfg, pages);
      if (!res.ok) {
        const back = await writePages(dev, profile, cfg, old.map((p) => p.raw)).catch((e) => ({ ok: false, error: e.message }));
        return { ok: false, code: res.code || 'UNKNOWN', error: `${res.error}; oud schema ${back.ok ? 'teruggezet' : `NIET teruggezet (${back.error})`}` };
      }
      await sleep(500);
      const now = await readSchedule(dev, profile, cfg);
      dev.schedule = now;
      // Vergelijk tijden, bron en dagen; de tag laat het scherm soms op 0 staan.
      const same = pages.every((p, i) => now[i] && now[i].enabled && now[i].raw.slice(1, 7).join(',') === p.slice(1, 7).join(','));
      return same ? { ok: true, detail: `${pages.length} pagina('s) gezet en teruggelezen` } : { ok: false, code: 'VERIFY_FAILED', error: 'ACK ontvangen, maar teruggelezen schema wijkt af' };
    }
    case 'screenshot': {
      const ac = profile.sicp.screenshotAvailable;
      const avail = ac ? await send(dev, cfg, [hex(ac.code)]).catch(() => null) : null;
      if (avail && avail[0] === hex(ac.code) && avail[1] === 0x00) return { ok: false, code: 'NAV', error: 'Scherm meldt: screenshot nu niet mogelijk (bron niet vast te leggen)' };
      const c = command(profile, cfg, 'screenshotSend');
      const r = ackResult(await send(dev, cfg, [hex(c.code)]));
      return r.ok ? { ok: true, detail: 'Screenshot gemaakt; het scherm mailt hem naar het ingestelde e-mailadres' } : r;
    }
    case 'restart': {
      // SICP 2.13 §4.4: 0x57 0x00 = herstart (Android, en vanaf 2.13 ook de scaler). Daarna wachten
      // tot het scherm weer antwoordt, zodat bv. nieuwe FTP-instellingen actief zijn.
      const c = command(profile, cfg, 'restart');
      const res = ackResult(await send(dev, cfg, [hex(c.code), 0x00]));
      if (!res.ok) return res;
      const t0 = Date.now();
      let wasDown = false;
      while (Date.now() - t0 < 180000) {
        await sleep(10000);
        const up = await read(dev, profile, cfg, 'powerGet');
        if (!up) wasDown = true;
        else if (wasDown || Date.now() - t0 > 60000) return { ok: true, detail: `herstart; na ${Math.round((Date.now() - t0) / 1000)} s weer bereikbaar` };
      }
      return { ok: false, noReply: true, code: 'NO_REPLY', error: 'Herstart verstuurd, maar het scherm is na 3 minuten nog niet weer bereikbaar' };
    }
    case 'firmware': {
      // SICP 2.13 §11.13: update.zip in de hoofdmap van het scherm, daarna 0x20 0x00.
      // params.file / params.version worden door de server per model ingevuld.
      const fw = params.resolved && params.resolved[dev.id];
      if (!fw) return { ok: false, code: 'FW_NO_FILE', error: 'Geen firmwarebestand gevonden voor dit model' };
      const before = await readFirmware(dev, profile, cfg, 0x03).catch(() => null);
      // Zonder uitleesbare versie is de upgrade achteraf niet te bevestigen: dan niet starten.
      if (!before) return { ok: false, code: 'FW_VERSION_UNREADABLE', error: 'Android-firmwareversie niet uitleesbaar via SICP (0xA1 0x03); upgrade niet gestart omdat het resultaat niet te controleren is' };
      if (sameVersion(before, fw.version)) return { ok: true, code: 'FW_ALREADY_CURRENT', detail: `al actueel (${before})` };
      // PPDS-voorschrift (FW Update SOP): zet het scherm vóór een firmware-update op power save Mode 4.
      if (!(await read(dev, profile, cfg, 'powerSaveGet'))) {
        return { ok: false, code: 'NO_REPLY', error: 'Power-save-modus niet uitleesbaar; PPDS schrijft Mode 4 voor tijdens een firmware-update. Upgrade niet gestart' };
      }
      if (dev.powerSaveMode !== '4') {
        return { ok: false, code: 'FW_NOT_MODE4', error: `Scherm staat op power save Mode ${dev.powerSaveMode}; PPDS schrijft Mode 4 voor tijdens een firmware-update. Zet eerst Mode 4 (tabblad Power save) en probeer opnieuw` };
      }
      // Platform van het scherm moet overeenkomen met het platform op de PPDS-pagina. Zonder bekend
      // platform (bv. handmatig neergezette firmware van een serie buiten de kennisbank) niet starten.
      if (!fw.platform) return { ok: false, code: 'FW_PLATFORM_MISMATCH', error: 'Platform van deze firmware onbekend (serie niet in kb-catalog.json); upgrade niet gestart' };
      const live = await readPlatform(dev, cfg).catch(() => null);
      if (!live) return { ok: false, code: 'FW_PLATFORM_MISMATCH', error: 'Platform van het scherm niet uitleesbaar (0xA2 0x01); upgrade niet gestart' };
      if (!samePlatform(live, fw.platform)) return { ok: false, code: 'FW_PLATFORM_MISMATCH', error: `Scherm heeft platform ${live}, de firmware is voor ${fw.platform}; upgrade niet gestart` };
      // version.txt moet dezelfde notatie hebben als het scherm meldt (bv. 1.028, niet FB01.19).
      if (/^\d+\.\d+/.test(normVersion(before)) !== /^\d+\.\d+/.test(normVersion(fw.version))) {
        return { ok: false, code: 'FW_WRONG_VERSION', error: `version.txt (${fw.version}) heeft een andere notatie dan het scherm meldt (${before}); pas version.txt aan` };
      }
      if (dev.power !== 'aan') return { ok: false, code: 'FW_SCREEN_OFF', error: 'Scherm moet aan staan voor een firmware-upgrade' };
      // Lukt de FTP-upload niet, dan wordt de upgrade (0x20) niet gestart.
      // Control bewaart het FTP-wachtwoord versleuteld; daarom heeft config.displayFtp voorrang.
      const login = cfg.displayFtp && cfg.displayFtp.user ? cfg.displayFtp : dev.ftp;
      if (!login || !login.user || !login.password) return { ok: false, code: 'FW_NO_FTP_ACCOUNT', error: 'Geen FTP-gegevens: vul displayFtp in config.local.json in' };
      if (login === dev.ftp) return { ok: false, code: 'FW_NO_FTP_ACCOUNT', error: 'Vul displayFtp in config.json in: het FTP-wachtwoord in Control is versleuteld en werkt niet' };
      const upgrade = command(profile, cfg, 'firmwareUpgrade');
      if (params.onStep) params.onStep(dev, `upload ${fw.version} gestart`, 'upload');
      const account = { port: login.port || 2121, user: login.user, password: login.password };
      // Bij een fout het (halve) update.zip weer van het scherm halen: het neemt ruimte in en het
      // scherm kan een kapot bestand anders zelf als update aanbieden.
      const cleanup = async () => {
        try { await ftp.remove(dev.ip, account, 'update.zip'); return 'het (halve) update.zip is van het scherm verwijderd'; } catch (e) { return `update.zip kon niet van het scherm worden verwijderd (${e.message})`; }
      };
      try {
        await ftp.upload(dev.ip, account, fw.file, 'update.zip', (sent, size) => {
          if (params.onStep) params.onStep(dev, `upload ${Math.floor((sent / size) * 100)}% (${Math.round(sent / 1048576)} van ${Math.round(size / 1048576)} MB)`, 'upload');
        }, 120000);
      } catch (e) {
        throw new Error(`${e.message}; ${await cleanup()}`);
      }
      if (params.onStep) params.onStep(dev, 'upload klaar, upgrade starten', 'starten');
      const r = await send(dev, cfg, [hex(upgrade.code), 0x00]).catch((e) => { throw new Error(`startcommando 0x20: ${e.message}`); });
      const started = (r[0] === hex(upgrade.code) && r[1] === 0x06) || ackResult(r).ok;
      if (!started) return { ok: false, code: 'FW_NOT_STARTED', error: `Upgrade niet gestart: ${ackResult(r).error}; ${await cleanup()}` };
      // Het scherm herstart en is 5+ minuten bezig; daarna de versie teruglezen.
      const deadline = Date.now() + (cfg.firmwareWaitMinutes || 25) * 60000;
      let last = null;
      while (Date.now() < deadline) {
        await sleep(30000);
        last = await readFirmware(dev, profile, cfg, 0x03).catch(() => null) || last;
        if (params.onStep) params.onStep(dev, last ? `bezig, scherm meldt ${last}` : 'bezig, scherm herstart', 'herstart');
        if (sameVersion(last, fw.version)) return { ok: true, detail: `${before} → ${last}` };
      }
      if (last && !sameVersion(last, before)) return { ok: false, code: 'FW_WRONG_VERSION', error: `Firmware gewijzigd naar ${last}, maar verwacht ${fw.version}; controleer version.txt` };
      return last
        ? { ok: false, code: 'FW_WRONG_VERSION', error: `Na upgrade meldt scherm ${last}, verwacht ${fw.version}` }
        : { ok: false, noReply: true, code: 'FW_TIMEOUT', error: 'Scherm reageert niet meer na de upgrade; controleer het ter plekke' };
    }
    default:
      return { ok: false, error: `onbekende actie ${type}` };
  }
}

const IMG = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.bmp': 'image/bmp' };

// Het scherm uploadt zelf screenshots naar een FTP-server; hier lezen we de
// nieuwste afbeelding uit de map die die FTP-server gebruikt.
function screenshot(dev, cfg) {
  if (!cfg.screenshotDir) return null;
  for (const sub of [dev.screenshotFolder, dev.serial, dev.ip, dev.name].filter(Boolean)) {
    const dir = path.join(cfg.screenshotDir, sub);
    if (!fs.existsSync(dir)) continue;
    const newest = fs.readdirSync(dir)
      .filter((f) => IMG[path.extname(f).toLowerCase()])
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (newest) {
      return {
        contentType: IMG[path.extname(newest.f).toLowerCase()],
        body: fs.readFileSync(path.join(dir, newest.f)),
        takenAt: new Date(newest.t).toISOString(),
      };
    }
  }
  return null;
}

// Controle vóór een firmware-upgrade, zonder iets te wijzigen (alleen uitlezen + FTP-login).
// Geeft per punt ok/niet-ok met uitleg, en of het scherm klaar is voor de upgrade.
async function preflight(dev, fw, profile, cfg) {
  const checks = [];
  const add = (key, label, ok, text, code) => checks.push({ key, label, ok, text, code: ok ? null : code });
  const done = (extra = {}) => ({ checks, ready: checks.every((c) => c.ok) && !extra.current, at: new Date().toISOString(), ...extra });

  // 1. Bereikbaar en aan
  let power = null;
  try {
    const c = command(profile, cfg, 'powerGet');
    const d = await send(dev, cfg, [hex(c.code)]);
    if (d[0] === hex(c.code)) { READERS.powerGet(dev, d.slice(1), profile); power = dev.power; }
  } catch { /* geen antwoord */ }
  add('online', 'Bereikbaar', !!power, power ? 'reageert via SICP' : 'geen reactie via SICP', 'NO_REPLY');
  if (!power) return done();
  add('power', 'Scherm aan', power === 'aan', power === 'aan' ? 'aan' : 'staat uit (standby)', 'FW_SCREEN_OFF');

  // 2. Juist apparaat op dit IP
  const id = await readIdentity(dev, cfg);
  const norm = (v) => String(v || '').replace(/\/\d+$/, '').trim().toUpperCase();
  const idOk = !(id.serial && dev.serial && norm(id.serial) !== norm(dev.serial)) && !(id.model && dev.model && norm(id.model) !== norm(dev.model));
  add('identity', 'Juist apparaat', idOk, idOk ? `serienr ${id.serial || '?'}` : `op dit IP: ${id.model || '?'} (${id.serial || '?'})`, 'IDENTITY_MISMATCH');
  if (!idOk) return done();

  // 3. Versie, Mode 4, platform
  const current = await readFirmware(dev, profile, cfg, 0x03).catch(() => null);
  if (current) dev.fwVersion = current;
  add('version', 'Versie uitleesbaar', !!current, current || 'niet uitleesbaar via SICP', 'FW_VERSION_UNREADABLE');
  const already = !!(current && fw && sameVersion(current, fw.version));
  const ps = await read(dev, profile, cfg, 'powerSaveGet');
  add('mode4', 'Power save Mode 4', ps && dev.powerSaveMode === '4', ps ? `Mode ${dev.powerSaveMode}` : 'niet uitleesbaar', 'FW_NOT_MODE4');
  const live = await readPlatform(dev, cfg).catch(() => null);
  if (live) dev.platformLive = live;
  const platOk = !!(fw && fw.platform && live && samePlatform(live, fw.platform));
  add('platform', 'Platform past', platOk, live ? `${live}${fw && fw.platform ? ` / firmware: ${fw.platform}` : ''}` : 'niet uitleesbaar', 'FW_PLATFORM_MISMATCH');

  // 4. Firmware klaar en FTP-login (de enige handeling op het scherm: inloggen en weer uitloggen)
  add('file', 'Firmware klaargezet', !!fw, fw ? `${fw.version}` : 'geen firmware in de map', 'FW_NO_FILE');
  const login = cfg.displayFtp && cfg.displayFtp.user ? cfg.displayFtp : null;
  if (!login || !login.password) add('ftp', 'FTP-login', false, 'geen FTP-account in config.local.json', 'FW_NO_FTP_ACCOUNT');
  else {
    try {
      await ftp.check(dev.ip, { port: login.port || 2121, user: login.user, password: login.password });
      add('ftp', 'FTP-login', true, 'gelukt');
    } catch (e) {
      add('ftp', 'FTP-login', false, e.message, /530|login/i.test(e.message) ? 'FTP_LOGIN' : 'FTP_UNREACHABLE');
    }
  }
  return done({ current: already, version: current });
}

module.exports = { execute, screenshot, buildPacket, preflight };
