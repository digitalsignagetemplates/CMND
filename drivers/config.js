// Leest config.json en daarover config.local.json (niet in git, bv. voor wachtwoorden).
// Eén plek, zodat de tool en de hulpscripts precies dezelfde instellingen gebruiken.
const fs = require('fs');
const path = require('path');

function loadConfig(root = path.join(__dirname, '..')) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const base = read('config.json');
  if (!fs.existsSync(path.join(root, 'config.local.json'))) return base;
  const local = read('config.local.json');
  for (const [k, v] of Object.entries(local)) {
    base[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(base[k] || {}), ...v } : v;
  }
  return base;
}

module.exports = { loadConfig };
