import { Link, FTMS, TREADMILL_DATA, HRS, HR_MEASUREMENT, parseTreadmillData, parseHeartRate, inspectDevice } from './ble.js';
import { buildFit, fitFileName } from './fit.js';
import { saveRun, deleteRun, getRun, listRuns, persist } from './store.js';

const VERSION = '1.0.1';
const $ = (id) => document.getElementById(id);

// ---------- Einstellungen ----------
const opts = { autoPause: true, vibrate: true };
try { Object.assign(opts, JSON.parse(localStorage.getItem('opts') || '{}')); } catch { /* egal */ }
const saveOpts = () => { try { localStorage.setItem('opts', JSON.stringify(opts)); } catch { /* egal */ } };

// ---------- Zustand ----------
const live = {
  speed: null,      // km/h
  tmDist: null,     // letzte Distanz vom Laufband (m)
  incline: null,    // %
  hrStrap: null, hrStrapAt: 0,
  hrTm: null, hrTmAt: 0,
};
let run = null;     // aktiver Lauf
let lastTick = 0;
let demo = null;

// ---------- Formatierung ----------
const nf = (v, d) => v.toLocaleString('de-AT', { minimumFractionDigits: d, maximumFractionDigits: d });
function fmtPace(kmh) {
  if (!kmh || kmh < 1) return '--:--';
  const s = Math.round(3600 / kmh);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const paceFromSec = (sec, m) => (m > 0 ? fmtPace((m / 1000) / (sec / 3600)) : '--:--');
function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function currentHr() {
  const now = Date.now();
  if (live.hrStrap && now - live.hrStrapAt < 5000) return live.hrStrap;
  if (live.hrTm && now - live.hrTmAt < 5000) return live.hrTm;
  return null;
}

// ---------- UI-Hilfen ----------
let toastT;
function toast(msg, ms = 2500) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}
function ask(text, yes = 'OK') {
  return new Promise((resolve) => {
    const d = $('dlg'); $('dlgText').textContent = text; $('dlgYes').textContent = yes;
    const done = (v) => { d.oncancel = $('dlgYes').onclick = $('dlgNo').onclick = null; if (d.open) d.close(); resolve(v); };
    $('dlgYes').onclick = () => done(true);
    $('dlgNo').onclick = () => done(false);
    d.oncancel = (e) => { e.preventDefault(); done(false); };
    d.showModal();
  });
}
function log(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}
// Große Verbinden-Knöpfe nur zeigen, solange das jeweilige Gerät getrennt ist
function renderConnect() {
  const tmOff = $('chipTm').dataset.state === 'getrennt';
  const hrOff = $('chipHr').dataset.state === 'getrennt';
  $('btnConnectTm').hidden = !tmOff;
  $('btnConnectHr').hidden = !hrOff;
  $('connectBox').hidden = !tmOff && !hrOff;
}
function setChip(el, state, name, fallback) {
  el.dataset.state = state;
  queueMicrotask(renderConnect);
  el.querySelector('.lbl').textContent = state === 'getrennt' ? `+ ${fallback}`
    : `${name || fallback}${state === 'verbinde' ? ' …' : ''}`;
  el.title = state === 'getrennt' ? `${fallback} verbinden` : `${name || fallback} – tippen zum Trennen`;
}

// ---------- Bluetooth ----------
const treadmill = new Link({
  label: 'Laufband', service: FTMS, characteristic: TREADMILL_DATA, parse: parseTreadmillData,
  onData: onTreadmill,
  onStatus: (st, name) => {
    setChip($('chipTm'), st, name, 'Laufband');
    if (st === 'verbunden') toast(`Laufband verbunden: ${name || ''}`);
    if (st !== 'verbunden') live.speed = null;
  },
});
const strap = new Link({
  label: 'Puls', service: HRS, characteristic: HR_MEASUREMENT, parse: parseHeartRate,
  onData: (d) => { if (d.hr) { live.hrStrap = d.hr; live.hrStrapAt = Date.now(); } },
  onStatus: (st, name) => {
    setChip($('chipHr'), st, name, 'Puls');
    if (st === 'verbunden') toast(`Pulsgurt verbunden: ${name || ''}`);
  },
});

function onTreadmill(d) {
  if (d.speed !== undefined) live.speed = d.speed;
  if (d.incline !== undefined) live.incline = d.incline;
  if (d.hr) { live.hrTm = d.hr; live.hrTmAt = Date.now(); }
  if (d.distance !== undefined) {
    if (run) {
      run.tmDistSeen = true;
      const delta = live.tmDist === null ? 0 : d.distance - live.tmDist;
      // Nur plausible Zuwächse zählen (Laufband kann auf 0 zurückspringen)
      if (isRecording() && delta > 0 && delta < 60) addDistance(delta);
    }
    live.tmDist = d.distance;
  }
}

async function connect(link, options, name) {
  if (!navigator.bluetooth) {
    await ask('Dieser Browser unterstützt kein Web Bluetooth. Bitte die App in Chrome auf Android öffnen.');
    return;
  }
  if (link.connected || link.wanted) {
    if (await ask(`${name} trennen?`, 'Trennen')) link.disconnect();
    return;
  }
  try { await link.pick(options); } catch (e) {
    if (e.name !== 'NotFoundError') { toast(`${name}: ${e.message}`, 5000); log(`${name}: ${e.message}`); }
    link.disconnect();
  }
}

$('chipTm').onclick = () => connect(treadmill, {
  filters: [{ services: [FTMS] }, { namePrefix: 'KETTLER' }, { namePrefix: 'Kettler' }],
  optionalServices: [FTMS, 'device_information'],
}, 'Laufband');
$('chipHr').onclick = () => connect(strap, { filters: [{ services: [HRS] }] }, 'Pulsgurt');
$('btnConnectTm').onclick = () => $('chipTm').click();
$('btnConnectHr').onclick = () => $('chipHr').click();

// ---------- Lauf ----------
const isActive = () => run && run.state !== 'done';
const isRecording = () => isActive() && run.state === 'running' && (!opts.autoPause || (live.speed ?? 0) > 0);

function addDistance(m) {
  const before = run.dist;
  run.dist += m;
  const km = Math.floor(run.dist / 1000);
  if (km > Math.floor(before / 1000)) {
    const t = run.movingMs / 1000;
    const prev = run.splits.length ? run.splits[run.splits.length - 1] : 0;
    run.splits.push(t);
    const split = fmtTime(t - prev);
    toast(`Kilometer ${km}: ${split} min`, 4000);
    if (opts.vibrate) navigator.vibrate?.([200, 100, 200]);
    renderSplits();
  }
}

function startRun() {
  const now = Date.now();
  run = {
    id: String(now), start: now, end: null, state: 'running', movingMs: 0, dist: 0,
    samples: [], events: [{ t: now / 1000, type: 'start' }], splits: [], tmDistSeen: false,
    recWas: null, lastSampleSec: 0,
  };
  lastTick = now;
  wakeLock(true);
  persist();
  renderControls();
}

function pauseRun() {
  if (!isActive()) return;
  run.state = run.state === 'running' ? 'paused' : 'running';
  renderControls();
}

async function stopRun() {
  if (!isActive()) return;
  const wasState = run.state;
  run.state = 'paused';
  renderControls();
  if (!(await ask('Lauf beenden und speichern?', 'Beenden'))) { run.state = wasState; renderControls(); return; }
  await finishRun(run);
  const r = run;
  run = null;
  wakeLock(false);
  renderControls();
  resetDisplay();
  if (r.samples.length) {
    toast('Lauf gespeichert');
    showTab('history');
    renderHistory(r.id);
  } else {
    toast('Kein Datenpunkt aufgezeichnet – Lauf verworfen');
  }
}

function summarize(r) {
  const s = r.samples;
  const hrs = s.map((x) => x[3]).filter(Boolean);
  const duration = r.movingMs / 1000;
  return {
    duration, distance: r.dist,
    avgSpeed: duration > 0 ? r.dist / duration : 0,
    maxSpeed: s.reduce((m, x) => Math.max(m, x[2] || 0), 0),
    avgHr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
    maxHr: hrs.length ? Math.max(...hrs) : null,
    avgIncline: s.length ? s.reduce((a, x) => a + (x[4] || 0), 0) / s.length : null,
  };
}

async function finishRun(r) {
  const last = r.samples[r.samples.length - 1];
  const endSec = last ? last[0] : Date.now() / 1000;
  if (r.events[r.events.length - 1]?.type !== 'stop') r.events.push({ t: endSec, type: 'stop' });
  r.end = endSec * 1000;
  r.state = 'done';
  r.summary = summarize(r);
  delete r.recWas; delete r.lastSampleSec;
  if (r.samples.length) await saveRun(r);
  else await deleteRun(r.id);
}

// Takt: einmal pro Sekunde Zeit zählen, Messpunkt speichern, Anzeige aktualisieren
function tick() {
  const now = Date.now();
  const dt = Math.min(now - lastTick, 5000);
  lastTick = now;

  if (isActive()) {
    const rec = isRecording();
    if (rec !== run.recWas) {
      // Pause/Weiter als FIT-Ereignis festhalten
      if (run.recWas !== null) run.events.push({ t: now / 1000, type: rec ? 'start' : 'stop' });
      run.recWas = rec;
    }
    if (rec) {
      const ms = (live.speed ?? 0) / 3.6; // m/s
      run.movingMs += dt;
      // Liefert das Laufband keine Distanz, aus der Geschwindigkeit berechnen
      if (!run.tmDistSeen && ms > 0) addDistance(ms * (dt / 1000));
      const sec = Math.floor(now / 1000);
      if (sec > run.lastSampleSec) {
        run.lastSampleSec = sec;
        run.samples.push([sec, Math.round(run.dist * 10) / 10, Math.round(ms * 1000) / 1000,
          currentHr(), live.incline]);
      }
    }
    // alle 15 s zwischenspeichern (falls die App abstürzt)
    if (run.samples.length && now - (run.savedAt || 0) > 15000) {
      run.savedAt = now;
      saveRun({ ...run }).catch(() => {});
    }
  }
  renderLive();
}

// ---------- Anzeige ----------
function renderLive() {
  const sp = live.speed;
  $('vPace').textContent = fmtPace(sp);
  $('vSpeed').textContent = sp == null ? '–' : nf(sp, 1);
  $('vIncline').textContent = live.incline == null ? '–' : nf(live.incline, 1);
  const hr = currentHr();
  $('vHr').textContent = hr ?? '--';
  if (run) {
    const sec = run.movingMs / 1000;
    $('vDist').textContent = nf(Math.floor(run.dist / 10) / 100, 2);
    $('vTime').textContent = fmtTime(sec);
    $('vAvg').textContent = paceFromSec(sec, run.dist);
  }
  const st = $('status');
  st.className = 'status';
  if (!run) {
    st.textContent = treadmill.connected ? 'Bereit – Start drücken' : 'Bereit – Laufband verbinden und Start drücken';
  } else if (run.state === 'paused') {
    st.textContent = 'Pausiert'; st.classList.add('paused');
  } else if (!isRecording()) {
    st.textContent = 'Auto-Pause – wartet auf das Band'; st.classList.add('paused');
  } else {
    st.textContent = demo ? 'Aufzeichnung läuft (Demo)' : 'Aufzeichnung läuft'; st.classList.add('live');
  }
}

function renderSplits() {
  const el = $('splits');
  if (!run || !run.splits.length) { el.innerHTML = ''; $('vLastKm').textContent = '–'; return; }
  const parts = run.splits.map((t, i) => [i + 1, t - (run.splits[i - 1] || 0)]);
  $('vLastKm').textContent = fmtTime(parts[parts.length - 1][1]);
  el.innerHTML = parts.reverse().map(([k, d]) => `<div class="split">km ${k}<b>${fmtTime(d)}</b></div>`).join('');
}

function renderControls() {
  const active = isActive();
  $('btnStart').hidden = active;
  $('btnPause').hidden = !active;
  $('btnStop').hidden = !active;
  if (active) $('btnPause').textContent = run.state === 'paused' ? 'Weiter' : 'Pause';
  renderLive();
}

function resetDisplay() {
  $('vDist').textContent = '0,00'; $('vTime').textContent = '0:00'; $('vAvg').textContent = '--:--';
  renderSplits();
}

$('btnStart').onclick = () => {
  if (!treadmill.connected && !demo) toast('Hinweis: Laufband ist nicht verbunden', 3500);
  startRun();
};
$('btnPause').onclick = pauseRun;
$('btnStop').onclick = stopRun;

// ---------- Bildschirm anlassen ----------
let lock = null;
async function wakeLock(on) {
  try {
    if (on && !lock && 'wakeLock' in navigator) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } else if (!on && lock) { await lock.release(); lock = null; }
  } catch { /* egal */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isActive()) wakeLock(true); });

// ---------- Läufe ----------
const dateFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

async function renderHistory(openId) {
  const runs = await listRuns();
  const el = $('runs');
  if (!runs.length) { el.innerHTML = '<p class="hint">Noch keine Läufe gespeichert.</p>'; return; }
  el.innerHTML = runs.map((r) => {
    const s = r.summary || summarize(r);
    const splits = (r.splits || []).map((t, i, a) => {
      const d = t - (a[i - 1] || 0);
      return `<tr><td>km ${i + 1}</td><td>${fmtTime(d)}</td><td>${fmtTime(t)}</td></tr>`;
    }).join('');
    const rest = s.distance - (r.splits?.length || 0) * 1000;
    const restRow = rest >= 50 ? `<tr><td>+${nf(rest / 1000, 2)} km</td><td>${fmtTime(s.duration - (r.splits?.at(-1) || 0))}</td><td>${fmtTime(s.duration)}</td></tr>` : '';
    return `<details class="run" data-id="${r.id}" ${r.id === openId ? 'open' : ''}>
      <summary>
        <span class="date">${dateFmt.format(new Date(r.start))}</span>
        <span class="dist">${nf(s.distance / 1000, 2)} km</span>
        <span class="meta">${fmtTime(s.duration)} · Ø ${paceFromSec(s.duration, s.distance)} min/km${s.avgHr ? ` · Ø ${s.avgHr} bpm (max ${s.maxHr})` : ''}${s.avgIncline ? ` · Ø ${nf(s.avgIncline, 1)} %` : ''}</span>
      </summary>
      ${splits || restRow ? `<table><tr><th>Abschnitt</th><th>Zeit</th><th>Gesamt</th></tr>${splits}${restRow}</table>` : ''}
      <div class="controls">
        <button class="btn small primary" data-act="fit">FIT-Datei</button>
        ${navigator.canShare ? '<button class="btn small" data-act="share">Teilen</button>' : ''}
        <button class="btn small danger" data-act="del">Löschen</button>
      </div>
    </details>`;
  }).join('');
}

function fitFile(r) {
  const bytes = buildFit(r);
  return new File([bytes], fitFileName(r), { type: 'application/vnd.ant.fit' });
}

$('runs').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.run').dataset.id;
  const r = await getRun(id);
  if (!r) return;
  try {
    if (btn.dataset.act === 'fit') {
      const f = fitFile(r);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f); a.download = f.name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast(`${f.name} gespeichert (Downloads)`, 4000);
    } else if (btn.dataset.act === 'share') {
      const f = fitFile(r);
      if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: f.name });
      else toast('Teilen von Dateien wird hier nicht unterstützt');
    } else if (btn.dataset.act === 'del') {
      if (await ask('Diesen Lauf endgültig löschen?', 'Löschen')) { await deleteRun(id); renderHistory(); }
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, 5000);
  }
});

// ---------- Tabs ----------
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${name}`));
  if (name === 'history') renderHistory();
}
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

// ---------- Einstellungen & Diagnose ----------
$('optAutoPause').checked = opts.autoPause;
$('optVibrate').checked = opts.vibrate;
$('optAutoPause').onchange = (e) => { opts.autoPause = e.target.checked; saveOpts(); };
$('optVibrate').onchange = (e) => { opts.vibrate = e.target.checked; saveOpts(); };

$('btnDiag').onclick = async () => {
  if (!navigator.bluetooth) { log('Web Bluetooth nicht verfügbar (Chrome auf Android verwenden).'); return; }
  $('log').textContent = '';
  try { await inspectDevice(log); } catch (e) { log(`Fehler: ${e.message}`); }
};
$('btnCopyLog').onclick = async () => {
  try { await navigator.clipboard.writeText($('log').textContent); toast('Log kopiert'); } catch { toast('Kopieren nicht möglich'); }
};
$('btnDemo').onclick = () => {
  if (demo) {
    clearInterval(demo); demo = null; live.speed = null; live.hrTm = null; live.incline = null;
    $('btnDemo').textContent = 'Demo-Modus'; toast('Demo beendet'); return;
  }
  // Simuliert ein Laufband mit ~10 km/h, leicht schwankend, inkl. Puls
  let dist = 0, t = 0;
  demo = setInterval(() => {
    t++;
    const speed = t < 5 ? 0 : 9.8 + Math.sin(t / 20) * 1.2;
    dist += speed / 3.6;
    onTreadmill({ speed, distance: Math.floor(dist), incline: t > 60 ? 2 : 1, hr: Math.round(128 + Math.min(t, 120) / 4 + Math.sin(t / 7) * 3) });
  }, 1000);
  $('btnDemo').textContent = 'Demo beenden';
  toast('Demo läuft – Start drücken');
  showTab('run');
};
$('version').textContent = `Version ${VERSION}`;

// ---------- Start ----------
(async () => {
  // Unterbrochene Läufe (App geschlossen/abgestürzt) abschließen und behalten
  try {
    for (const r of await listRuns()) {
      if (r.state !== 'done') { await finishRun(r); toast('Ein unterbrochener Lauf wurde gespeichert', 4000); }
    }
  } catch (e) { console.warn(e); }
})();
setChip($('chipTm'), 'getrennt', '', 'Laufband');
setChip($('chipHr'), 'getrennt', '', 'Puls');
lastTick = Date.now();
setInterval(tick, 1000);
renderControls();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Für Tests in der Konsole
window.__laufband = { live, get run() { return run; }, onTreadmill, buildFit, listRuns };
