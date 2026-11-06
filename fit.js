// Minimaler FIT-Encoder für eine Laufband-Aktivität (Import in Garmin Connect)
// Run-Format: { start, end, samples: [[epochSek, distanzM, speedMs, hr|null, steigung|null], ...],
//               events: [{ t: epochSek, type: 'start'|'stop' }], summary: {...} }

const FIT_EPOCH = 631065600; // 31.12.1989 00:00 UTC in Unix-Sekunden

const T = { enum: 0x00, uint8: 0x02, sint16: 0x83, uint16: 0x84, uint32: 0x86, uint32z: 0x8c };
const SIZE = { 0x00: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x86: 4, 0x8c: 4 };
const INVALID = { 0x00: 0xff, 0x02: 0xff, 0x83: 0x7fff, 0x84: 0xffff, 0x86: 0xffffffff, 0x8c: 0 };

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

export function crc16(bytes, crc = 0) {
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

// Nachrichtendefinitionen: [Feldnummer, Name, Typ]
const MESGS = {
  file_id: { num: 0, fields: [[0, 'type', T.enum], [1, 'manufacturer', T.uint16], [2, 'product', T.uint16],
    [3, 'serial_number', T.uint32z], [4, 'time_created', T.uint32]] },
  event: { num: 21, fields: [[253, 'timestamp', T.uint32], [0, 'event', T.enum], [1, 'event_type', T.enum],
    [4, 'event_group', T.uint8]] },
  record: { num: 20, fields: [[253, 'timestamp', T.uint32], [5, 'distance', T.uint32], [6, 'speed', T.uint16],
    [73, 'enhanced_speed', T.uint32], [3, 'heart_rate', T.uint8], [9, 'grade', T.sint16]] },
  lap: { num: 19, fields: [[254, 'message_index', T.uint16], [253, 'timestamp', T.uint32], [0, 'event', T.enum],
    [1, 'event_type', T.enum], [2, 'start_time', T.uint32], [7, 'total_elapsed_time', T.uint32],
    [8, 'total_timer_time', T.uint32], [9, 'total_distance', T.uint32], [13, 'avg_speed', T.uint16],
    [14, 'max_speed', T.uint16], [15, 'avg_heart_rate', T.uint8], [16, 'max_heart_rate', T.uint8],
    [24, 'lap_trigger', T.enum], [25, 'sport', T.enum], [39, 'sub_sport', T.enum]] },
  session: { num: 18, fields: [[254, 'message_index', T.uint16], [253, 'timestamp', T.uint32], [0, 'event', T.enum],
    [1, 'event_type', T.enum], [2, 'start_time', T.uint32], [5, 'sport', T.enum], [6, 'sub_sport', T.enum],
    [7, 'total_elapsed_time', T.uint32], [8, 'total_timer_time', T.uint32], [9, 'total_distance', T.uint32],
    [14, 'avg_speed', T.uint16], [15, 'max_speed', T.uint16], [16, 'avg_heart_rate', T.uint8],
    [17, 'max_heart_rate', T.uint8], [25, 'first_lap_index', T.uint16], [26, 'num_laps', T.uint16],
    [28, 'trigger', T.enum]] },
  activity: { num: 34, fields: [[253, 'timestamp', T.uint32], [0, 'total_timer_time', T.uint32],
    [1, 'num_sessions', T.uint16], [2, 'type', T.enum], [3, 'event', T.enum], [4, 'event_type', T.enum],
    [5, 'local_timestamp', T.uint32]] },
};

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; this.local = {}; this.nextLocal = 0; }
  _grow(n) {
    if (this.len + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
  }
  byte(b) { this._grow(1); this.buf[this.len++] = b & 0xff; }
  value(type, v) {
    if (v === undefined || v === null || Number.isNaN(v)) v = INVALID[type];
    const n = SIZE[type];
    if (v < 0) v += 2 ** (8 * n); // Zweierkomplement für vorzeichenbehaftete Typen
    for (let i = 0; i < n; i++) this.byte((v / 2 ** (8 * i)) & 0xff);
  }
  write(name, data) {
    const m = MESGS[name];
    if (!(name in this.local)) {
      const lt = this.nextLocal++;
      this.local[name] = lt;
      this.byte(0x40 | lt); this.byte(0); this.byte(0); // Definition, reserviert, little endian
      this.byte(m.num & 0xff); this.byte(m.num >> 8); this.byte(m.fields.length);
      for (const [num, , type] of m.fields) { this.byte(num); this.byte(SIZE[type]); this.byte(type); }
    }
    this.byte(this.local[name]);
    for (const [, key, type] of m.fields) this.value(type, data[key]);
  }
}

const ts = (unixSec) => Math.round(unixSec) - FIT_EPOCH;
const u = (v, scale) => (v === null || v === undefined ? null : Math.round(v * scale));

export function buildFit(run) {
  const s = run.samples;
  if (!s.length) throw new Error('Lauf enthält keine Daten');
  const sum = run.summary;
  const start = s[0][0];
  const end = s[s.length - 1][0];
  const w = new Writer();

  w.write('file_id', { type: 4, manufacturer: 255, product: 1, serial_number: 1, time_created: ts(start) });

  // Ereignisse (Start/Pause) und Messpunkte zeitlich gemischt schreiben
  const events = run.events?.length ? run.events : [{ t: start, type: 'start' }, { t: end, type: 'stop' }];
  let ei = 0;
  const flushEvents = (upTo) => {
    while (ei < events.length && events[ei].t <= upTo) {
      const e = events[ei++];
      w.write('event', { timestamp: ts(e.t), event: 0, event_type: e.type === 'start' ? 0 : 4, event_group: 0 });
    }
  };
  for (const [t, dist, speed, hr, grade] of s) {
    flushEvents(t);
    w.write('record', {
      timestamp: ts(t), distance: u(dist, 100), speed: u(speed, 1000), enhanced_speed: u(speed, 1000),
      heart_rate: hr ?? null, grade: u(grade, 100),
    });
  }
  flushEvents(Infinity);

  const common = {
    timestamp: ts(end), event: 9, event_type: 1, start_time: ts(start),
    total_elapsed_time: u(end - start, 1000), total_timer_time: u(sum.duration, 1000),
    total_distance: u(sum.distance, 100), avg_speed: u(sum.avgSpeed, 1000), max_speed: u(sum.maxSpeed, 1000),
    avg_heart_rate: sum.avgHr ?? null, max_heart_rate: sum.maxHr ?? null, sport: 1, sub_sport: 1,
  };
  w.write('lap', { ...common, message_index: 0, event: 9, lap_trigger: 7 });
  w.write('session', { ...common, message_index: 0, event: 8, first_lap_index: 0, num_laps: 1, trigger: 0 });
  const tzOffset = -new Date(start * 1000).getTimezoneOffset() * 60;
  w.write('activity', { timestamp: ts(end), total_timer_time: u(sum.duration, 1000), num_sessions: 1,
    type: 0, event: 26, event_type: 1, local_timestamp: ts(end) + tzOffset });

  // Kopf (14 Byte) + Daten + CRC
  const data = w.buf.subarray(0, w.len);
  const out = new Uint8Array(14 + data.length + 2);
  const dv = new DataView(out.buffer);
  out[0] = 14; out[1] = 0x20; dv.setUint16(2, 2132, true); dv.setUint32(4, data.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  dv.setUint16(12, crc16(out.subarray(0, 12)), true);
  out.set(data, 14);
  dv.setUint16(14 + data.length, crc16(out.subarray(0, 14 + data.length)), true);
  return out;
}

export function fitFileName(run) {
  const d = new Date(run.start);
  const p = (n) => String(n).padStart(2, '0');
  return `Laufband_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.fit`;
}
