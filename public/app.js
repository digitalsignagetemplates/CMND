const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DAYS = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
const POWER_LABEL = { aan: 'Aan', backlight_uit: 'Backlight uit', slaapt: 'Slaapt', uit: 'Uit', onbekend: 'Onbekend' };
const STATUS_LABEL = { wachtrij: 'wachtrij', verstuurd: 'bezig', bevestigd: 'bevestigd', mislukt: 'mislukt', geen_reactie: 'geen reactie', niet_getest: 'niet verstuurd (niet getest)', overgeslagen: 'overgeslagen' };
const TYPE_LABEL = { power: 'Aan/uit', powerSave: 'Power save', source: 'Bron wisselen', bootSource: 'Opstartbron', schedule: 'Powerschema', refresh: 'Status uitlezen', screenshot: 'Screenshot maken', firmware: 'Firmware-upgrade' };

let info;
let devices = [];
let actions = [];
const selected = new Set();
let tab = 'power';

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { body });
  return body;
}

const sourceLabel = (id) => info.profile.sources.find((s) => s.id === id)?.label || id || '–';
const shortModel = (m) => String(m || '').replace(/\/\d+$/, '');

// ---------- header, meldingen, kpi's ----------

function renderAlerts() {
  const out = [];
  if (info.controlError) out.push(`<p class="note bad"><strong>Control-database niet leesbaar.</strong> ${esc(info.controlError)}</p>`);
  const f = info.ftp;
  if (f && (!f.isThisPc || !f.listening)) {
    const why = [];
    if (!f.isThisPc) why.push(`deze pc heeft ${esc(f.localIps.filter((i) => !i.startsWith('169.254')).join(', ') || 'een ander IP')}`);
    if (!f.listening) why.push(`er luistert niets op ${esc(f.ip)}:${f.port}`);
    out.push(`<p class="note warn"><strong>Screenshots:</strong> Control laat schermen uploaden naar FTP ${esc(f.ip)}:${f.port}, maar ${why.join(' en ')}. Dit is waarschijnlijk waarom screenshots niet werken.</p>`);
  }
  $('#alerts').innerHTML = out.join('');
}

function renderKpis() {
  const dl = devices.filter((d) => d.supported);
  const n = (p) => dl.filter((d) => d.power === p).length;
  const failed = actions.flatMap((a) => a.targets).filter((t) => t.status === 'mislukt' || t.status === 'geen_reactie').length;
  const tiles = [
    ['Philips-schermen', dl.length, 'var(--accent)'],
    ['Aan', n('aan'), 'var(--ok)'],
    ['Backlight uit', n('backlight_uit'), 'var(--info)'],
    ['Slaapt / onbekend', n('slaapt') + n('uit') + n('onbekend'), 'var(--wait)'],
    ['Mislukte acties', failed, 'var(--bad)'],
  ];
  $('#kpis').innerHTML = tiles.map(([l, v, c]) => `<div class="kpi"><div class="v">${v}</div><div class="l"><span class="dot" style="background:${c}"></span>${l}</div></div>`).join('');
}

// ---------- schema ----------

function scheduleSummary(s) {
  if (!Array.isArray(s) || !s.length || s.every((p) => p === null)) return '?';
  const n = s.filter((p) => p && p.enabled).length;
  return n ? `${n} regel${n === 1 ? '' : 's'}` : 'geen';
}

function scheduleText(s) {
  if (!Array.isArray(s)) return '';
  return s.filter((p) => p && p.enabled)
    .map((p) => `${p.days.map((d) => DAYS[d]).join('/') || 'geen dagen'} aan ${p.on || '–'} · uit ${p.off || '–'} · ${sourceLabel(p.source)}`).join('\n');
}

// ---------- firmware ----------

// Nieuwste Android-firmware volgens de PPDS-kennisbank vergelijken met wat het scherm
// meldt (SICP 0xA1 0x03, of anders de firmware uit Control).
function fwUpdateLabel(d) {
  if (!d.fwLatest) return '';
  const current = d.fwVersion || d.firmware;
  if (!current || current.toUpperCase() === d.fwLatest.toUpperCase()) return '';
  return ` · <strong>nieuwste ${esc(d.fwLatest)}</strong>`;
}

const link = (href, text) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : '');

const mb = (n) => `${Math.round(n / 1048576)} MB`;

// ---- Firmware-updates: overzicht per serie, controle per scherm, start en voortgang ----

let fwData = { series: {} };
let fwSeriesSel = null;
const fwSel = new Set();
let fwChecking = false;

const CHECK_ORDER = [['online', 'Bereikbaar'], ['power', 'Aan'], ['identity', 'Apparaat'], ['version', 'Versie'], ['mode4', 'Mode 4'], ['platform', 'Platform'], ['file', 'Bestand'], ['ftp', 'FTP'], ['ota', 'Bestand voor model']];
const seriesOf = (m) => ((String(m || '').match(/BDL(\d{4}[A-Z])/i) || [])[1] || '').toUpperCase();
const normV = (v) => String(v || '').trim().replace(/^v/i, '').replace(/^FB/i, '').toUpperCase();

// Lopende of laatste firmware-actie per scherm (voor de voortgang in de tabel).
function fwTargetFor(id) {
  for (const a of actions) {
    if (a.type !== 'firmware') continue;
    const t = a.targets.find((x) => x.deviceId === id);
    if (t) return { a, t };
  }
  return null;
}

function fwStatus(d, latest) {
  const cur = d.fwVersion || d.firmware;
  const run = fwTargetFor(d.id);
  if (run && !run.t.doneAt) return { cls: 'now', text: 'Bezig' };
  if (latest && cur && normV(cur) === normV(latest)) return { cls: 'done', text: 'Actueel' };
  if (run && run.t.status === 'mislukt') return { cls: 'fail', text: 'Mislukt' };
  if (d.preflight && d.preflight.ready) return { cls: 'done', text: 'Klaar voor update' };
  if (d.preflight && !d.preflight.ready) return { cls: 'fail', text: 'Niet klaar' };
  return { cls: '', text: latest && cur ? 'Update nodig' : 'Onbekend' };
}

async function loadFirmware() {
  fwData = await api('/api/firmware').catch((e) => ({ series: {}, kbError: e.message }));
  renderFwSection();
  return Object.values(fwData.series).some((v) => v.download && v.download.state === 'bezig');
}

function renderFwSection() {
  const entries = Object.entries(fwData.series).sort((a, b) => b[1].inUse - a[1].inUse);
  if (!fwSeriesSel && entries.length) fwSeriesSel = (entries.find(([, v]) => v.upgradable) || entries[0])[0];
  $('#fwSeries').innerHTML = (fwData.kbError ? `<p class="note warn">${esc(fwData.kbError)}</p>` : '') + entries.map(([s, v]) => {
    const devs = devices.filter((d) => seriesOf(d.model) === s);
    const need = v.latest ? devs.filter((d) => (d.fwVersion || d.firmware) && normV(d.fwVersion || d.firmware) !== normV(v.latest.version)).length : 0;
    const state = !v.latest ? 'niet in kennisbank' : !v.upgradable ? 'handmatig (PPDS-instructie)' : v.ready && !v.ready.mismatch && normV(v.ready.version) === normV(v.latest.version) ? 'firmware klaar' : v.ready && v.ready.mismatch ? 'bestand geblokkeerd' : 'nog ophalen';
    return `<button class="fw-tile ${s === fwSeriesSel ? 'sel' : ''}" data-series="${esc(s)}">
      <span class="fw-tile-name">${esc(s)}</span>
      <span class="small">${devs.length} scherm${devs.length === 1 ? '' : 'en'} · <strong>${need}</strong> update nodig</span>
      <span class="small muted">nieuwste ${esc((v.latest && v.latest.version) || '?')} · ${esc(state)}</span>
    </button>`;
  }).join('');
  renderFwPanel();
}

function renderFwPanel() {
  const s = fwSeriesSel;
  const v = fwData.series[s];
  if (!v) { $('#fwPanel').innerHTML = ''; return; }
  const l = v.latest;
  const dl = v.download;
  const devs = devices.filter((d) => seriesOf(d.model) === s);
  for (const id of [...fwSel]) if (!devs.some((d) => d.id === id)) fwSel.delete(id);

  // 1. Firmware van deze serie
  const info = [];
  if (!l) info.push(`<span class="muted">${esc(v.kbError || 'Niet gevonden in de PPDS-kennisbank')}</span>`);
  else {
    info.push(`<span>Nieuwste Android: <strong>${esc(l.version || '?')}</strong>${l.scaler ? ` <span class="muted">· scaler v${esc(l.scaler)} (niet via de tool)</span>` : ''} <span class="muted">· platform ${esc(l.platform || '?')}</span></span>`);
    info.push(`<span class="small">${[link(l.page, 'PPDS-pagina'), link(l.releaseNotes, 'Release notes'), link(l.instructions, 'Instructies')].filter(Boolean).join(' · ')}</span>`);
    if (!v.upgradable) info.push(`<span class="warn-text">PPDS levert voor deze serie geen los update.zip (${esc(l.file || '?')}): bijwerken via USB volgens de instructies.</span>`);
  }
  if (v.ready) {
    if (v.ready.mismatch) info.push(`<span class="bad-text"><strong>Geblokkeerd:</strong> het klaargezette bestand is volgens zichzelf voor "${esc(v.ready.mismatch)}". Laat PPDS bevestigen (otaAliases) of haal opnieuw op.</span>`);
    else info.push(`<span class="ok-text">Klaargezet: ${esc(v.ready.version)} (${mb(v.ready.size)})${v.ready.ota && v.ready.ota.device ? ` · voor ${esc(v.ready.ota.device)}` : ''}</span>`);
  }
  if (dl && dl.state === 'bezig') info.push(`<progress max="${dl.total || 1}" value="${dl.received}"></progress><span class="muted small">Ophalen… ${mb(dl.received)}${dl.total ? ` van ${mb(dl.total)}` : ''}</span>`);
  else if (dl && dl.state === 'mislukt') info.push(`<span class="bad-text">Ophalen mislukt: ${esc(dl.error)}</span>`);
  const canFetch = l && v.upgradable && !(dl && dl.state === 'bezig');
  const fetchLabel = v.ready && normV(v.ready.version) === normV(l && l.version) ? 'Opnieuw ophalen' : 'Firmware ophalen';

  // 2. Voortgang van een lopende update voor deze serie
  const running = actions.find((a) => a.type === 'firmware' && !a.finishedAt && a.targets.some((t) => devs.some((d) => d.id === t.deviceId)));
  let progress = '';
  if (running) {
    const tot = running.targets.length;
    const ok = running.targets.filter((t) => t.status === 'bevestigd').length;
    const bad = running.targets.filter((t) => ['mislukt', 'geen_reactie'].includes(t.status)).length;
    const busy = running.targets.filter((t) => t.status === 'verstuurd').length;
    progress = `<div class="fw-progress"><strong>Update loopt:</strong> ${ok} van ${tot} klaar · ${busy} bezig · ${bad} mislukt · ${tot - ok - bad - busy} in de wachtrij
      <progress max="${tot}" value="${ok + bad}"></progress></div>`;
  }

  // 3. Schermen met controlelijst
  const rows = devs.map((d) => {
    const st = fwStatus(d, l && l.version);
    const pf = d.preflight;
    const checks = pf ? CHECK_ORDER.map(([k, label]) => {
      const c = pf.checks.find((x) => x.key === k);
      if (!c) return '';
      const e = c.code ? errInfo(c.code) : null;
      return `<span class="ck ${c.ok ? 'ok' : 'bad'}" title="${esc(`${label}: ${c.text}${e && !c.ok ? `\n${e.fix}` : ''}`)}">${c.ok ? '✓' : '✗'} ${esc(label)}</span>`;
    }).join('') : '<span class="muted small">nog niet gecontroleerd</span>';
    // Bij een actueel scherm doen de controles er niet toe; geen foutmelding tonen.
    const firstBad = st.text !== 'Actueel' && pf && pf.checks.find((c) => !c.ok);
    const why = firstBad ? `<div class="small bad-text">${esc((errInfo(firstBad.code) || {}).title || firstBad.label)}: ${esc(firstBad.text)}</div>` : '';
    const run = fwTargetFor(d.id);
    const phase = run && (run.t.phase || run.t.status !== 'bevestigd') ? `${phaseBar(run.t)}${!run.t.doneAt ? `<div class="small muted">${esc(run.t.detail || '')}</div>` : ''}` : '';
    const disabled = !!(run && !run.t.doneAt);
    return `<tr class="${fwSel.has(d.id) ? 'sel' : ''}">
      <td><input type="checkbox" data-fwsel="${esc(d.id)}" ${fwSel.has(d.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}></td>
      <td><div class="dev-name">${esc(d.name === d.ip ? shortModel(d.model) : d.name)}</div><div class="dev-sub">${esc(d.ip)}</div></td>
      <td>${esc(d.fwVersion || d.firmware || '–')} <span class="muted">→</span> ${esc((l && l.version) || '?')}</td>
      <td><span class="ph ${st.cls}">${esc(st.text)}</span></td>
      <td class="wrap"><div class="checks">${checks}</div>${why}${phase}</td>
    </tr>`;
  }).join('');

  const selDevs = devs.filter((d) => fwSel.has(d.id));
  const readySel = selDevs.filter((d) => d.preflight && d.preflight.ready);
  const startable = v.upgradable && v.ready && !v.ready.mismatch && readySel.length && !running;
  $('#fwPanel').innerHTML = `
    <div class="fw-info">${info.join('')}${canFetch ? `<div><button class="ghost" data-fetch="${esc(s)}">${fetchLabel}</button></div>` : ''}</div>
    ${progress}
    <div class="fw-toolbar">
      <label class="switch"><input type="checkbox" id="fwSelAll" ${devs.length && selDevs.length === devs.length ? 'checked' : ''}><span>Alles</span></label>
      <button class="ghost" id="fwCheck" ${fwChecking || !selDevs.length ? 'disabled' : ''}>${fwChecking ? 'Controleren…' : `Controleer geselecteerde (${selDevs.length})`}</button>
      <button class="ghost" id="fwSelReady">Selecteer alle klare</button>
      <button class="ghost" id="fwMode4" ${!selDevs.length ? 'disabled' : ''} title="Zet power save op Mode 4 (PPDS-voorschrift voor firmware-updates)">Zet Mode 4 op geselecteerde</button>
      <span class="spacer"></span>
      <button class="primary" id="fwStart" ${startable ? '' : 'disabled'} title="${startable ? '' : 'Selecteer schermen die "Klaar voor update" zijn, met klaargezette firmware'}">Start update (${readySel.length})</button>
    </div>
    <div class="tablewrap"><table class="fw-table">
      <thead><tr><th class="w-chk"></th><th>Scherm</th><th>Versie</th><th>Status</th><th>Controle vóór de update</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty">Geen schermen van deze serie</td></tr>'}</tbody>
    </table></div>
    ${selDevs.length && selDevs.length !== readySel.length ? `<p class="muted small">${selDevs.length - readySel.length} geselecteerd scherm(en) zijn niet (gecontroleerd) klaar; die worden niet meegenomen.</p>` : ''}`;
}

async function fwPreflight(ids) {
  fwChecking = true; renderFwPanel();
  try {
    await api('/api/firmware/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceIds: ids }) });
    await loadDevices();
  } catch (e) { alert(`Controle mislukt: ${e.message}`); }
  fwChecking = false; renderFwPanel();
}

function openFwDialog() {
  const v = fwData.series[fwSeriesSel];
  const devs = devices.filter((d) => fwSel.has(d.id) && d.preflight && d.preflight.ready);
  if (!devs.length) return;
  const from = {};
  for (const d of devs) { const c = d.fwVersion || d.firmware || '?'; from[c] = (from[c] || 0) + 1; }
  const updateMin = 8; // installeren + herstart (schatting)
  const uploadMin = Math.ceil((v.ready.size / 1048576) / 4 / 60); // ~4 MB/s via LAN
  const est = (n) => Math.ceil((devs.length / n) * (uploadMin + updateMin));
  const draw = () => {
    const n = Number($('#fwConc').value);
    $('#fwDlgBody').innerHTML = `
      <table class="kv">
        <tr><th>Serie</th><td>${esc(fwSeriesSel)}</td></tr>
        <tr><th>Schermen</th><td>${devs.length}: ${esc(devs.map((d) => d.ip).join(', '))}</td></tr>
        <tr><th>Versie</th><td>${Object.entries(from).map(([k, c]) => `${esc(k)} (${c}×)`).join(', ')} → <strong>${esc(v.ready.version)}</strong></td></tr>
        <tr><th>Duur (schatting)</th><td>ongeveer ${est(n)} minuten (${uploadMin} min upload + ~${updateMin} min installeren per scherm, ${n} tegelijk)</td></tr>
      </table>
      <p class="note warn">Schermen herstarten tijdens de update en tonen dan geen content. Haal de stroom er niet af. Doe dit bij voorkeur buiten openingstijd.</p>`;
  };
  $('#fwConc').onchange = draw;
  $('#fwConfirmTxt').value = '';
  $('#fwDlgStart').disabled = true;
  draw();
  $('#fwDlg').showModal();
}

async function startFwUpdate() {
  const devs = devices.filter((d) => fwSel.has(d.id) && d.preflight && d.preflight.ready);
  try {
    const r = await api('/api/actions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'firmware', params: { confirm: 'UPGRADE', concurrency: Number($('#fwConc').value) }, deviceIds: devs.map((d) => d.id) }),
    });
    $('#fwDlg').close();
    fwSel.clear();
    await loadActions();
    renderFwPanel();
    if (r.action.skipped.length) alert(`${r.action.skipped.length} scherm(en) overgeslagen; zie Acties voor de reden.`);
  } catch (e) { alert(e.message); }
}

function initFirmwareUi() {
  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  $('#fwSeries').addEventListener('click', (e) => {
    const b = e.target.closest('[data-series]');
    if (!b) return;
    fwSeriesSel = b.dataset.series; fwSel.clear(); renderFwSection();
  });
  $('#fwPanel').addEventListener('change', (e) => {
    const id = e.target.dataset.fwsel;
    if (id) { e.target.checked ? fwSel.add(id) : fwSel.delete(id); renderFwPanel(); }
    if (e.target.id === 'fwSelAll') {
      const devs = devices.filter((d) => seriesOf(d.model) === fwSeriesSel);
      for (const d of devs) e.target.checked ? fwSel.add(d.id) : fwSel.delete(d.id);
      renderFwPanel();
    }
  });
  $('#fwPanel').addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.fetch) {
      if (!confirm(`Firmware voor serie ${t.dataset.fetch} ophalen via de PPDS-kennisbank? Dit kan ruim 1 GB zijn.`)) return;
      t.disabled = true;
      try { await post('/api/firmware/download', { series: t.dataset.fetch }); } catch (err) { alert(err.message); }
      loadFirmware();
    }
    if (t.id === 'fwCheck') fwPreflight([...fwSel]);
    if (t.id === 'fwSelReady') {
      fwSel.clear();
      for (const d of devices.filter((x) => seriesOf(x.model) === fwSeriesSel)) if (d.preflight && d.preflight.ready) fwSel.add(d.id);
      renderFwPanel();
    }
    if (t.id === 'fwMode4') {
      if (!confirm(`Power save op Mode 4 zetten voor ${fwSel.size} scherm(en)? (PPDS-voorschrift voor firmware-updates)`)) return;
      try {
        await post('/api/actions', { type: 'powerSave', params: { mode: '4' }, deviceIds: [...fwSel] });
        await loadActions();
        alert('Mode 4 wordt ingesteld (zie Acties). Controleer de schermen daarna opnieuw.');
      } catch (err) { alert(err.message); }
    }
    if (t.id === 'fwStart') openFwDialog();
  });
  $('#fwConfirmTxt').addEventListener('input', (e) => { $('#fwDlgStart').disabled = e.target.value.trim() !== 'UPGRADE'; });
  $('#fwDlgStart').onclick = startFwUpdate;
  $('#fwDlgClose').onclick = () => $('#fwDlg').close();
  $('#fwReload').onclick = async () => { await post('/api/firmware/reload').catch((err) => alert(err.message)); await loadFirmware(); loadDevices(); };
  const tick = async () => { const busy = await loadFirmware(); setTimeout(tick, busy ? 1500 : 10000); };
  tick();
}

// ---------- schermen ----------

function filtered() {
  const q = $('#search').value.toLowerCase();
  const g = $('#fGroup').value;
  const p = $('#fPower').value;
  const sup = $('#fSupported').checked;
  return devices.filter((d) =>
    (!q || [d.name, d.ip, d.model, d.serial].join(' ').toLowerCase().includes(q))
    && (!g || d.group === g) && (!p || d.power === p) && (!sup || d.supported));
}

function renderDevices() {
  const rows = filtered().map((d) => {
    const ps = info.profile.powerSaveModes[d.powerSaveMode];
    const sameAsIp = d.name === d.ip;
    return `<tr class="${d.supported ? '' : 'unsupported'} ${selected.has(d.id) ? 'sel' : ''}" title="${esc(d.reason)}">
      <td><input type="checkbox" data-id="${esc(d.id)}" ${selected.has(d.id) ? 'checked' : ''} ${d.supported ? '' : 'disabled'} aria-label="Selecteer ${esc(d.name)}"></td>
      <td><div class="dev-name">${esc(sameAsIp ? shortModel(d.model) : d.name)}</div>
          <div class="dev-sub">${esc(sameAsIp ? d.ip : `${shortModel(d.model)} · ${d.ip}`)}</div>
          ${d.identityMismatch ? `<div class="dev-sub" style="color:var(--bad);font-weight:600" title="${esc(d.reason)}">⚠ ander apparaat op dit IP: ${esc(shortModel(d.identityMismatch.model) || '?')}</div>` : ''}</td>
      <td>${esc(d.group)}</td>
      <td><span class="pill p-${esc(d.power)}" title="${esc(info.profile.powerStates[d.power] || 'Status nog niet uitgelezen')}">${esc(POWER_LABEL[d.power] || d.power)}</span>
        ${d.coldStart ? `<div class="dev-sub" title="${esc(info.profile.coldStartInfo[d.coldStart] || '')}">na stroomuitval: ${esc(d.coldStart)}</div>` : ''}</td>
      <td title="${esc(ps?.description || 'De power-save-modus (Mode 1–4) is nog niet uit te lezen: het SICP-commando daarvoor is nog niet bekend.')}">${ps ? `Mode ${esc(d.powerSaveMode)} <span class="muted small">· ${esc(ps.short)}</span>` : '<span class="muted small">Mode ?</span>'}
        ${d.smartPower ? `<div class="dev-sub" title="${esc(info.profile.smartPower[d.smartPower] || '')}">SmartPower ${esc(d.smartPower)}</div>` : ''}</td>
      <td>${d.currentSource ? esc(sourceLabel(d.currentSource)) : '<span class="muted small">–</span>'}
        <div class="dev-sub" title="Bron waarop het scherm opstart">opstart: ${d.bootSource ? esc(sourceLabel(d.bootSource)) : '?'}</div>
        <div class="dev-sub" title="${esc(scheduleText(d.schedule) || 'Schema nog niet uitgelezen: gebruik Uitlezen')}">schema: ${scheduleSummary(d.schedule)}</div></td>
      <td class="muted"><div title="Android-firmware">${esc(d.fwVersion || d.firmware || '–')}</div>
        <div class="dev-sub">${d.fwScaler ? `scaler ${esc(d.fwScaler)}` : ''}${fwUpdateLabel(d)}</div></td>
      <td><button class="icon" data-shot="${esc(d.id)}">Screenshot</button></td>
    </tr>`;
  });
  $('#devices tbody').innerHTML = rows.join('') || '<tr><td colspan="8" class="empty">Geen schermen gevonden</td></tr>';
  updateSelection();
}

function updateSelection() {
  $('#selCount').textContent = `${selected.size} geselecteerd`;
  $('#run').textContent = selected.size ? `Uitvoeren op ${selected.size} scherm${selected.size === 1 ? '' : 'en'}` : 'Selecteer schermen';
  $('#run').disabled = !selected.size;
}

async function loadDevices() {
  devices = await api('/api/devices');
  const groups = [...new Set(devices.map((d) => d.group))].sort();
  const cur = $('#fGroup').value;
  $('#fGroup').innerHTML = '<option value="">Alle groepen</option>' + groups.map((g) => `<option ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('');
  $('#synced').textContent = `Bijgewerkt ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
  renderDevices();
  renderKpis();
  if (fwSeriesSel) renderFwSection(); // versies en controles in het firmwareoverzicht bijwerken
}

// ---------- bulkacties ----------

function buildForms() {
  const p = info.profile;
  $('#fPower').innerHTML = '<option value="">Alle statussen</option>'
    + Object.keys(p.powerStates).map((k) => `<option value="${k}">${POWER_LABEL[k]}</option>`).join('');

  $('#psModes').innerHTML = Object.entries(p.powerSaveModes).map(([k, m]) => `
    <label class="rc" title="${esc(m.description)}">
      <input type="radio" name="psMode" value="${k}" ${k === '3' ? 'checked' : ''}>
      <span class="rc-title">Mode ${k} · ${esc(m.short)}</span>
      <span class="muted small">${esc(m.description)}</span>
      <span class="tag ${m.reachableInStandby ? 'yes' : 'no'}">${m.reachableInStandby ? '✓ Bereikbaar in standby' : '✕ Niet bereikbaar in standby'}</span>
    </label>`).join('');
  $('#smartPower').innerHTML = '<option value="">Niet wijzigen</option>'
    + Object.keys(p.smartPower).map((k) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join('');
  // "Laatste bron" alleen als opstartbron; in het schema en bij direct wisselen een echte bron.
  $('#bootSource').innerHTML = p.sources.map((s) => `<option value="${s.id}" ${s.id === 'custom_app' ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  const sourceOpts = p.sources.filter((s) => s.id !== 'last').map((s) => `<option value="${s.id}" ${s.id === 'custom_app' ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  $('#addSched').onclick = () => addSchedRow(sourceOpts);
  addSchedRow(sourceOpts, { days: [0, 1, 2, 3, 4], on: '07:00', off: '19:00' });

  const updatePs = () => {
    const m = $('input[name=psMode]:checked')?.value;
    $('#psWarn').classList.toggle('hidden', p.powerSaveModes[m]?.reachableInStandby !== false);
    $('#smartPowerInfo').textContent = p.smartPower[$('#smartPower').value] || '';
  };
  $('#psModes').onchange = updatePs;
  $('#smartPower').onchange = updatePs;
  updatePs();
}

function addSchedRow(sourceOpts, preset = {}) {
  const row = document.createElement('div');
  row.className = 'schedrow';
  row.innerHTML = `
    <div class="line days">${DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" ${preset.days?.includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>
    <div class="line">
      <input type="time" class="on" value="${preset.on || '08:00'}" aria-label="Tijd aan"> <span class="muted">tot</span>
      <input type="time" class="off" value="${preset.off || '18:00'}" aria-label="Tijd uit">
    </div>
    <div class="line"><select class="src" aria-label="Opstartbron">${sourceOpts}</select><button class="ghost del" title="Regel verwijderen">✕</button></div>`;
  $('.del', row).onclick = () => row.remove();
  $('#schedRows').append(row);
}

function collectParams() {
  switch (tab) {
    case 'power': return { state: $('input[name=pw]:checked').value };
    case 'powerSave': {
      const params = { mode: $('input[name=psMode]:checked').value };
      if ($('#smartPower').value) params.smartPower = $('#smartPower').value;
      return params;
    }
    case 'bootSource': return { source: $('#bootSource').value };
    case 'schedule': return {
      entries: $$('.schedrow').map((r) => ({
        days: $$('.days input:checked', r).map((c) => Number(c.value)),
        on: $('.on', r).value, off: $('.off', r).value, source: $('.src', r).value,
      })),
    };
    default: return {};
  }
}

function confirmText(params) {
  let what = TYPE_LABEL[tab];
  if (tab === 'power') what = params.state === 'on' ? 'Aanzetten' : 'Uitzetten (standby)';
  if (tab === 'powerSave') {
    const m = info.profile.powerSaveModes[params.mode];
    what = `Power save → Mode ${params.mode}\n${m.description}`;
    if (!m.reachableInStandby) what += '\n\nLET OP: deze schermen zijn daarna in standby niet bereikbaar.';
  }
  if (tab === 'bootSource') {
    what = actionType() === 'source'
      ? `Bron NU wisselen → ${sourceLabel(params.source)}\n(het beeld op de schermen verandert direct)`
      : `Opstartbron → ${sourceLabel(params.source)}\n(geldt pas bij de volgende keer aanzetten)`;
  }
  if (tab === 'schedule') what = `Powerschema vervangen (${params.entries.length} regel(s))`;
  return `${what}\n\nUitvoeren op ${selected.size} scherm(en)?`;
}

// Het tabblad Bron dekt twee acties: direct wisselen of de opstartbron.
function actionType() {
  if (tab !== 'bootSource') return tab;
  return $('input[name=srcMode]:checked').value === 'now' ? 'source' : 'bootSource';
}

async function run() {
  const params = collectParams();
  if (actionType() === 'source' && params.source === 'last') { $('#runMsg').textContent = '"Laatste bron" kan alleen als opstartbron.'; return; }
  if (tab !== 'refresh' && !confirm(confirmText(params))) return;
  $('#run').disabled = true;
  try {
    const r = await api('/api/actions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: actionType(), params, deviceIds: [...selected] }),
    });
    const skip = r.action.skipped.length ? ` · ${r.action.skipped.length} overgeslagen` : '';
    $('#runMsg').textContent = `Gestart op ${r.action.targets.length} scherm(en)${skip}.`;
    loadActions();
  } catch (e) {
    $('#runMsg').textContent = `Fout: ${e.message}`;
  } finally {
    updateSelection();
  }
}

// ---------- acties ----------

function paramsText(a) {
  const p = a.params || {};
  if (a.type === 'power') return p.state === 'on' ? 'aanzetten' : 'uitzetten';
  if (a.type === 'powerSave') return `Mode ${p.mode}${p.smartPower ? `, SmartPower ${p.smartPower}` : ''}`;
  if (a.type === 'bootSource' || a.type === 'source') return sourceLabel(p.source);
  if (a.type === 'schedule') return (p.entries || []).map((e) => `${e.days.map((d) => DAYS[d]).join('/')} ${e.on}–${e.off} ${sourceLabel(e.source)}`).join('; ');
  return '';
}

// ---------- foutterugkoppeling ----------

const PHASES = [['voorcontrole', 'Voorcontrole'], ['upload', 'Upload'], ['starten', 'Upgrade starten'], ['herstart', 'Herstart + controle'], ['klaar', 'Klaar']];
const errInfo = (code) => (info.errors && info.errors[code]) || (code ? { title: code, cause: '', fix: '' } : null);

// Fasebalk voor een firmware-upgrade: waar staat of stopte dit scherm?
function phaseBar(t) {
  if (!t.phase) return '';
  const idx = PHASES.findIndex(([k]) => k === t.phase);
  const failed = ['mislukt', 'geen_reactie'].includes(t.status);
  return `<div class="phases">${PHASES.map(([k, l], i) => {
    let cls = i < idx ? 'done' : i === idx ? (failed ? 'fail' : t.status === 'bevestigd' ? 'done' : 'now') : '';
    if (k === 'klaar' && t.status === 'bevestigd') cls = 'done';
    return `<span class="ph ${cls}">${esc(l)}</span>`;
  }).join('<span class="ph-sep">›</span>')}</div>`;
}

// Fouten en overgeslagen schermen gegroepeerd per probleem, met wat je eraan doet.
function problemsBlock(a) {
  const groups = {};
  for (const t of a.targets) {
    if (!['mislukt', 'geen_reactie', 'niet_getest'].includes(t.status)) continue;
    const code = t.code || 'UNKNOWN';
    (groups[code] = groups[code] || []).push(t.name);
  }
  for (const s of a.skipped || []) {
    const code = s.code || 'UNKNOWN';
    (groups[code] = groups[code] || []).push(`${s.name || s.deviceId} (overgeslagen)`);
  }
  const entries = Object.entries(groups).sort((x, y) => y[1].length - x[1].length);
  if (!entries.length) return '';
  return `<div class="problems">${entries.map(([code, names]) => {
    const e = errInfo(code);
    return `<div class="problem">
      <div class="problem-head"><strong>${names.length}× ${esc(e.title)}</strong> <span class="muted small">${esc(code)}</span></div>
      ${e.cause ? `<div class="small">${esc(e.cause)}</div>` : ''}
      ${e.fix ? `<div class="small fix"><strong>Wat te doen:</strong> ${esc(e.fix)}</div>` : ''}
      <div class="small muted">Schermen: ${esc(names.join(', '))}</div>
    </div>`;
  }).join('')}</div>`;
}

function showTarget(actionId, deviceId) {
  const a = actions.find((x) => x.id === actionId);
  const t = a && a.targets.find((x) => x.deviceId === deviceId);
  if (!t) return;
  const d = devices.find((x) => x.id === deviceId) || {};
  const e = t.code ? errInfo(t.code) : null;
  const ok = t.status === 'bevestigd';
  $('#detailTitle').textContent = `${t.name} · ${TYPE_LABEL[a.type]}`;
  $('#detailBody').innerHTML = `
    <p><span class="st st-${esc(t.status)}">${esc(STATUS_LABEL[t.status] || t.status)}</span> ${d.model ? `<span class="muted">${esc(shortModel(d.model))} · ${esc(d.ip)}</span>` : ''}</p>
    ${phaseBar(t)}
    ${e && !ok ? `<div class="problem"><div class="problem-head"><strong>${esc(e.title)}</strong> <span class="muted small">${esc(t.code)}</span></div>
      ${e.cause ? `<div class="small">${esc(e.cause)}</div>` : ''}
      ${e.fix ? `<div class="small fix"><strong>Wat te doen:</strong> ${esc(e.fix)}</div>` : ''}</div>` : ''}
    <table class="kv">
      <tr><th>Melding</th><td>${esc(t.detail || '–')}</td></tr>
      ${t.phase ? `<tr><th>Fase</th><td>${esc((PHASES.find(([k]) => k === t.phase) || [, t.phase])[1])}</td></tr>` : ''}
      <tr><th>Verstuurd</th><td>${t.sentAt ? new Date(t.sentAt).toLocaleString('nl-NL') : '–'}</td></tr>
      <tr><th>Klaar</th><td>${t.doneAt ? new Date(t.doneAt).toLocaleString('nl-NL') : 'bezig…'}</td></tr>
    </table>`;
  $('#detail').showModal();
}

async function loadActions() {
  actions = await api('/api/actions');
  $('#actions').innerHTML = actions.map((a) => {
    const counts = {};
    for (const t of a.targets) counts[t.status] = (counts[t.status] || 0) + 1;
    if ((a.skipped || []).length) counts.overgeslagen = a.skipped.length;
    const running = a.targets.filter((t) => t.phase && !t.doneAt);
    return `<div class="action">
      <div class="action-head">
        <div><span class="action-title">${esc(TYPE_LABEL[a.type])}</span> <span class="muted">· ${esc(paramsText(a))}</span></div>
        <div class="counts">${Object.entries(counts).map(([s, n]) => `<span class="st st-${s}">${n} ${STATUS_LABEL[s] || s}</span>`).join('')}
          <a class="icon" href="/api/actions/${encodeURIComponent(a.id)}/csv" title="Resultaat per scherm als CSV (Excel)">CSV</a></div>
      </div>
      ${running.map((t) => `<div class="running"><strong>${esc(t.name)}</strong> <span class="muted small">${esc(t.detail || '')}</span>${phaseBar(t)}</div>`).join('')}
      ${problemsBlock(a)}
      <div class="targets">${a.targets.map((t) => `<button class="st st-${esc(t.status)} chip-btn" data-action="${esc(a.id)}" data-dev="${esc(t.deviceId)}" title="Klik voor details">${esc(t.name)}${t.code && t.status !== 'bevestigd' ? ' ⓘ' : ''}</button>`).join('')}</div>
      <div class="muted small">${new Date(a.createdAt).toLocaleString('nl-NL')} · ${esc(a.user)}${a.finishedAt ? '' : ' · bezig…'}</div>
    </div>`;
  }).join('') || '<p class="muted">Nog geen acties uitgevoerd.</p>';
  renderKpis();
  if (actions.some((a) => !a.finishedAt)) loadDevices();
  // Voortgang van een lopende firmware-update live bijwerken in het overzicht.
  if (fwSeriesSel && actions.some((a) => a.type === 'firmware' && !a.finishedAt)) renderFwPanel();
}

// ---------- screenshot ----------

async function showShot(id) {
  const d = devices.find((x) => x.id === id);
  $('#shotTitle').textContent = `${d.name} · ${shortModel(d.model)} · ${d.ip}`;
  $('#shotBody').innerHTML = '<p class="muted">Laden…</p>';
  $('#shot').showModal();
  const r = await fetch(`/api/devices/${encodeURIComponent(id)}/screenshot?t=${Date.now()}`);
  if (r.ok) {
    const url = URL.createObjectURL(await r.blob());
    $('#shotBody').innerHTML = `<img alt="Screenshot van ${esc(d.name)}" src="${url}">`;
  } else {
    const b = await r.json().catch(() => ({}));
    $('#shotBody').innerHTML = `<p class="note warn">${esc(b.error || 'Geen screenshot beschikbaar')}</p>`;
  }
  $('#shotBody').insertAdjacentHTML('beforeend', `
    <div class="actions-row" style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="ghost" id="shotTake">Screenshot laten maken (SICP)</button>
      <span class="muted small" id="shotMsg">Het scherm maakt de screenshot en mailt hem naar het adres dat op het scherm is ingesteld (Instellingen → Signage Display → Server Settings → Email Notification).</span>
    </div>`);
  $('#shotTake').onclick = async () => {
    $('#shotTake').disabled = true;
    try {
      await api('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'screenshot', params: {}, deviceIds: [id] }) });
      $('#shotMsg').textContent = 'Verstuurd; zie de status onder Acties.';
      loadActions();
    } catch (e) { $('#shotMsg').textContent = `Fout: ${e.message}`; }
  };
}

// ---------- init ----------

async function init() {
  info = await api('/api/info');
  $('#mode').textContent = { demo: 'Demo', control: 'Live · CMND & Control' }[info.mode] || 'Live';
  $('#mode').classList.toggle('live', info.mode !== 'demo');
  $('#minAndroid').textContent = info.minAndroid;
  renderAlerts();
  buildForms();

  ['#search', '#fGroup', '#fPower', '#fSupported'].forEach((s) => $(s).addEventListener('input', renderDevices));
  $('#devices').addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    e.target.checked ? selected.add(id) : selected.delete(id);
    e.target.closest('tr').classList.toggle('sel', e.target.checked);
    updateSelection();
  });
  $('#selAll').onchange = (e) => {
    for (const d of filtered()) if (d.supported) e.target.checked ? selected.add(d.id) : selected.delete(d.id);
    renderDevices();
  };
  $('#devices').addEventListener('click', (e) => { if (e.target.dataset.shot) showShot(e.target.dataset.shot); });
  $('#shotClose').onclick = () => $('#shot').close();
  $('#detailClose').onclick = () => $('#detail').close();
  $('#actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b) showTarget(b.dataset.action, b.dataset.dev);
  });
  $$('.segmented button').forEach((b) => b.onclick = async () => {
    if (b.dataset.goto) { document.getElementById(b.dataset.goto).scrollIntoView({ behavior: 'smooth' }); return; }
    tab = b.dataset.tab;
    updateSelection();
    $$('.segmented button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  });
  $('#run').onclick = run;

  await loadDevices();
  await loadActions();
  initFirmwareUi();
  setInterval(loadActions, 2000);
  setInterval(loadDevices, 15000);
}

init().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<p class="note bad">${esc(e.message)}</p>`); });
