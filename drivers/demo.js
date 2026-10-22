// Gesimuleerde D-Line-schermen. Verstuurt niets over het netwerk.

const GROUPS = ['Lobby', 'Restaurant', 'Vergaderzalen', 'Gang 1e', 'Gang 2e'];
const MODELS = [
  ['43BDL4550D', '8.0'], ['55BDL4550D', '8.0'], ['65BDL4550D', '8.0'],
  ['43BDL4650D', '9.0'], ['55BDL4650D', '9.0'], ['32BDL4550D', '7.1.2'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function createDemoDevices() {
  const devices = [];
  for (let i = 1; i <= 24; i++) {
    const [model, android] = MODELS[i % MODELS.length];
    const mode = String(1 + (i % 4));
    devices.push({
      id: `demo-${i}`,
      name: `Scherm ${String(i).padStart(2, '0')}`,
      ip: `192.168.50.${100 + i}`,
      group: GROUPS[i % GROUPS.length],
      model,
      android,
      serial: `DEMO${1000 + i}`,
      power: i % 7 === 0 ? 'slaapt' : i % 11 === 0 ? 'uit' : 'aan',
      powerSaveMode: mode,
      smartPower: pick(['uit', 'midden', 'hoog']),
      bootSource: pick(['hdmi1', 'mediaplayer', 'browser']),
      schedule: [],
      lastSeen: new Date(Date.now() - Math.random() * 3600e3).toISOString(),
    });
  }
  // Voorbeeld van een scherm dat buiten de minimale Android-versie valt.
  devices.push({
    id: 'demo-oud', name: 'Scherm oud', ip: '192.168.50.200', group: 'Gang 2e',
    model: '42BDL4050D', android: '6.0', serial: 'DEMO0001', power: 'aan',
    powerSaveMode: '3', smartPower: 'uit', bootSource: 'hdmi1', schedule: [],
    lastSeen: new Date().toISOString(),
  });
  return devices;
}

function reachable(dev) {
  return dev.power === 'aan' || dev.power === 'backlight_uit';
}

async function execute(dev, type, params) {
  await sleep(400 + Math.random() * 2500);
  if (!reachable(dev)) {
    // Slapend of uit: nooit een antwoord, de server markeert dit als 'geen reactie'.
    await sleep(60e3);
    return { ok: false, error: 'geen antwoord' };
  }
  if (Math.random() < 0.08) return { ok: false, error: 'NACK van scherm (gesimuleerd)' };

  switch (type) {
    case 'power':
      if (params.state === 'off') {
        const standbyReachable = dev.powerSaveMode === '3' || dev.powerSaveMode === '4';
        dev.power = standbyReachable ? 'backlight_uit' : 'slaapt';
      } else {
        dev.power = 'aan';
      }
      break;
    case 'powerSave':
      dev.powerSaveMode = String(params.mode);
      if (params.smartPower) dev.smartPower = params.smartPower;
      break;
    case 'bootSource':
      dev.bootSource = params.source;
      break;
    case 'source':
      dev.currentSource = params.source;
      break;
    case 'screenshot':
      return { ok: true, detail: 'Screenshot gemaakt (gesimuleerd)' };
    case 'firmware':
      return { ok: true, detail: 'Firmware-upgrade (gesimuleerd)' };
    case 'schedule':
      dev.schedule = params.entries;
      break;
    case 'refresh':
      break;
    default:
      return { ok: false, error: `onbekende actie ${type}` };
  }
  dev.lastSeen = new Date().toISOString();
  return { ok: true, detail: 'teruggelezen en gelijk (gesimuleerd)' };
}

function screenshot(dev) {
  if (!reachable(dev)) return null;
  const hue = (parseInt(dev.id.replace(/\D/g, ''), 10) || 1) * 37 % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="hsl(${hue},45%,28%)"/>
  <text x="480" y="250" fill="#fff" font-family="Segoe UI,Arial" font-size="44" text-anchor="middle">${dev.name}</text>
  <text x="480" y="305" fill="#ddd" font-family="Segoe UI,Arial" font-size="22" text-anchor="middle">DEMO-screenshot · ${dev.model} · ${new Date().toLocaleTimeString('nl-NL')}</text>
</svg>`;
  return { contentType: 'image/svg+xml', body: Buffer.from(svg) };
}

function poll(devices) {
  // Kleine willekeurige veranderingen zodat 'laatst gezien' leeft.
  for (const d of devices) if (reachable(d)) d.lastSeen = new Date().toISOString();
}

module.exports = { createDemoDevices, execute, screenshot, poll };
