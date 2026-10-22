// Leest schermen read-only uit de CMND & Control-database (smartcontroldb)
// via de mysql.exe-client die met CMND wordt meegeïnstalleerd. Alleen SELECT.

const { execFile } = require('child_process');
const fs = require('fs');

function password(db) {
  if (db.password) return db.password;
  if (!db.passwordFromProperties) return '';
  // Wachtwoord van Control zelf gebruiken zonder het te kopiëren naar config.json.
  const line = fs.readFileSync(db.passwordFromProperties, 'utf8')
    .split(/\r?\n/).find((l) => l.startsWith('spring.datasource.password='));
  return line ? line.slice('spring.datasource.password='.length).trim() : '';
}

function query(db, sql) {
  return new Promise((resolve, reject) => {
    const args = ['-h', db.host, '-P', String(db.port), '-u', db.user, '--batch', '--default-character-set=utf8', '-e', sql, db.database];
    execFile(db.mysqlExe, args, { env: { ...process.env, MYSQL_PWD: password(db) }, timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      const [head, ...rows] = stdout.trim().split(/\r?\n/);
      if (!head) return resolve([]);
      const cols = head.split('\t');
      resolve(rows.map((r) => Object.fromEntries(r.split('\t').map((v, i) => [cols[i], v === 'NULL' ? null : v]))));
    });
  });
}

const DEVICE_SQL = `
SELECT d.id, d.name, d.address, d.model_number, d.serial_code, d.platform_label, d.platform_version,
       d.firmware_version_android, d.firmware_version_scaler, d.sicp_version, d.power_state,
       d.source_label, d.operating_hours, d.temperature_one, g.name AS group_name
FROM devices d LEFT JOIN \`groups\` g ON g.id = d.group_id`;

// Control bewaart geen Android-versie (platform_version is de board-versie,
// firmware_version_android de PPDS-firmware, bijv. FB01.18). Optioneel per model in te vullen.
function androidVersion(r, db) {
  const model = String(r.model_number || '').replace(/\/\d+$/, '');
  const map = db.androidByModel || {};
  const key = Object.keys(map).find((k) => model.toUpperCase().endsWith(k.toUpperCase()));
  return key ? map[key] : null;
}

function powerFromControl(v) {
  const s = String(v ?? '').toLowerCase();
  if (['on', '1', '2', 'power_on', 'aan'].includes(s)) return 'aan';
  if (['off', 'standby', 'power_off', '0'].includes(s)) return 'backlight_uit';
  return 'onbekend';
}

async function loadDevices(db) {
  const rows = await query(db, DEVICE_SQL);
  return rows.map((r) => {
    // Control slaat het adres op als "ip:poort" (SICP-poort).
    const [ip, port] = String(r.address || '').split(':');
    return {
    id: `ctl-${r.id}`,
    controlId: r.id,
    name: r.name || ip,
    ip,
    sicpPort: port ? Number(port) : null,
    group: r.group_name || '(geen groep)',
    model: r.model_number,
    android: androidVersion(r, db),
    firmware: r.firmware_version_android,
    serial: r.serial_code,
    sicpVersion: r.sicp_version,
    power: powerFromControl(r.power_state),
    powerRaw: r.power_state,
    controlSource: r.source_label,
    powerSaveMode: null,
    smartPower: null,
    bootSource: null,
    schedule: [],
    lastSeen: null,
    raw: { platform_label: r.platform_label, platform_version: r.platform_version, firmware_version_android: r.firmware_version_android, firmware_version_scaler: r.firmware_version_scaler, operating_hours: r.operating_hours, temperature_one: r.temperature_one },
    };
  });
}

async function loadSettings(db) {
  const [s] = await query(db, 'SELECT server_ip, default_ftp_settings_use_default, default_ftp_settings_port FROM settings LIMIT 1');
  return s || {};
}

module.exports = { loadDevices, loadSettings, query };
