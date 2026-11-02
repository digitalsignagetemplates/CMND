// Leest per serie de PPDS-kennisbank (https://www.ppds.com/support/kb/signage).
// De kennisbank is een openbaar gedeelde Confluence-omgeving; de modelpagina's laden
// hun inhoud als Atlassian-documentformaat (JSON) via een GraphQL-query. Die query
// gebruikt de tool ook, met het pagina-ID uit kb-catalog.json.

const DEFAULTS = {
  endpoint: 'https://ppds.atlassian.net/gateway/api/graphql/pq/',
  // Hash van de query die de pagina zelf gebruikt (ContentRendererExternalQuery).
  // Wijzigt Atlassian die, dan hier bijwerken (te vinden in het netwerkverkeer van de pagina).
  hash: '19a2cf3f1071fa87f2247c1bd2cea6e61fa75346876ceb3ad87e1ca8779b8e5d',
};

const text = (node) => {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  return (node.content || []).map(text).join(node.type === 'paragraph' ? '\n' : '');
};

// Alle tekstfragmenten met een link (tekst + href) binnen een node.
function links(node, out = []) {
  if (!node) return out;
  if (node.type === 'text') {
    const l = (node.marks || []).find((m) => m.type === 'link');
    if (l) out.push({ text: (node.text || '').trim(), href: l.attrs.href });
  }
  for (const c of node.content || []) links(c, out);
  return out;
}

function rows(node, out = []) {
  if (!node) return out;
  if (node.type === 'tableRow') {
    const [head, ...cells] = node.content || [];
    out.push({ label: text(head).replace(/\s+/g, ' ').trim(), cells, text: cells.map(text).join(' ').replace(/\s+/g, ' ').trim() });
  }
  for (const c of node.content || []) rows(c, out);
  return out;
}

const direct = (href) => /\.(zip|bin)(\?|$)/i.test(new URL(href).pathname) || /dl=1/.test(href);
const toDownload = (href) => href.replace(/([?&])dl=0/, '$1dl=1');

// Haalt uit een PDF van PPDS de eerste link naar update.zip (link-annotaties staan als
// "/URI (…)" leesbaar in het PDF-bestand).
async function zipLinkFromPdf(href) {
  const r = await fetch(toDownload(href));
  if (!r.ok) return null;
  const s = Buffer.from(await r.arrayBuffer()).toString('latin1');
  const m = [...s.matchAll(/\/URI\s*\(([^)]+)\)/g)].map((x) => x[1]).find((u) => /update\.zip/i.test(u));
  return m || null;
}

// Haalt een modelpagina op en geeft de firmware-informatie terug. `page` is de gedeelde
// paginalink; die gaat mee als Referer, net als bij een browser (anders geen inhoud).
async function fetchSeries(contentId, page, cfg = {}) {
  const o = { ...DEFAULTS, ...(cfg.ppdsKb || {}) };
  const body = {
    operationName: 'ContentRendererExternalQuery',
    variables: { contentId: String(contentId) },
    extensions: { persistedQuery: { version: 1, sha256Hash: o.hash } },
  };
  const r = await fetch(`${o.endpoint}${o.hash}?operation=ContentRendererExternalQuery`, {
    method: 'POST', headers: { 'content-type': 'application/json', Referer: page }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PPDS-kennisbank gaf HTTP ${r.status}`);
  const j = await r.json();
  const adf = j && j.data && j.data.singleContent && j.data.singleContent.body && j.data.singleContent.body.atlas_doc_format;
  if (!adf) throw new Error('PPDS-kennisbank gaf geen pagina-inhoud (mogelijk is de query gewijzigd)');
  const doc = JSON.parse(adf.value);
  const all = rows(doc);
  const row = (re) => all.find((x) => re.test(x.label));

  const fwRow = row(/^Latest FW Release(?! \+)/i);
  const items = fwRow ? links({ content: fwRow.cells }) : [];
  const android = items.find((i) => /^FB\d+\.\d+/i.test(i.text));
  const scaler = items.find((i) => /^v\d+\.\d+/i.test(i.text));
  const others = items.filter((i) => i !== android && i !== scaler);
  const notes = row(/^Release Notes/i);
  const sop = row(/^FW Update Instructions/i);

  // Alleen een los update.zip is via de tool te installeren (SICP 0x20); een combinatiepakket
  // (combofw.zip) is handmatig werk. Verwijst PPDS naar een PDF (bv. 3550Q "Latest FW.pdf"),
  // dan staat de update.zip-link als link in die PDF.
  let viaPdf = null;
  if (android && /\.pdf(\?|$)/i.test(new URL(android.href).pathname)) {
    viaPdf = android.href;
    const zip = await zipLinkFromPdf(android.href).catch(() => null);
    if (zip) android.href = zip;
  }
  const file = android ? decodeURIComponent(new URL(android.href).pathname.split('/').pop()) : '';
  return {
    platform: (row(/^Platform$/i) || {}).text || null,
    sicp: (row(/^SICP Version/i) || {}).text || null,
    android: android ? {
      version: (android.text.match(/FB\d+\.\d+/i) || [android.text])[0].toUpperCase(),
      label: android.text,
      file,
      href: android.href,
      direct: direct(android.href),
      installable: /^update\.zip$/i.test(file) && direct(android.href),
      url: toDownload(android.href),
      viaPdf,
    } : null,
    scaler: scaler ? { version: scaler.text.replace(/^v/i, ''), href: scaler.href } : null,
    others: others.map((i) => ({ name: i.text, href: i.href })),
    releaseNotes: notes ? (links({ content: notes.cells })[0] || {}).href || null : null,
    instructions: sop ? (links({ content: sop.cells })[0] || {}).href || null : null,
  };
}

module.exports = { fetchSeries };
