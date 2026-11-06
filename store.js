// Läufe lokal im Browser speichern (IndexedDB)

let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('laufband', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('runs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('runs', mode);
    const r = fn(t.objectStore('runs'));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const saveRun = (run) => tx('readwrite', (s) => s.put(run));
export const deleteRun = (id) => tx('readwrite', (s) => s.delete(id));
export const getRun = (id) => tx('readonly', (s) => s.get(id));
export async function listRuns() {
  const all = await tx('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.start - a.start);
}

export async function persist() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* egal */ }
}
