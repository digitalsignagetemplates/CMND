// Test de SICP-instelcommando's op één testscherm: zet een waarde, leest terug
// en zet daarna de oorspronkelijke waarde terug.
// Gebruik: node tools\test-instellen.js 192.168.2.63

const net = require('net');
const { buildPacket } = require('../drivers/sicp');

const host = process.argv[2];
if (!host) { console.error('Gebruik: node tools\\test-instellen.js <ip-van-testscherm>'); process.exit(1); }

const query = (data) => new Promise((resolve) => {
  const s = net.createConnection({ host, port: 5000 });
  s.setTimeout(4000, () => { s.destroy(); resolve(null); });
  s.on('error', () => resolve(null));
  s.on('connect', () => s.write(buildPacket(1, data)));
  s.on('data', (d) => { s.destroy(); resolve([...d.subarray(3, -1)]); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (a) => (a ? a.map((b) => b.toString(16).padStart(2, '0')).join(' ') : 'geen antwoord');

// [naam, set-code, get-code, testwaarde]; Mode 3 (0x06) blijft bereikbaar in standby.
const TESTS = [
  ['SmartPower', 0xDD, 0xDE, [0x02]],
  ['Power save', 0xD2, 0xD3, [0x06]],
  ['Opstartbron', 0xBB, 0xBA, [0x0D, 0x00]],
];

(async () => {
  const results = [];
  for (const [name, set, get, value] of TESTS) {
    const orig = await query([get]);
    if (!orig || orig[0] !== get) { results.push([name, 'overgeslagen: uitlezen niet ondersteund']); continue; }
    const origVal = orig.slice(1, 1 + value.length);
    const ack = await query([set, ...value]);
    await sleep(800);
    const after = await query([get]);
    const changed = after && after[0] === get && after[1] === value[0];
    await query([set, ...origVal]);
    await sleep(800);
    const restored = await query([get]);
    const back = restored && restored[1] === origVal[0];
    console.log(`${name}: origineel ${hx(origVal)} · zet ${hx(value)} → ${hx(ack)} · gelezen ${hx(after)} · terug ${hx(restored)}`);
    results.push([name, changed && back ? 'OK (gewijzigd en hersteld)' : `NIET OK (gewijzigd: ${changed}, hersteld: ${back})`]);
  }
  // Powerschema: pagina 7 tijdelijk vullen en daarna de oorspronkelijke bytes terugzetten.
  {
    const PAGE = 7;
    const orig = await query([0x5B, PAGE]);
    if (!orig || orig[0] !== 0x5B) results.push(['Powerschema', 'overgeslagen: uitlezen niet ondersteund']);
    else {
      const o = orig.slice(1, 9); // [aan, sh, sm, eh, em, bron, dagen, tag]
      const test = [(PAGE << 4) | 1, 0x03, 0x00, 0x03, 0x05, 0x18, 0x01 | (1 << 7), 0x00]; // zo 03:00-03:05 Custom
      const ack = await query([0x5A, ...test]);
      await sleep(800);
      const after = await query([0x5B, PAGE]);
      const changed = after && after.slice(2, 9).join() === test.slice(1).join() && after[1] === 1;
      await query([0x5A, (PAGE << 4) | o[0], ...o.slice(1)]);
      await sleep(800);
      const restored = await query([0x5B, PAGE]);
      const back = restored && restored.slice(1, 9).join() === o.join();
      console.log(`Powerschema p${PAGE}: origineel ${hx(o)} · zet ${hx(test)} → ${hx(ack)} · gelezen ${hx(after)} · terug ${hx(restored)}`);
      results.push(['Powerschema', changed && back ? 'OK (gewijzigd en hersteld)' : `NIET OK (gewijzigd: ${changed}, hersteld: ${back})`]);
    }
  }

  console.log('\nResultaat:');
  for (const [n, r] of results) console.log(`  ${n.padEnd(12)} ${r}`);
})();
