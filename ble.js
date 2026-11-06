// Bluetooth: Laufband (FTMS) und Pulsgurt (Heart Rate Service)

export const FTMS = 'fitness_machine';            // 0x1826
export const TREADMILL_DATA = 0x2acd;
export const HRS = 'heart_rate';                  // 0x180D
export const HR_MEASUREMENT = 'heart_rate_measurement'; // 0x2A37

// Dienste, die im Diagnose-Modus zusätzlich lesbar sein sollen
export const DIAG_SERVICES = [
  FTMS, HRS, 'device_information', 'battery_service', 'cycling_power',
  'cycling_speed_and_cadence', 'running_speed_and_cadence',
  0xfff0, 0xffe0, 0xfee7,
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
];

const hex = (dv) => Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
  .map((b) => b.toString(16).padStart(2, '0')).join(' ');

/**
 * FTMS Treadmill Data (0x2ACD) auswerten.
 * Liefert nur die Felder, die im Paket enthalten sind.
 */
export function parseTreadmillData(dv) {
  const r = { raw: hex(dv) };
  if (dv.byteLength < 2) return r;
  let o = 0;
  const has = (n) => o + n <= dv.byteLength;
  const flags = dv.getUint16(o, true); o += 2;
  r.flags = flags;
  // Bit 0 = "More Data": wenn 0, ist die Geschwindigkeit enthalten
  if (!(flags & 0x0001) && has(2)) { r.speed = dv.getUint16(o, true) / 100; o += 2; } // km/h
  if (flags & 0x0002) { if (!has(2)) return r; r.avgSpeed = dv.getUint16(o, true) / 100; o += 2; }
  if (flags & 0x0004) { if (!has(3)) return r; r.distance = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16); o += 3; } // m
  if (flags & 0x0008) {
    if (!has(4)) return r;
    const inc = dv.getInt16(o, true);
    if (inc !== 0x7fff) r.incline = inc / 10; // %
    o += 4; // Steigung + Rampenwinkel
  }
  if (flags & 0x0010) o += 4; // Höhengewinn +/-
  if (flags & 0x0020) o += 1; // Momentan-Pace
  if (flags & 0x0040) o += 1; // Durchschnitts-Pace
  if (flags & 0x0080) { if (!has(5)) return r; r.energy = dv.getUint16(o, true); o += 5; }
  if (flags & 0x0100) {
    if (!has(1)) return r;
    const hr = dv.getUint8(o); o += 1;
    if (hr >= 30 && hr <= 240) r.hr = hr;
  }
  if (flags & 0x0200) o += 1; // MET
  if (flags & 0x0400) { if (!has(2)) return r; r.elapsed = dv.getUint16(o, true); o += 2; }
  return r;
}

/** Heart Rate Measurement (0x2A37) auswerten */
export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  const hr = flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
  return { hr: hr > 0 ? hr : null, raw: hex(dv) };
}

/**
 * Verbindung zu einem BLE-Gerät mit einer Benachrichtigungs-Charakteristik.
 * Verbindet nach einem Abbruch automatisch neu.
 */
export class Link {
  constructor({ label, service, characteristic, parse, onData, onStatus }) {
    Object.assign(this, { label, service, characteristic, parse, onData, onStatus });
    this.device = null;
    this.char = null;
    this.wanted = false;
    this.retry = 0;
  }

  get connected() { return !!(this.device && this.device.gatt.connected && this.char); }

  async pick(options) {
    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', () => this._lost());
    this.wanted = true;
    await this._connect();
  }

  async _connect() {
    this.onStatus('verbinde', this.device.name);
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(this.service);
    this.char = await svc.getCharacteristic(this.characteristic);
    this.char.addEventListener('characteristicvaluechanged', (e) => {
      try { this.onData(this.parse(e.target.value)); } catch (err) { console.warn(err); }
    });
    await this.char.startNotifications();
    this.retry = 0;
    this.onStatus('verbunden', this.device.name);
  }

  _lost() {
    this.char = null;
    if (!this.wanted) { this.onStatus('getrennt', this.device?.name); return; }
    this.onStatus('verbinde', this.device?.name);
    const wait = Math.min(1000 * 2 ** this.retry, 15000);
    this.retry++;
    setTimeout(async () => {
      if (!this.wanted) return;
      try { await this._connect(); } catch { this._lost(); }
    }, wait);
  }

  disconnect() {
    this.wanted = false;
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    else this.onStatus('getrennt', this.device?.name);
  }
}

/** Diagnose: alle lesbaren Dienste und Charakteristiken eines Geräts auflisten */
export async function inspectDevice(log) {
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true, optionalServices: DIAG_SERVICES,
  });
  log(`Gerät: ${device.name || '(ohne Namen)'} · ID ${device.id}`);
  const server = await device.gatt.connect();
  const services = await server.getPrimaryServices();
  if (!services.length) log('Keine bekannten Dienste gefunden.');
  for (const s of services) {
    log(`Dienst ${s.uuid}`);
    for (const c of await s.getCharacteristics()) {
      const p = c.properties;
      const props = ['read', 'write', 'notify', 'indicate'].filter((k) => p[k]).join(', ');
      let val = '';
      if (p.read) { try { val = ' = ' + hex(await c.readValue()); } catch { /* egal */ } }
      log(`  · ${c.uuid} [${props}]${val}`);
      if (p.notify) {
        c.addEventListener('characteristicvaluechanged', (e) => log(`  ↳ ${c.uuid.slice(4, 8)}: ${hex(e.target.value)}`));
        try { await c.startNotifications(); } catch { /* egal */ }
      }
    }
  }
  log('Fertig. Benachrichtigungen erscheinen laufend hier.');
  return device;
}
