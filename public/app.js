const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DAYS = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
const POWER_LABEL = { aan: 'Aan', backlight_uit: 'Backlight uit', slaapt: 'Slaapt', uit: 'Uit', onbekend: 'Onbekend' };
const STATUS_LABEL = { wachtrij: 'wachtrij', verstuurd: 'verstuurd', bevestigd: 'bevestigd', mislukt: 'mislukt', geen_reactie: 'geen reactie', niet_getest: 'niet verstuurd (niet getest)' };
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

// Nieuwste versie volgens One_Link vergelijken met wat het scherm meldt:
// SICP-notatie (1.028) met fwVersion, Android-notatie (FB01.19) met de firmware uit Control.
function fwUpdateLabel(d) {
  if (!d.fwLatest) return '';
  const sicpStyle = /^\d+\.\d+/.test(d.fwLatest);
  const current = sicpStyle ? d.fwVersion : d.firmware;
  if (!current || current === d.fwLatest) return '';
  return ` · <strong>nieuwste ${esc(d.fwLatest)}</strong>`;
}

const mb = (n) => `${Math.round(n / 1048576)} MB`;

async function renderFirmware() {
  const fw = await api('/api/firmware').catch((e) => ({ series: {}, onelinkError: e.message }));
  const cards = Object.entries(fw.series)
    .sort((a, b) => b[1].inUse - a[1].inUse)
    .map(([s, v]) => {
      const l = v.latest;
      const dl = v.download;
      const lines = [];
      lines.push(`<div class="row"><strong>${esc(s)}</strong><span class="muted">${v.inUse} scherm${v.inUse === 1 ? '' : 'en'}</span></div>`);
      if (!l) lines.push('<span class="muted">Niet gevonden in One_Link</span>');
      else {
        lines.push(`<span>Nieuwste: <strong>${esc(l.version || l.androidFw || '?')}</strong>${l.version && l.androidFw ? ` <span class="muted">(${esc(l.androidFw)})</span>` : ''}</span>`);
        if (!v.upgradable) lines.push('<span class="warn-text">Geen versie bekend in One_Link: handmatig bijwerken (USB/CMND).</span>');
        else if (!l.version) lines.push('<span class="muted">Alleen Android-versie bekend; werkt alleen op schermen die hun versie via SICP melden (de tool controleert dit vooraf).</span>');
        if (l.sharedWith && l.sharedWith.length) lines.push(`<span class="warn-text">Let op: dezelfde downloadlink staat in One_Link ook bij ${esc(l.sharedWith.join(', '))}. Controleer of dit de juiste firmware is.</span>`);
      }
      if (v.ready) {
        lines.push(`<span class="ok-text">Klaargezet: ${esc(v.ready.version)} (${mb(v.ready.size)})</span>`);
        if (v.ready.mismatch) lines.push(`<span class="bad-text"><strong>Niet bevestigd:</strong> het bestand is volgens zichzelf voor "${esc(v.ready.mismatch)}", niet herkenbaar als ${esc(s)}. Upgrade is geblokkeerd. Laat PPDS bevestigen dat dit de juiste firmware is (dan: otaAliases in config.json) of vraag de juiste firmware op.</span>`);
        else if (v.ready.ota && (v.ready.ota.device || v.ready.ota.build)) lines.push(`<span class="muted">Volgens het bestand bedoeld voor: ${esc(v.ready.ota.device || '?')}${v.ready.ota.build ? ` · ${esc(v.ready.ota.build)}` : ''}</span>`);
        else lines.push('<span class="warn-text">Het bestand zegt niet voor welk apparaat het is; controleer dit zelf.</span>');
      }
      if (dl && dl.state === 'bezig') {
        lines.push(`<progress max="${dl.total || 1}" value="${dl.received}"></progress><span class="muted">Downloaden… ${mb(dl.received)}${dl.total ? ` van ${mb(dl.total)}` : ''}</span>`);
      } else if (dl && dl.state === 'mislukt') lines.push(`<span class="bad-text">Download mislukt: ${esc(dl.error)}</span>`);
      if (l && v.upgradable && !(dl && dl.state === 'bezig')) {
        const want = String(l.version || l.androidFw || '').replace(/^FB/i, '');
        const label = v.ready && v.ready.version === want ? 'Opnieuw ophalen' : 'Ophalen';
        lines.push(`<div class="row"><span></span><button class="ghost" data-fetch="${esc(s)}">${label}</button></div>`);
      }
      return `<div class="fw-card">${lines.join('')}</div>`;
    });
  $('#fwInfo').innerHTML = (fw.onelinkError ? `<p class="note warn">${esc(fw.onelinkError)}</p>` : '') + (cards.join('') || '<p class="muted">Geen series gevonden.</p>');
  return Object.values(fw.series).some((v) => v.download && v.download.state === 'bezig');
}

let fwTimer = null;
async function refreshFirmware() {
  clearTimeout(fwTimer);
  const busy = await renderFirmware();
  if (tab === 'firmware') fwTimer = setTimeout(refreshFirmware, busy ? 1500 : 10000);
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
      <td class="muted"><div>${esc(d.fwVersion || '–')}</div>
        <div class="dev-sub">${esc(d.firmware || '')}${fwUpdateLabel(d)}</div></td>
      <td><button class="icon" data-shot="${esc(d.id)}">Screenshot</button></td>
    </tr>`;
  });
  $('#devices tbody').innerHTML = rows.join('') || '<tr><td colspan="8" class="empty">Geen schermen gevonden</td></tr>';
  updateSelection();
}

function updateSelection() {
  $('#selCount').textContent = `${selected.size} geselecteerd`;
  const verb = tab === 'firmware' ? 'FW update uitvoeren' : 'Uitvoeren';
  $('#run').textContent = selected.size ? `${verb} op ${selected.size} scherm${selected.size === 1 ? '' : 'en'}` : 'Selecteer schermen';
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
    case 'firmware': return { confirm: $('#fwConfirm').value.trim(), confirmShared: $('#fwShared').checked };
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
  if (tab === 'firmware') {
    const sel = devices.filter((d) => selected.has(d.id));
    what = 'FIRMWARE-UPGRADE\n' + sel.map((d) => `${d.name}: ${d.fwVersion || '?'} → ${d.fwAvailable || 'geen firmware in map'}`).join('\n')
      + '\n\nDe schermen herstarten en zijn 10–30 minuten niet beschikbaar.';
  }
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

async function loadActions() {
  actions = await api('/api/actions');
  $('#actions').innerHTML = actions.map((a) => {
    const counts = {};
    for (const t of a.targets) counts[t.status] = (counts[t.status] || 0) + 1;
    return `<div class="action">
      <div class="action-head">
        <div><span class="action-title">${esc(TYPE_LABEL[a.type])}</span> <span class="muted">· ${esc(paramsText(a))}</span></div>
        <div class="counts">${Object.entries(counts).map(([s, n]) => `<span class="st st-${s}">${n} ${STATUS_LABEL[s]}</span>`).join('')}</div>
      </div>
      <div class="targets">${a.targets.map((t) => `<span class="st st-${t.status}" title="${esc(STATUS_LABEL[t.status])}${t.detail ? ': ' + esc(t.detail) : ''}">${esc(t.name)}</span>`).join('')}</div>
      <div class="muted small">${new Date(a.createdAt).toLocaleString('nl-NL')} · ${esc(a.user)}${a.finishedAt ? '' : ' · bezig…'}</div>
    </div>`;
  }).join('') || '<p class="muted">Nog geen acties uitgevoerd.</p>';
  renderKpis();
  if (actions.some((a) => !a.finishedAt)) loadDevices();
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
  $$('.segmented button').forEach((b) => b.onclick = async () => {
    tab = b.dataset.tab;
    if (tab === 'firmware') refreshFirmware();
    updateSelection();
    $$('.segmented button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  });
  $('#run').onclick = run;
  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  $('#fwInfo').addEventListener('click', async (e) => {
    const s = e.target.dataset.fetch;
    if (!s) return;
    if (!confirm(`Firmware voor serie ${s} downloaden van de PPDS-link in One_Link? Dit kan enkele GB zijn.`)) return;
    e.target.disabled = true;
    try { await post('/api/firmware/download', { series: s }); } catch (err) { alert(err.message); }
    refreshFirmware();
  });
  $('#fwReload').onclick = async () => { await post('/api/firmware/reload').catch((err) => alert(err.message)); refreshFirmware(); loadDevices(); };

  await loadDevices();
  await loadActions();
  setInterval(loadActions, 2000);
  setInterval(loadDevices, 15000);
}

init().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<p class="note bad">${esc(e.message)}</p>`); });
