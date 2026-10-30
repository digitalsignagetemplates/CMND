// Veilige voortest voor de firmware-upgrade. Start GEEN upgrade.
// Controleert per scherm: firmwareversie via SICP, FTP-login, upload van een klein
// testbestand (+ grootte), en ruimt dat bestand daarna weer op.
// Gebruik: node tools\test-firmware.js 192.168.2.63

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { buildPacket } = require('../drivers/sicp');
const ftp = require('../drivers/ftp');

const host = process.argv[2];
if (!host) { console.error('Gebruik: node tools\\test-firmware.js <ip-van-testscherm>'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

const sicp = (data) => new Promise((resolve) => {
  const s = net.createConnection({ host, port: cfg.sicp.port });
  s.setTimeout(5000, () => { s.destroy(); resolve(null); });
  s.on('error', () => resolve(null));
  s.on('connect', () => s.write(buildPacket(cfg.sicp.monitorId, data)));
  s.on('data', (d) => { s.destroy(); resolve([...d.subarray(3, -1)]); });
});

const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => console.log(`  FOUT  ${m}`);

(async () => {
  console.log(`Firmware-voortest op ${host} (er wordt geen upgrade gestart)\n`);
  let fails = 0;

  const fw = await sicp([0xA1, 0x01]);
  if (fw && fw[0] === 0xA1) ok(`Firmwareversie via SICP: ${Buffer.from(fw.slice(1)).toString('latin1').trim()}  -> gebruik deze notatie in version.txt`);
  else { bad('Firmwareversie niet uitleesbaar via SICP; de tool zal op dit model geen upgrade starten'); fails++; }

  const login = cfg.displayFtp || {};
  if (!login.user || !login.password) {
    bad('displayFtp in config.json is niet ingevuld (gebruiker/wachtwoord van de FTP-server op het scherm)');
    process.exit(1);
  }
  const account = { port: login.port || 2121, user: login.user, password: login.password };

  try { ok(`FTP-login op poort ${account.port} gelukt (${(await ftp.check(host, account)).split('\n').pop()})`); }
  catch (e) { bad(`FTP-login: ${e.message}`); process.exit(1); }

  const tmp = path.join(os.tmpdir(), 'dline-ftp-test.bin');
  fs.writeFileSync(tmp, Buffer.alloc(1024 * 1024, 0x5a)); // 1 MB testbestand
  const name = 'dline-ftp-test.bin';
  try {
    const t0 = Date.now();
    const r = await ftp.upload(host, account, tmp, name, null, 60000);
    const secs = (Date.now() - t0) / 1000;
    ok(`Upload 1 MB testbestand in ${secs.toFixed(1)} s${r.verified ? ', grootte op scherm klopt' : ' (scherm ondersteunt SIZE niet)'}`);
    console.log(`        Schatting voor update.zip van 1,5 GB: ~${Math.ceil((1536 * secs) / 60)} minuten`);
  } catch (e) { bad(`Upload: ${e.message}`); fails++; }
  try { await ftp.remove(host, account, name); ok('Testbestand op het scherm weer verwijderd'); }
  catch (e) { bad(`Opruimen testbestand: ${e.message} (verwijder ${name} handmatig)`); }
  fs.unlinkSync(tmp);

  console.log(fails ? '\nNiet alles is in orde; los bovenstaande fouten eerst op.' : '\nAlles in orde: dit scherm is klaar voor een firmware-upgrade via de tool.');
})();
