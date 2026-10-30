// Leest het PPDS-supportoverzicht (One_Link.xlsm) zonder Excel of macro's:
// per model de nieuwste firmware (blad "Models", kolom H) en de downloadlink.
// Een .xlsm is een zip; hier een minimale zip-lezer met zlib.

const fs = require('fs');
const zlib = require('zlib');

function readZip(file) {
  const b = fs.readFileSync(file);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Geen geldig xlsm/zip-bestand');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28);
    const xlen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    files[name] = () => {
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const raw = b.subarray(start, start + csize);
      return (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    };
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Geeft per serie (bv. "4650D") { version, androidFw, url, models[] } terug.
function parseFirmware(file) {
  const z = readZip(file);
  const ss = [...z['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const wb = z['xl/workbook.xml']();
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1]);
  const idx = names.findIndex((n) => /^models$/i.test(n.trim()));
  if (idx < 0) throw new Error('Blad "Models" niet gevonden in One_Link');
  const sheet = z[`xl/worksheets/sheet${idx + 1}.xml`]();
  const relsFile = z[`xl/worksheets/_rels/sheet${idx + 1}.xml.rels`];
  const rels = relsFile ? Object.fromEntries([...relsFile().matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], decode(m[2])])) : {};
  const links = {};
  for (const m of sheet.matchAll(/<hyperlink ref="([A-Z]+)(\d+)"[^>]*r:id="([^"]+)"/g)) links[`${m[1]}${m[2]}`] = rels[m[3]];

  const cell = (row, col) => {
    const m = row.match(new RegExp(`<c r="${col}\\d+"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`));
    if (!m) return '';
    const v = (m[2] || '').match(/<v>([\s\S]*?)<\/v>/) || (m[2] || '').match(/<t[^>]*>([\s\S]*?)<\/t>/);
    if (!v) return '';
    return /t="s"/.test(m[1]) ? ss[Number(v[1])] : decode(v[1]);
  };

  const series = {};
  for (const r of sheet.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const model = cell(r[2], 'C').trim();
    const s = (model.match(/BDL(\d{4}[A-Z])/i) || [])[1];
    const url = links[`H${r[1]}`];
    if (!s || !url || !/update\.zip/i.test(url)) continue;
    const text = cell(r[2], 'H');
    const version = (text.match(/V\s*(\d+\.\d+)/i) || [])[1] || null; // notatie zoals SICP 0xA1 hem meldt
    const androidFw = (text.match(/FB\d+\.\d+/i) || [])[0] || null;
    const key = s.toUpperCase();
    if (!series[key]) series[key] = { version, androidFw, url: url.replace(/([?&])dl=0/, '$1dl=1'), models: [] };
    series[key].models.push(model);
  }
  return series;
}

// Leest één klein bestand uit een (mogelijk zeer groot) zip-bestand zonder het
// hele bestand in het geheugen te laden. Geeft null als het bestand ontbreekt.
function readZipEntry(file, wanted) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 70000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = tailLen - 22;
    while (e >= 0 && tail.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) return null;
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
      // ZIP64: locator staat vlak voor de EOCD.
      const loc = e - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) return null;
      const z64 = Buffer.alloc(56);
      fs.readSync(fd, z64, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOff = Number(z64.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      let local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nlen);
      if (name === wanted) {
        // ZIP64-extra-veld voor grote offsets
        const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
        for (let x = 0; x + 4 <= extra.length;) {
          const id = extra.readUInt16LE(x); const len = extra.readUInt16LE(x + 2);
          if (id === 0x0001) {
            let q = x + 4;
            if (cd.readUInt32LE(p + 24) === 0xffffffff) q += 8;
            if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(q)); q += 8; }
            if (local === 0xffffffff) local = Number(extra.readBigUInt64LE(q));
          }
          x += 4 + len;
        }
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, local);
        const start = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        if (csize > 1e6) return null;
        const raw = Buffer.alloc(csize);
        fs.readSync(fd, raw, 0, csize, start);
        return (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
      }
      p += 46 + nlen + xlen + clen;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Android-OTA-metadata (o.a. pre-device / post-build) uit update.zip, voor controle per model.
function otaInfo(file) {
  const meta = readZipEntry(file, 'META-INF/com/android/metadata');
  if (!meta) return null;
  const kv = Object.fromEntries(meta.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { device: kv['pre-device'] || null, build: kv['post-build'] || null };
}

module.exports = { parseFirmware, readZipEntry, otaInfo };
