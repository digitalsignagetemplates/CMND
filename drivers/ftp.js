// Minimale FTP-client (passief, binair) om firmware naar het scherm te uploaden.
// Geen externe packages nodig.

const net = require('net');
const fs = require('fs');

function connect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = '';
    const waiters = [];
    const lines = [];
    let connected = false;
    sock.once('connect', () => { connected = true; });
    // Onderscheid: niet kunnen verbinden (server uit/onbereikbaar) vs. stilvallen tijdens een sessie.
    sock.setTimeout(timeoutMs, () => {
      sock.destroy(new Error(connected ? 'FTP time-out tijdens sessie' : `FTP-server niet bereikbaar op ${host}:${port} (time-out bij verbinden)`));
    });
    sock.on('error', (e) => { while (waiters.length) waiters.shift().reject(e); reject(e); });
    sock.on('close', () => { const e = new Error('FTP-verbinding gesloten'); while (waiters.length) waiters.shift().reject(e); });
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        // Meerregelig antwoord: "123-..." tot "123 ..."; alleen de laatste regel telt.
        if (/^\d{3} /.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: [...lines, line].join('\n') };
          lines.length = 0;
          // Antwoord bewaren als nog niemand wacht (bv. 226 vóór we erom vragen).
          if (waiters.length) waiters.shift().resolve(reply); else pending.push(reply);
        } else lines.push(line);
      }
    });
    const pending = [];
    const next = () => (pending.length ? Promise.resolve(pending.shift()) : new Promise((res, rej) => waiters.push({ resolve: res, reject: rej })));
    const cmd = (line) => { sock.write(`${line}\r\n`); return next(); };
    next().then((greet) => (greet.code === 220 ? resolve({ sock, cmd, next }) : reject(new Error(`FTP: ${greet.text}`))), reject);
  });
}

async function expect(p, ok, what) {
  const r = await p;
  if (!ok.includes(r.code)) throw new Error(`FTP ${what}: ${r.text}`);
  return r;
}

async function login(host, ftp, timeoutMs) {
  const c = await connect(host, ftp.port, timeoutMs);
  await expect(c.cmd(`USER ${ftp.user}`), [230, 331], 'USER');
  await expect(c.cmd(`PASS ${ftp.password}`), [230, 202], 'login');
  await expect(c.cmd('TYPE I'), [200], 'TYPE');
  return c;
}

async function passive(c, host, timeoutMs) {
  const r = await expect(c.cmd('PASV'), [227], 'PASV');
  const m = r.text.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
  if (!m) throw new Error(`FTP PASV onleesbaar: ${r.text}`);
  // Gebruik het IP van het scherm zelf; sommige servers melden een intern adres.
  const data = net.createConnection({ host, port: Number(m[5]) * 256 + Number(m[6]) });
  data.setTimeout(timeoutMs, () => data.destroy(new Error('FTP-data time-out')));
  await new Promise((res, rej) => { data.once('connect', res); data.once('error', rej); });
  return data;
}

// Test of inloggen lukt; wijzigt niets.
async function check(host, ftp, timeoutMs = 10000) {
  const c = await login(host, ftp, timeoutMs);
  const pwd = await c.cmd('PWD');
  c.cmd('QUIT').catch(() => {});
  c.sock.end();
  return pwd.text;
}

// Uploadt een bestand naar de hoofdmap van het scherm en controleert de grootte.
async function upload(host, ftp, localFile, remoteName, onProgress, timeoutMs = 60000) {
  const size = fs.statSync(localFile).size;
  const c = await login(host, ftp, timeoutMs);
  try {
    const data = await passive(c, host, timeoutMs);
    const started = c.cmd(`STOR ${remoteName}`);
    const first = await started;
    if (![125, 150].includes(first.code)) { data.destroy(); throw new Error(`FTP STOR: ${first.text}`); }
    // Tijdens de overdracht is het stuurkanaal stil; de idle-time-out geldt dan alleen voor het datakanaal.
    c.sock.setTimeout(0);
    const mb = (n) => `${Math.round(n / 1048576)} MB`;
    // Voortgang op basis van wat echt over het netwerk is verstuurd; bij een fout stopt het
    // lezen meteen, zodat de foutmelding niet door de voortgang wordt overschreven.
    let broken = null;
    await new Promise((res) => {
      const rs = fs.createReadStream(localFile);
      const stop = (why) => { if (!broken) { broken = why; rs.unpipe(data); rs.destroy(); data.destroy(); } res(); };
      rs.on('data', () => { if (!broken && onProgress) onProgress(data.bytesWritten, size); });
      rs.on('error', (e) => stop(`lokaal bestand: ${e.message}`));
      data.on('error', (e) => stop(`dataverbinding: ${e.code || e.message}`));
      data.on('close', () => { if (rs.readableEnded) res(); else stop('dataverbinding door het scherm gesloten'); });
      rs.pipe(data);
    });
    const written = data.bytesWritten;
    c.sock.setTimeout(timeoutMs, () => { c.sock.destroy(new Error('FTP time-out tijdens sessie')); });
    // Antwoord van de FTP-server op het scherm (226 = gelukt; anders de reden, bv. schijf vol).
    // Ruim wachten: bij groot bestand en traag geheugen kan het wegschrijven even duren.
    const reply = await Promise.race([c.next(), new Promise((r) => setTimeout(() => r(null), timeoutMs))]).catch(() => null);
    if (broken || !reply || ![226, 250].includes(reply.code)) {
      throw new Error(`Upload afgebroken na ${mb(written)} van ${mb(size)}`
        + `${broken ? `: ${broken}` : ''}${reply ? ` (FTP-server: ${reply.text})` : ' (geen antwoord van de FTP-server)'}`);
    }
    const sz = await c.cmd(`SIZE ${remoteName}`);
    if (sz.code === 213 && Number(sz.text.split(' ').pop()) !== size) {
      throw new Error(`Grootte op scherm (${sz.text.split(' ').pop()}) wijkt af van lokaal (${size})`);
    }
    return { size, verified: sz.code === 213 };
  } finally {
    c.cmd('QUIT').catch(() => {});
    c.sock.end();
  }
}

// Verwijdert een bestand op het scherm (gebruikt door het testscript).
async function remove(host, ftp, remoteName, timeoutMs = 10000) {
  const c = await login(host, ftp, timeoutMs);
  try {
    await expect(c.cmd(`DELE ${remoteName}`), [250], 'DELE');
  } finally {
    c.cmd('QUIT').catch(() => {});
    c.sock.end();
  }
}

module.exports = { check, upload, remove };
