import { hydrateIcons, icon, setIcon } from '/icons.js';
import { findBand, learnBand, OneEuro, BAND_DEFAULT } from '/band.js';
import { fromName, fromMeta, fromFrame, fromSize, metaFromUrl, metaFromFile, combine, normalize, describe,
  grabFrame, renderPreview, PROJ_LABEL, STEREO_LABEL, defaultFov, autoKey, CHROMA_DEFAULT } from '/projection.js';

const VERSION = '__APP_VERSION__';
const VIDEO_CACHE = 'anja-videos';
const CHECK_EVERY_MS = 60 * 1000;
const $ = (id) => document.getElementById(id);

hydrateIcons();

/* ---------------- Hilfen ---------------- */
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
const fmtBytes = (b) => {
  if (!b && b !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
const fmtTime = (s) => {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s); const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
const niceName = (file) => decodeURIComponent(file)
  .replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------- Online/Offline ---------------- */
function updateNet() {
  const n = $('net');
  n.textContent = navigator.onLine ? 'online' : 'offline';
  n.classList.toggle('off', !navigator.onLine);
}
addEventListener('online', () => { updateNet(); initUpload().finally(loadList); checkForUpdate(); });
addEventListener('offline', () => { updateNet(); loadList(); });
updateNet();

/* ---------------- Update-Werkzeug ----------------
 * 1. Beim Start, alle 60 s und beim Zurueckkommen in den Tab wird /version.json
 *    ohne Cache abgefragt.
 * 2. Weicht die Server-Version von der laufenden ab, erscheint die Leiste
 *    "Neue Version verfuegbar".
 * 3. "Aktualisieren" loescht alle App-Caches (Videos bleiben), meldet den
 *    Service Worker ab und laedt die Seite frisch vom Server.
 * Dadurch kann kein Geraet auf altem Code haengen bleiben.
 */
let swReg = null;
let pendingVersion = null;

async function fetchServerVersion() {
  const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('version');
  return (await r.json()).version;
}

async function checkForUpdate(manual = false) {
  if (!navigator.onLine) { if (manual) toast('Offline – Update-Prüfung geht nur mit Internet'); return; }
  try {
    const v = await fetchServerVersion();
    swReg?.update().catch(() => {});
    if (v && v !== VERSION) {
      pendingVersion = v;
      $('update-text').textContent = `Neue Version ${v} verfügbar`;
      $('update-bar').hidden = false;
    } else if (manual) {
      toast(`Du hast die neueste Version (${VERSION})`);
    }
  } catch {
    if (manual) toast('Server gerade nicht erreichbar');
  }
}

async function clearAppCaches({ keepVideos = true } = {}) {
  const keys = await caches.keys();
  await Promise.all(keys
    .filter((k) => !(keepVideos && k === VIDEO_CACHE))
    .map((k) => caches.delete(k)));
  const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
  await Promise.all(regs.map((r) => r.unregister()));
}

async function hardReload({ keepVideos = true } = {}) {
  $('update-btn').disabled = true;
  $('update-text').textContent = 'Aktualisiere…';
  try { await clearAppCaches({ keepVideos }); } catch {}
  const u = new URL(location.href);
  u.searchParams.set('v', pendingVersion || Date.now());
  location.replace(u.toString());
}

$('update-btn').addEventListener('click', () => hardReload());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
    swReg = reg;
    // neuer Worker wartet? sofort uebernehmen
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) w.postMessage('skip-waiting');
      });
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'sw-activated' && e.data.version !== VERSION) {
      pendingVersion = e.data.version;
      $('update-text').textContent = `Neue Version ${e.data.version} bereit`;
      $('update-bar').hidden = false;
    }
  });
}

// "?v=" aus der Adresse wieder entfernen, sieht sonst unschoen aus
if (new URL(location.href).searchParams.has('v')) {
  const u = new URL(location.href); u.searchParams.delete('v');
  history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
}

checkForUpdate();
setInterval(checkForUpdate, CHECK_EVERY_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

/* ---------------- Menue ---------------- */
$('menu-btn').addEventListener('click', () => { $('menu').hidden = false; });
$('m-close').addEventListener('click', () => { $('menu').hidden = true; });
$('menu').addEventListener('click', (e) => { if (e.target.id === 'menu') $('menu').hidden = true; });
$('m-check').addEventListener('click', () => { $('menu').hidden = true; checkForUpdate(true); });
$('m-repair').addEventListener('click', () => {
  if (!navigator.onLine) { toast('Reparieren geht nur mit Internet'); return; }
  hardReload({ keepVideos: true });
});
$('m-wipe').addEventListener('click', () => {
  if (!navigator.onLine) { toast('Zurücksetzen geht nur mit Internet'); return; }
  if (confirm('Wirklich alles zurücksetzen? Offline gespeicherte Videos werden gelöscht.')) hardReload({ keepVideos: false });
});

/* ---------------- Videoliste ---------------- */
const busy = new Map(); // url -> AbortController

async function cachedSet() {
  const c = await caches.open(VIDEO_CACHE);
  const keys = await c.keys();
  return new Set(keys.map((r) => new URL(r.url).pathname));
}

async function updateStorage() {
  const box = $('storage');
  if (!navigator.storage?.estimate) return;
  const set = await cachedSet();
  if (!set.size) { box.hidden = true; return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  box.hidden = false;
  $('storage-text').textContent = `${fmtBytes(usage)} von ${fmtBytes(quota)}`;
  $('storage-bar').style.width = quota ? `${Math.min(100, (usage / quota) * 100)}%` : '0';
}

// Gibt es ein Video als .mp4 und .webm, wird die Fassung genommen, die dieses Geraet abspielen kann.
const probe = document.createElement('video');
const canMp4 = !!probe.canPlayType('video/mp4; codecs="avc1.64002A"');
const canWebm = !!probe.canPlayType('video/webm; codecs="vp9"');

function groupVideos(files) {
  const by = new Map();
  for (const f of files) {
    if (f.type !== 'file') continue;
    const m = /^(.*)\.(mp4|m4v|webm|mov|mkv|jpe?g|json)$/i.exec(f.name);
    if (!m) continue;
    const g = by.get(m[1]) || { base: m[1], sources: [] };
    if (/^jpe?g$/i.test(m[2])) g.poster = f;
    else if (/^json$/i.test(m[2])) g.meta = f;           // gespeichertes Videoformat
    else g.sources.push({ ...f, ext: m[2].toLowerCase() });
    by.set(m[1], g);
  }
  const out = [];
  for (const g of by.values()) {
    if (!g.sources.length) continue;
    const rank = (s) => (['webm', 'mkv'].includes(s.ext) ? (canWebm ? (canMp4 ? 1 : 0) : 3) : (canMp4 ? 0 : 2));
    g.sources.sort((a, b) => rank(a) - rank(b));
    out.push({ ...g.sources[0], base: g.base, poster: g.poster, meta: g.meta,
      all: [...g.sources.map((x) => x.name), ...(g.poster ? [g.poster.name] : []), ...(g.meta ? [g.meta.name] : [])] });
  }
  return out.sort((a, b) => a.base.localeCompare(b.base, 'de'));
}

let serverNames = new Set(); // Dateinamen ohne Endung, klein – gegen doppelte Namen beim Hochladen

async function loadList() {
  const list = $('list');
  let items = [];
  try {
    const r = await fetch('/videos/', { cache: 'no-store' });
    const files = await r.json();
    serverNames = new Set(files.map((f) => f.name.replace(/\.[^.]+$/, '').toLowerCase()));
    items = groupVideos(files);
  } catch { items = []; }
  const offline = await cachedSet();

  // offline: nur gespeicherte Videos anbieten
  if (!navigator.onLine) items = items.filter((f) => offline.has(`/videos/${encodeURIComponent(f.name)}`));

  if (!items.length) {
    list.innerHTML = `<div class="empty">${navigator.onLine
      ? (uploadEnabled
        ? 'Noch keine Videos auf dem Server.<br><small>Tippe oben auf Hochladen oder zieh ein 360°-Video hier rein.</small>'
        : 'Noch keine Videos auf dem Server.<br><small>360°-Videos (.mp4/.webm) in den Video-Ordner legen.</small>')
      : 'Offline und noch kein Video gespeichert.'}</div>`;
    updateStorage();
    return;
  }

  // gespeicherte Formate (kleine .json-Dateien) fuer die Abzeichen laden
  await Promise.all(items.map(async (f) => {
    f.format = f.meta ? await loadSidecar(f.meta.name) : null;
    if (!f.format) { const n = fromName(f.name); if (n.kind || n.stereo) f.format = normalize(n); }
  }));

  list.innerHTML = '';
  for (const f of items) {
    const path = `/videos/${encodeURIComponent(f.name)}`;
    const isOff = offline.has(path);
    const posterPath = f.poster ? `/videos/${encodeURIComponent(f.poster.name)}` : null;
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <div class="thumb">
        ${posterPath ? `<img class="ph" src="${posterPath}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph'}))">` : '<div class="ph"></div>'}
        <span class="badge ${isOff ? 'off' : ''}">${isOff ? 'Offline verfügbar' : f.format ? shortFormat(f.format) : '360°'}</span>
        <span class="playbig">${icon('play_arrow')}</span>
        ${uploadEnabled && navigator.onLine ? `<button class="srv-del" data-act="srv" aria-label="Vom Server löschen" title="Vom Server löschen">${icon('delete')}</button>` : ''}
      </div>
      <div class="meta">
        <div class="t"><b>${niceName(f.base)}</b><small>${fmtBytes(f.size)}</small></div>
        ${isOff ? `<button class="icon-btn" data-act="del" aria-label="Offline-Kopie löschen">${icon('delete')}</button>` : ''}
        <button class="cache-btn ${isOff ? 'done' : ''}" data-act="cache">
          ${icon(isOff ? 'check' : 'download')}<span class="lbl">${isOff ? 'Offline' : 'Offline speichern'}</span><span class="prog"></span>
        </button>
      </div>`;
    card.querySelector('.thumb').addEventListener('click', () => openPlayer(path, niceName(f.base), f));
    card.querySelector('[data-act=cache]').addEventListener('click', (e) => onCacheClick(e.currentTarget, path, f.size, isOff, posterPath, f.meta ? `/videos/${encodeURIComponent(f.meta.name)}` : null));
    card.querySelector('[data-act=del]')?.addEventListener('click', () => removeOffline(path, posterPath));
    card.querySelector('[data-act=srv]')?.addEventListener('click', (e) => { e.stopPropagation(); deleteFromServer(f, path, posterPath); });
    if (busy.has(path)) markBusy(card.querySelector('[data-act=cache]'), path);
    list.appendChild(card);
  }
  updateStorage();
}

function markBusy(btn, path) {
  btn.querySelector('.lbl').textContent = 'Abbrechen';
  btn.dataset.path = path;
}

async function onCacheClick(btn, path, size, isOff, posterPath, metaPath) {
  if (isOff) { toast('Schon offline gespeichert'); return; }
  if (busy.has(path)) { busy.get(path).abort(); return; }
  if (!navigator.onLine) { toast('Zum Speichern brauchst du Internet'); return; }
  try { await navigator.storage?.persist?.(); } catch {}
  if (navigator.storage?.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota && size && usage + size * 1.1 > quota) {
      toast(`Zu wenig Speicher: braucht ${fmtBytes(size)}, frei ca. ${fmtBytes(quota - usage)}`, 4200);
      return;
    }
  }
  const ctrl = new AbortController();
  busy.set(path, ctrl);
  const lbl = btn.querySelector('.lbl'); const prog = btn.querySelector('.prog');
  lbl.textContent = '0 %';
  try {
    const res = await fetch(path, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('Content-Length')) || size || 0;
    const reader = res.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (total) {
        const pct = Math.floor((got / total) * 100);
        lbl.textContent = `${pct} %`; prog.style.width = `${pct}%`;
      } else lbl.textContent = fmtBytes(got);
    }
    const type = res.headers.get('Content-Type') || 'video/mp4';
    const blob = new Blob(chunks, { type });
    const cache = await caches.open(VIDEO_CACHE);
    await cache.put(path, new Response(blob, { headers: {
      'Content-Type': type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' } }));
    if (posterPath) {
      try { const pr = await fetch(posterPath, { cache: 'no-store' }); if (pr.ok) await cache.put(posterPath, pr); } catch {}
    }
    if (metaPath) {
      try { const mr = await fetch(metaPath, { cache: 'no-store' }); if (mr.ok) await cache.put(metaPath, mr); } catch {}
    }
    toast('Gespeichert – läuft jetzt auch ohne Internet');
  } catch (e) {
    toast(e.name === 'AbortError' ? 'Abgebrochen' : `Speichern fehlgeschlagen (${e.message})`);
  } finally {
    busy.delete(path);
    loadList();
  }
}

async function removeOffline(path, posterPath) {
  const c = await caches.open(VIDEO_CACHE);
  await c.delete(path);
  if (posterPath) await c.delete(posterPath);
  toast('Offline-Kopie gelöscht');
  loadList();
}

/* ---------------- Hochladen ----------------
 * Videos gehen per PUT nach /upload/<name> und landen im Video-Ordner auf dem Server
 * (Docker-Volume). Dort bleiben sie, egal welche App-Updates kommen – bis man sie loescht.
 * Vor dem Hochladen wird geprueft, ob das Geraet das Video abspielen kann und ob es
 * ein 360°-Format ist (2:1, oder 3D: 1:1 uebereinander / 4:1 nebeneinander), und aus
 * einem Bild des Videos wird automatisch ein Vorschaubild gemacht.
 */
let uploadEnabled = false;
let uploadsRunning = 0;
let wakeLock = null;

async function initUpload() {
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    uploadEnabled = !!(await r.json()).upload;
  } catch { /* offline: Knopf bleibt aus */ }
  $('up-btn').hidden = !uploadEnabled;
}

const UMLAUT = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
function uploadName(file) {
  const ext = (/\.([^.]+)$/.exec(file.name)?.[1] || '').toLowerCase();
  if (!['mp4', 'm4v', 'webm', 'mov', 'mkv'].includes(ext)) return null;
  let base = file.name.replace(/\.[^.]+$/, '')
    .replace(/[äöüÄÖÜß]/g, (c) => UMLAUT[c])
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._ ()-]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '').replace(/[-. ]+$/, '')
    .slice(0, 120);
  if (!base) base = `Video-${new Date().toISOString().slice(0, 10)}`;
  let name = base, n = 2;
  while (serverNames.has(name.toLowerCase())) name = `${base}-${n++}`;
  serverNames.add(name.toLowerCase());
  return { base: name, video: `${name}.${ext}`, poster: `${name}.jpg`, meta: `${name}.json` };
}

// Video lokal oeffnen: Groesse, Abspielbarkeit, Vorschaubild
function analyze(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false, tries = 0;
    const finish = (info) => {
      if (done) return; done = true; clearTimeout(timer);
      v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
      resolve(info);
    };
    const timer = setTimeout(() => finish({ ok: false }), 25000);
    const metaP = metaFromFile(file);
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onloadedmetadata = () => {
      if (!v.videoWidth) { finish({ ok: false }); return; }
      v.currentTime = Math.min(2, (v.duration || 1) / 3);
    };
    v.onseeked = async () => {
      const w = v.videoWidth, h = v.videoHeight;
      const img = grabFrame(v);
      const frame = img ? fromFrame(img) : { f: fromSize(w, h), informative: false };
      // dunkles Bild (Abblende) -> etwas spaeter nochmal schauen
      if (!frame.informative && tries++ < 3 && v.duration > v.currentTime + 2) { v.currentTime += 3; return; }
      const nameF = fromName(file.name), metaF = await metaP;
      const format = combine(nameF, metaF, frame.f);
      const source = Object.keys(nameF).length ? 'Dateiname' : Object.keys(metaF).length ? 'Metadaten' : 'Bildanalyse';
      let canvas = null;
      try {
        if (format.kind === 'flat') {
          canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
          const ctx = canvas.getContext('2d'); const s = Math.max(1024 / w, 512 / h);
          ctx.drawImage(v, (1024 - w * s) / 2, (512 - h * s) / 2, w * s, h * s);
        } else canvas = renderPreview(v, format, 1024);
      } catch { canvas = null; }
      if (!canvas) { finish({ ok: true, w, h, dur: v.duration, format, source }); return; }
      canvas.toBlob((thumb) => finish({ ok: true, w, h, dur: v.duration, thumb, format, source }), 'image/jpeg', 0.82);
    };
    v.onerror = () => finish({ ok: false });
    v.src = url;
  });
}

function put(url, body, type, onProgress, item) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    if (type) x.setRequestHeader('Content-Type', type);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve()
      : reject(new Error(x.status === 413 ? 'Datei zu groß für den Server' : x.status === 403 ? 'Server erlaubt das Hochladen nicht' : `HTTP ${x.status}`)));
    x.onerror = () => reject(new Error('Verbindung abgebrochen'));
    x.onabort = () => reject(Object.assign(new Error('Abgebrochen'), { name: 'AbortError' }));
    if (item) item.abort = () => x.abort();
    x.send(body);
  });
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* nicht schlimm */ }
}

function uploadRow(title) {
  const box = $('uploads');
  const el = document.createElement('div');
  el.className = 'up-item';
  el.innerHTML = `<div class="up-head"><b></b><span class="up-pct">Prüfe…</span>
    <button class="icon-btn" aria-label="Abbrechen">${icon('close')}</button></div>
    <div class="bar"><div></div></div><small class="up-note"></small>`;
  el.querySelector('b').textContent = title;
  box.appendChild(el); box.hidden = false;
  return el;
}

/* Grosse Videos: 16-MB-Stuecke, 3 gleichzeitig. Bricht etwas ab (Netz weg, Handy
 * schlaeft, Seite zu), weiss der Server, welche Stuecke schon da sind. Solange die Seite
 * offen ist, wird endlos neu versucht; nach dem Schliessen einfach dieselbe Datei nochmal
 * auswaehlen – dann geht es an derselben Stelle weiter. */
const CHUNK = 16 * 1024 * 1024;
const PARALLEL = 3;
const PENDING_KEY = 'anja-pending-uploads';
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
const pendingAll = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || {}; } catch { return {}; } };
const pendingSet = (k, v) => { const all = pendingAll(); if (v) all[k] = v; else delete all[k]; try { localStorage.setItem(PENDING_KEY, JSON.stringify(all)); } catch {} };
const sleepers = new Set();
const wakeRetry = () => [...sleepers].forEach((f) => f());
addEventListener('online', () => wakeRetry());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { wakeRetry(); keepAwake(uploadsRunning > 0); } });

function sendChunk(url, body, onProgress, item) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.timeout = 180000;
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => {
      let data = {};
      try { data = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error === 'write' ? 'Server-Speicher voll?' : `HTTP ${x.status}`), { status: x.status, data }));
    };
    x.onerror = x.ontimeout = () => reject(Object.assign(new Error('Verbindung unterbrochen'), { status: 0 }));
    x.onabort = () => reject(Object.assign(new Error('Abgebrochen'), { name: 'AbortError' }));
    item.xhrs.add(x);
    x.addEventListener('loadend', () => item.xhrs.delete(x));
    x.send(body);
  });
}

async function uploadResumable(name, file, item, onProgress, onStatus) {
  const base = `/upload-chunk/${encodeURIComponent(name)}?total=${file.size}&chunk=${CHUNK}`;
  item.cleanup = () => fetch(base, { method: 'DELETE' }).catch(() => {});
  const n = Math.ceil(file.size / CHUNK);
  let st = {};
  for (let t = 0; ; t++) {
    try { const r = await fetch(base, { cache: 'no-store' }); st = await r.json(); break; }
    catch { if (item.cancelled) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' }); onStatus('Warte auf Verbindung…'); await sleep(Math.min(30000, 2000 * 2 ** t)); }
  }
  if (st.complete) return;
  if (st.exists) throw new Error('Eine andere Datei mit diesem Namen ist schon da');
  const done = new Set(st.have || []);
  const sizeOf = (i) => Math.min(CHUNK, file.size - i * CHUNK);
  let doneBytes = [...done].reduce((a, i) => a + sizeOf(i), 0);
  if (done.size) onStatus(`Mache weiter bei ${Math.floor((doneBytes / file.size) * 100)} %`);
  const queue = [...Array(n).keys()].filter((i) => !done.has(i));
  const inflight = new Map();
  const report = () => onProgress(doneBytes + [...inflight.values()].reduce((a, b) => a + b, 0), file.size);
  report();
  let finished = false;
  const worker = async () => {
    while (queue.length && !finished) {
      const i = queue.shift();
      for (let t = 0; ; t++) {
        if (item.cancelled) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
        try {
          inflight.set(i, 0);
          const res = await sendChunk(`${base}&index=${i}`, file.slice(i * CHUNK, i * CHUNK + sizeOf(i)), (b) => { inflight.set(i, b); report(); }, item);
          inflight.delete(i); doneBytes += sizeOf(i); report();
          if (res.done) finished = true;
          break;
        } catch (e) {
          inflight.delete(i); report();
          if (e.name === 'AbortError') throw e;
          if (e.status === 409) { if (e.data?.complete) { finished = true; break; } throw new Error('Eine andere Datei mit diesem Namen ist schon da'); }
          if (e.status === 400 || e.status === 507) throw e;
          // Netz weg / Handy im Hintergrund / Server kurz weg: warten und nochmal
          onStatus(navigator.onLine ? 'Verbindung unterbrochen – versuche erneut…' : 'Offline – geht weiter, sobald Internet da ist');
          await sleep(Math.min(30000, 1500 * 2 ** Math.min(t, 5)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length || 1) }, worker));
}

function sleep(ms) {
  return new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); sleepers.delete(done); res(); }
    sleepers.add(done); // bei "wieder online"/"wieder sichtbar"/Abbrechen sofort weiter
  });
}

// Tempo als gleitender Durchschnitt der letzten 8 Sekunden (nicht seit Start)
function speedMeter() {
  const pts = [];
  return (bytes) => {
    const now = Date.now();
    pts.push([now, bytes]);
    while (pts.length > 2 && now - pts[0][0] > 8000) pts.shift();
    const [t0, b0] = pts[0];
    return now - t0 > 500 ? Math.max(0, (bytes - b0) / ((now - t0) / 1000)) : 0;
  };
}

async function uploadFile(file) {
  const key = fileKey(file);
  const pend = pendingAll()[key];
  const names = pend?.names || uploadName(file);
  if (!names) { toast(`„${file.name}“: nur .mp4, .m4v, .webm, .mov oder .mkv`, 4000); return; }
  serverNames.add(names.base.toLowerCase());
  document.querySelector(`.up-item[data-key="${CSS.escape(key)}"]`)?.remove();
  const row = uploadRow(niceName(names.base));
  row.dataset.key = key;
  const item = { xhrs: new Set(), cancelled: false, cleanup: null };
  row.querySelector('button').addEventListener('click', () => {
    item.cancelled = true; item.xhrs.forEach((x) => x.abort()); wakeRetry(); item.cleanup?.(); pendingSet(key, null);
  });
  const pct = row.querySelector('.up-pct'), bar = row.querySelector('.bar > div'), note = row.querySelector('.up-note');
  uploadsRunning++; keepAwake(true);
  try {
    const info = await analyze(file);
    if (item.cancelled) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    if (!info.ok && !pend) {
      if (!confirm(`„${file.name}“ kann dieses Gerät nicht abspielen (evtl. HEVC/H.265).\nAuf anderen Geräten geht es vielleicht nicht. Trotzdem hochladen?`)) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    }
    const desc = info.ok ? `${info.w}×${info.h} · ${describe(info.format)} · ${fmtTime(info.dur)} · ${fmtBytes(file.size)}`
      : `Ohne Vorschaubild – Format hier nicht abspielbar · ${fmtBytes(file.size)}`;
    note.textContent = desc;
    pendingSet(key, { names, title: niceName(names.base), size: file.size, at: Date.now() });
    const speed = speedMeter();
    let statusUntil = 0;
    await uploadResumable(names.video, file, item, (got, total) => {
      const p = Math.floor((got / total) * 100);
      bar.style.width = `${p}%`;
      const rate = speed(got);
      const left = rate > 0 ? (total - got) / rate : 0;
      if (Date.now() > statusUntil) note.textContent = desc;
      pct.textContent = `${p} %${rate ? ` · ${fmtBytes(rate)}/s` : ''}${left > 5 ? ` · noch ${fmtTime(left)}` : ''}`;
    }, (msg) => { note.textContent = msg; statusUntil = Date.now() + 4000; });
    pendingSet(key, null);
    if (info.thumb) { try { await put(`/upload/${encodeURIComponent(names.poster)}`, info.thumb, 'image/jpeg'); } catch {} }
    // erkanntes Format gleich mitspeichern, dann sieht es auf allen Geraeten sofort richtig aus
    if (info.format) {
      try { await put(`/upload/${encodeURIComponent(names.meta)}`, JSON.stringify({ format: info.format, source: `Beim Hochladen (${info.source})` }), 'application/json'); } catch {}
    }
    pct.textContent = 'Fertig'; bar.style.width = '100%'; row.classList.add('done'); note.textContent = desc;
    toast(`„${niceName(names.base)}“ ist jetzt auf dem Server`);
    setTimeout(() => { row.remove(); if (!$('uploads').children.length) $('uploads').hidden = true; }, 2500);
  } catch (e) {
    if (e.name === 'AbortError') { serverNames.delete(names.base.toLowerCase()); row.remove(); toast('Hochladen abgebrochen'); }
    else { row.classList.add('err'); pct.textContent = 'Fehler'; note.textContent = e.message;
      row.querySelector('button').onclick = () => row.remove(); }
    if (!$('uploads').children.length) $('uploads').hidden = true;
  } finally {
    uploadsRunning--; if (!uploadsRunning) keepAwake(false);
    loadList();
  }
}

// Unterbrochene Uploads von frueher anzeigen – gleiche Datei auswaehlen = weitermachen
async function showPending() {
  const all = pendingAll();
  for (const [key, p] of Object.entries(all)) {
    if (Date.now() - p.at > 7 * 864e5) { pendingSet(key, null); continue; }
    if (document.querySelector(`.up-item[data-key="${CSS.escape(key)}"]`)) continue;
    let st = null;
    try { st = await (await fetch(`/upload-chunk/${encodeURIComponent(p.names.video)}?total=${p.size}&chunk=${CHUNK}`, { cache: 'no-store' })).json(); } catch {}
    if (st?.complete) { pendingSet(key, null); continue; }
    const row = uploadRow(p.title);
    row.dataset.key = key; row.classList.add('paused');
    const got = Math.min(p.size, (st?.have?.length || 0) * CHUNK);
    row.querySelector('.bar > div').style.width = `${Math.floor((got / p.size) * 100)}%`;
    row.querySelector('.up-pct').textContent = `${Math.floor((got / p.size) * 100)} % · pausiert`;
    row.querySelector('.up-note').innerHTML = 'Unterbrochen. <button class="link">Gleiche Datei wählen</button> – es geht dort weiter, wo es aufgehört hat.';
    row.querySelector('.link').addEventListener('click', () => $('up-file').click());
    row.querySelector('button.icon-btn').addEventListener('click', () => {
      fetch(`/upload-chunk/${encodeURIComponent(p.names.video)}?total=${p.size}&chunk=${CHUNK}`, { method: 'DELETE' }).catch(() => {});
      pendingSet(key, null); row.remove(); if (!$('uploads').children.length) $('uploads').hidden = true;
    });
  }
}

async function uploadFiles(files) {
  if (!uploadEnabled) { toast('Hochladen ist auf diesem Server aus'); return; }
  for (const f of files) await uploadFile(f); // nacheinander; jede Datei selbst laeuft in 3 Stuecken parallel
}

$('up-btn').addEventListener('click', () => $('up-file').click());
$('up-file').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; uploadFiles(fs); });
addEventListener('dragover', (e) => { if (uploadEnabled && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); document.body.classList.add('drop'); } });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
addEventListener('drop', (e) => {
  document.body.classList.remove('drop');
  if (!uploadEnabled || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  if (!$('player').hidden) return;
  uploadFiles([...e.dataTransfer.files]);
});
addEventListener('beforeunload', (e) => { if (uploadsRunning) { e.preventDefault(); e.returnValue = ''; } });

async function deleteFromServer(f, path, posterPath) {
  if (!confirm(`„${niceName(f.base)}“ endgültig vom Server löschen?\nDas Video ist danach auf allen Geräten weg.`)) return;
  for (const name of f.all) {
    const r = await fetch(`/upload/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => null);
    if (!r || (!r.ok && r.status !== 404)) {
      toast(r?.status === 403 ? 'Diese Datei lässt sich nur direkt auf dem Server löschen (Sonderzeichen im Namen)' : 'Löschen fehlgeschlagen', 4200);
      loadList(); return;
    }
  }
  const c = await caches.open(VIDEO_CACHE);
  await c.delete(path); if (posterPath) await c.delete(posterPath);
  toast('Vom Server gelöscht');
  loadList();
}

/* ---------------- Raum-Modus ----------------
 * Durchsicht ohne Video: Wuerfel in den echten Raum stellen. Sie bleiben im Raum stehen,
 * auch wenn man herumlaeuft, und bewegen sich nur, wenn man sie greift.
 */
let room = null;
navigator.xr?.isSessionSupported?.('immersive-ar').then((ok) => { $('room-btn').hidden = !ok; }).catch(() => {});
$('room-btn').addEventListener('click', async () => {
  if (room) return;
  const { Room } = await import('/room.js');
  const stage = $('room-stage'), ov = $('room-overlay');
  stage.hidden = false; ov.hidden = false;
  room = new Room(stage);
  const close = () => { room?.dispose(); room = null; stage.hidden = true; ov.hidden = true; };
  room.onEnd = close;
  try {
    const sess = await room.start(ov);
    if (!sess.domOverlayState) ov.hidden = true;   // Brille: dort gibt es die schwebende Werkzeugleiste
  } catch (e) { close(); toast(`Raum-Modus ging nicht (${e.message})`, 4000); }
});
$('room-overlay').addEventListener('beforexrselect', (e) => { if (e.target.closest('button')) e.preventDefault(); });
$('ro-exit').addEventListener('click', () => room?.end());
$('ro-add').addEventListener('click', () => room?.addInFront());
$('ro-undo').addEventListener('click', () => room?.undo());
$('ro-clear').addEventListener('click', () => room?.clear());

/* ---------------- Player ---------------- */
let viewer = null, video = null;

/* ---------------- Videoformat ----------------
 * Reihenfolge: gespeichert (.json neben dem Video, gilt fuer alle Geraete) > auf diesem
 * Geraet gemerkt > Dateiname > Metadaten im Video > Bildanalyse > Seitenverhaeltnis.
 */
async function loadSidecarRaw(name) {
  try {
    const r = await fetch(`/videos/${encodeURIComponent(name)}`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function loadSidecar(name) {
  try {
    const r = await fetch(`/videos/${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.format ? normalize(j.format) : null;
  } catch { return null; }
}

function shortFormat(f) {
  f = normalize(f);
  const base = { equirect360: '360°', equirect180: '180°', fisheye: '180° Fischauge', dfisheye: '360°',
    eac: '360°', c3x2: '360°', c6x1: '360°', c1x6: '360°', flat: 'Leinwand' }[f.kind];
  return f.stereo === 'mono' ? base : `${base} 3D`;
}

let fmtCtx = null; // { src, item, manual, timer }

async function detectFormat(src, item) {
  const ctx = fmtCtx = { src, item, manual: false };
  const local = (() => { try { return JSON.parse(localStorage.getItem(`anja-format:${src}`)); } catch { return null; } })();
  const side = item?.meta ? await loadSidecar(item.meta.name) : null;
  if (ctx !== fmtCtx || !viewer) return;
  if (side) { viewer.setFormat(side, 'Gespeichert (für alle)'); return; }
  if (local) { viewer.setFormat(local, 'Auf diesem Gerät gemerkt'); return; }
  const nameF = fromName(decodeURIComponent(src.split('/').pop()));
  const metaF = await metaFromUrl(src);
  if (ctx !== fmtCtx || !viewer || ctx.manual) return;
  const label = () => [Object.keys(nameF).length && 'Dateiname', Object.keys(metaF).length && 'Metadaten'].filter(Boolean);
  const apply = (frameF, how) => {
    if (ctx !== fmtCtx || !viewer || ctx.manual) return;
    viewer.setFormat(combine(nameF, metaF, frameF), [...label(), how].filter(Boolean).join(' + ') || how);
  };
  const v = viewer.video;
  if (v.videoWidth) apply(fromSize(v.videoWidth, v.videoHeight), 'Seitenverhältnis');
  // Bildanalyse, sobald ein aussagekraeftiges Bild da ist (nicht das schwarze erste)
  let tries = 0;
  const look = () => {
    if (ctx !== fmtCtx || !viewer || ctx.manual) return;
    const img = grabFrame(v);
    const fr = img ? fromFrame(img) : null;
    if (fr && (fr.informative || tries >= 6)) apply(fr.f, 'Bildanalyse');
    else if (tries++ < 6) ctx.timer = setTimeout(look, 1200);
  };
  ctx.timer = setTimeout(look, v.readyState >= 2 ? 600 : 1500);
}

function fillFormatPanel(f, source) {
  f = normalize(f);
  $('fp-kind').value = f.kind; $('fp-stereo').value = f.stereo; $('fp-swap').checked = f.swap;
  const needsFov = ['fisheye', 'dfisheye', 'flat'].includes(f.kind);
  $('fp-fov-row').hidden = !needsFov;
  $('fp-fov').value = f.fov || defaultFov(f.kind);
  $('fp-fov-val').textContent = `${$('fp-fov').value}°`;
  $('fp-swap-row').hidden = f.stereo === 'mono';
  $('fp-src').textContent = `Erkannt über: ${source}`;
  $('fp-save').hidden = !uploadEnabled || !navigator.onLine;
}

(() => {
  $('fp-kind').innerHTML = Object.entries(PROJ_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('fp-stereo').innerHTML = Object.entries(STEREO_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
})();

function formatFromPanel() {
  const kind = $('fp-kind').value;
  return normalize({ kind, stereo: $('fp-stereo').value, swap: $('fp-swap').checked,
    fov: ['fisheye', 'dfisheye', 'flat'].includes(kind) ? Number($('fp-fov').value) : 0 });
}

function onFormatInput(e) {
  if (!viewer) return;
  if (fmtCtx) { fmtCtx.manual = true; clearTimeout(fmtCtx.timer); }
  // neue Projektion -> passenden Standard-Blickwinkel nehmen
  if (e?.target?.id === 'fp-kind') $('fp-fov').value = defaultFov($('fp-kind').value) || $('fp-fov').value;
  const f = formatFromPanel();
  viewer.setFormat(f, 'Manuell');
  try { localStorage.setItem(`anja-format:${fmtCtx?.src}`, JSON.stringify(f)); } catch {}
}
for (const id of ['fp-kind', 'fp-stereo', 'fp-swap', 'fp-fov']) $(id).addEventListener('input', onFormatInput);
$('p-fmt').addEventListener('click', () => {
  if (openPanel('fmt-panel') && viewer) fillFormatPanel(viewer.format, viewer.formatSource);
});
$('fp-close').addEventListener('click', () => { $('fmt-panel').hidden = true; });
$('fp-save').addEventListener('click', async () => {
  const item = fmtCtx?.item;
  if (!item || !viewer) return;
  const base = item.name.replace(/\.[^.]+$/, '');
  try {
    const old = item.meta ? await loadSidecarRaw(item.meta.name) : null;
    await put(`/upload/${encodeURIComponent(`${base}.json`)}`, JSON.stringify({ ...old, format: viewer.format, source: 'Manuell gespeichert' }), 'application/json');
    item.meta = { name: `${base}.json` };
    viewer.setFormat(viewer.format, 'Gespeichert (für alle)');
    toast('Format gespeichert – gilt jetzt auf allen Geräten');
  } catch (e) { toast(`Speichern ging nicht (${e.message})`, 4000); }
});
$('fp-auto').addEventListener('click', async () => {
  const item = fmtCtx?.item, src = fmtCtx?.src;
  if (!viewer || !src) return;
  try { localStorage.removeItem(`anja-format:${src}`); } catch {}
  if (item?.meta && uploadEnabled && navigator.onLine) {
    // nur das Format vergessen – eine gespeicherte Greenscreen-Einstellung bleibt
    const old = await loadSidecarRaw(item.meta.name);
    if (old?.chroma) await put(`/upload/${encodeURIComponent(item.meta.name)}`, JSON.stringify({ chroma: old.chroma }), 'application/json').catch(() => {});
    else { await fetch(`/upload/${encodeURIComponent(item.meta.name)}`, { method: 'DELETE' }).catch(() => {}); item.meta = null; }
  }
  viewer.formatSource = 'Standard';
  await detectFormat(src, item);
  toast('Format wird automatisch erkannt');
});

async function openPlayer(src, title, item = null) {
  const { Viewer } = await import('/viewer.js');
  $('p-title').textContent = title;
  $('player').hidden = false;
  $('home').hidden = true;

  video = document.createElement('video');
  video.src = src;
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.loop = true;
  video.preload = 'auto';

  viewer = new Viewer($('stage'), video, { title });
  viewer.onFormat = (f, source) => { if (!$('fmt-panel').hidden) fillFormatPanel(f, source); };
  // Lage/Groesse pro Video merken
  const poseKey = `anja-pose:${src}`;
  try { const ps = JSON.parse(localStorage.getItem(poseKey)); if (ps) viewer.setPose(ps, true); } catch {}
  viewer.onPose = (p) => { try { localStorage.setItem(poseKey, JSON.stringify(p)); } catch {} if (!$('pos-panel').hidden) syncPosUI(p); };
  viewer.onHands = (on) => { if (on !== (handCfg.mode === 'xr')) { handCfg.mode = on ? 'xr' : 'off'; saveHandCfg(); if (handCfg.mode !== 'band') stopBand(); syncHandUI(); } };
  viewer.renderer.xr.addEventListener('sessionstart', () => { viewer?.setHole(null); $('band-mark').hidden = true; syncHandUI(); });
  viewer.onBandStatus = (t) => { if (handCfg.mode === 'band') $('hp-status').textContent = t; };
  // Im VR-Menue schaltet "Hände" durch: Aus -> Hand-Tracking -> Band -> Aus
  viewer.handsLabel = () => ({ off: 'Hände', xr: 'Hände: Tracking', band: 'Hände: Band' })[handCfg.mode];
  viewer.onHandsCycle = () => {
    handCfg.mode = { off: 'xr', xr: 'band', band: 'off' }[handCfg.mode] || 'off';
    saveHandCfg(); applyHandMode();
  };
  // Kamera wird gebraucht (z. B. Band in VR eingeschaltet): starten und dem Viewer geben
  viewer.onNeedCamera = async () => { if (handCfg.mode === 'band' && !camStream) { await startBand(); syncHandUI(); } };
  viewer.renderer.xr.addEventListener('sessionend', syncHandUI);
  applyHandMode();
  detectFormat(src, item);
  const hint = $('tap-hint'); hint.classList.remove('gone');
  viewer.onInteract = () => hint.classList.add('gone');
  setTimeout(() => hint.classList.add('gone'), 4000);

  // Greenscreen-Einstellungen: auf diesem Geraet gemerkt > fuer alle gespeichert > Standard.
  // Dateiname mit "green"/"chroma" schaltet es gleich an (Farbe wird dann automatisch gesucht).
  chromaKey = `anja-chroma:${src}`;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(chromaKey)); } catch {}
  if (saved && saved.hue === undefined) saved = { on: saved.on, color: saved.color }; // alte Einstellungen
  const side = item?.meta ? await loadSidecarRaw(item.meta.name) : null;
  const preset = saved || side?.chroma || null;
  viewer.setChroma({ ...CHROMA_DEFAULT, on: /green|gruen|grün|chroma|keying/i.test(decodeURIComponent(src)), ...preset, mask: false });
  viewer.onChroma = (st) => {
    try { localStorage.setItem(chromaKey, JSON.stringify({ ...st, mask: false })); } catch {}
    syncKeyUI(st);
  };
  syncKeyUI(viewer.chromaState());
  if (viewer.chromaState().on && !preset) autoKeyWhenReady(false);

  // Durchsicht (AR): Quest-Passthrough bzw. Handy-Kamera mit Raumerkennung
  const arSlot = $('ar-slot'); arSlot.innerHTML = '';
  navigator.xr?.isSessionSupported?.('immersive-ar').then((ok) => {
    if (!ok || !viewer) return;
    const b = document.createElement('button');
    b.className = 'vr-btn glass';
    b.innerHTML = `${icon('ar')}<span>Durchsicht</span>`;
    b.addEventListener('click', async () => {
      try {
        // Durchsicht braucht die Kamera selbst: normale Kamera vorher freigeben,
        // das rote Band bekommt das Bild dann direkt von der Durchsicht
        const hadBand = handCfg.mode === 'band';
        const androidPhone = /Android/.test(navigator.userAgent) && !/OculusBrowser|Quest|Pico/i.test(navigator.userAgent);
        if (camStream && androidPhone) { stopBand(); camStream.getTracks().forEach((tr) => tr.stop()); camStream = null; $('cam-bg')?.remove(); $('kp-cam').checked = false; }
        if (hadBand && androidPhone) viewer.setBand({ on: true, video: null });
        const ov = $('xr-overlay');
        ov.hidden = false;
        syncOverlay();
        const sess = await viewer.startAR(ov);
        if (!sess.domOverlayState) ov.hidden = true;   // Brille: dort gibt es das 3D-Menue
        sess.addEventListener('end', () => { ov.hidden = true; if (handCfg.mode === 'band') startBand().then(syncHandUI); });
        b.disabled = true;
        sess.addEventListener('end', () => { b.disabled = false; });
      } catch (e) { $('xr-overlay').hidden = true; toast(`Durchsicht ging nicht (${e.message})`, 4000); }
    });
    arSlot.appendChild(b);
  }).catch(() => {});

  $('p-gyro').hidden = !('DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches);
  const slot = $('vr-slot'); slot.innerHTML = '';
  // VR-Knopf nur zeigen, wenn das Geraet (z. B. eine VR-Brille) WebXR wirklich kann
  navigator.xr?.isSessionSupported?.('immersive-vr').then((ok) => {
    if (!ok || !viewer) return;
    const b = viewer.vrButton();
    const label = () => { b.innerHTML = `${icon('vr')}<span>${/EXIT/i.test(b.textContent) ? 'VR beenden' : 'VR'}</span>`; };
    new MutationObserver(() => { if (!b.querySelector('svg')) label(); }).observe(b, { childList: true, characterData: true, subtree: true });
    label();
    slot.appendChild(b);
  }).catch(() => {});

  const v = video; // Ereignisse nach dem Schliessen (video = null) ignorieren
  video.addEventListener('loadedmetadata', () => { if (video === v) $('p-dur').textContent = fmtTime(v.duration); });
  video.addEventListener('timeupdate', () => {
    if (video !== v) return;
    $('p-time').textContent = fmtTime(video.currentTime);
    if (!seeking && video.duration) $('p-seek').value = Math.round((video.currentTime / video.duration) * 1000);
  });
  video.addEventListener('play', () => { setIcon($('p-play'), 'pause'); syncOverlay(); });
  video.addEventListener('pause', () => { setIcon($('p-play'), 'play_arrow'); syncOverlay(); });
  video.addEventListener('error', () => video === v && toast(navigator.onLine ? 'Video konnte nicht geladen werden' : 'Dieses Video ist nicht offline gespeichert'));

  try { await video.play(); } catch { /* Browser will erst einen Tipp */ }
  history.pushState({ player: true }, '');
}

function closePlayer() {
  if (!viewer) return;
  if (viewer.inXR) viewer.endXR();
  $('xr-overlay').hidden = true;
  stopBand(); stopCam(); setPicking(false);
  for (const p of PANELS) $(p).hidden = true;
  if (fmtCtx) { clearTimeout(fmtCtx.timer); fmtCtx = null; }
  viewer.onChroma = null;
  video.pause(); video.removeAttribute('src'); video.load();
  viewer.dispose(); viewer = null; video = null;
  $('p-gyro').classList.remove('on');
  setIcon($('p-play'), 'play_arrow');
  $('p-seek').value = 0; $('p-time').textContent = '0:00';
  $('player').hidden = true; $('home').hidden = false;
}

let seeking = false;
$('p-seek').addEventListener('input', () => {
  seeking = true;
  if (video?.duration) $('p-time').textContent = fmtTime((($('p-seek').value) / 1000) * video.duration);
});
$('p-seek').addEventListener('change', () => {
  if (video?.duration) video.currentTime = ($('p-seek').value / 1000) * video.duration;
  seeking = false;
});
$('p-play').addEventListener('click', () => { if (!video) return; video.paused ? video.play() : video.pause(); });
$('p-mute').addEventListener('click', () => {
  if (!video) return; video.muted = !video.muted;
  setIcon($('p-mute'), video.muted ? 'volume_off' : 'volume_up');
});
/* ---------------- Position & Groesse ----------------
 * Groesse (kleiner = weiter weg / "rauszoomen"), Drehen, Neigen, Kippen – pro Video gemerkt.
 */
const PANELS = ['fmt-panel', 'key-panel', 'pos-panel', 'hand-panel'];
function openPanel(id) {
  for (const p of PANELS) if (p !== id) $(p).hidden = true;
  const el = $(id); el.hidden = !el.hidden;
  return !el.hidden;
}
const POS_FMT = { size: (v) => `${Math.round(v * 100)} %`, yaw: (v) => `${Math.round(v)}°`, pitch: (v) => `${Math.round(v)}°`, roll: (v) => `${Math.round(v)}°` };
function syncPosUI(p) {
  for (const [k, f] of Object.entries(POS_FMT)) { $(`pp-${k}`).value = p[k]; $(`pv-${k}`).textContent = f(Number(p[k])); }
  if (viewer) { $('pp-fov').value = Math.round(viewer.fov); $('pv-fov').textContent = `${Math.round(viewer.fov)}°`; }
}
$('p-pos').addEventListener('click', () => { if (openPanel('pos-panel') && viewer) syncPosUI(viewer.pose); });
$('pp-close').addEventListener('click', () => { $('pos-panel').hidden = true; });
for (const k of Object.keys(POS_FMT)) $(`pp-${k}`).addEventListener('input', (e) => viewer?.setPose({ [k]: Number(e.target.value) }));
$('pp-fov').addEventListener('input', (e) => { if (!viewer) return; viewer._zoom(Number(e.target.value) - viewer.fov); syncPosUI(viewer.pose); });
$('pp-center').addEventListener('click', () => { if (!viewer) return; viewer.inXR ? viewer._recenterXR() : viewer.recenter(); });
$('pp-reset').addEventListener('click', () => { if (!viewer) return; viewer.setPose({ yaw: 0, pitch: 0, roll: 0, size: 1 }); viewer._zoom(75 - viewer.fov); viewer.recenter(); syncPosUI(viewer.pose); });

/* ---------------- Haende ----------------
 * Hand-Tracking: in der Brille (VR/Durchsicht) zeigt der Browser deine Haende;
 *   in der Durchsicht werden sie aus dem Video ausgeschnitten -> echte Haende sichtbar.
 * Rotes Band: am Handy sucht die Kamera ein rotes Band (z. B. am Handgelenk) und macht
 *   das Video dort durchsichtig, damit man die echte Hand sieht.
 */
const HAND_KEY = 'anja-hands';
const HAND_DEFAULT = { mode: 'off', size: 5, sens: 0.5, mark: false, fov: 70 };
const handCfg = (() => { try { return { ...HAND_DEFAULT, ...JSON.parse(localStorage.getItem(HAND_KEY)) }; } catch { return { ...HAND_DEFAULT }; } })();
const saveHandCfg = () => { try { localStorage.setItem(HAND_KEY, JSON.stringify(handCfg)); } catch {} };
let band = null;

function syncHandUI() {
  document.querySelectorAll('input[name=hp-mode]').forEach((r) => { r.checked = r.value === handCfg.mode; });
  $('p-hands').classList.toggle('on', handCfg.mode !== 'off');
  $('hp-band').hidden = handCfg.mode !== 'band';
  $('hp-size').value = handCfg.size; $('hv-size').textContent = `${handCfg.size.toFixed(1)}×`;
  const col = handCfg.color;
  $('hv-color').style.background = `hsl(${(col || BAND_DEFAULT).hue} 85% 50%)`;
  $('hv-color-txt').textContent = col ? `angelernt (${col.hue}°)` : 'Standard Rot';
  $('hp-sens').value = handCfg.sens; $('hv-sens').textContent = `${Math.round(handCfg.sens * 100)} %`;
  $('hp-mark').checked = handCfg.mark;
  $('hp-fov').value = handCfg.fov; $('hv-fov').textContent = `${handCfg.fov}°`;
  viewer?.setBand({ on: handCfg.mode === 'band', size: handCfg.size, sens: handCfg.sens, fov: handCfg.fov, color: handCfg.color || BAND_DEFAULT, video: $('cam-bg') || null });
  if (handCfg.mode === 'xr') $('hp-status').textContent = viewer?.inXR ? 'Hände werden in der Brille angezeigt.' : 'Starte VR oder Durchsicht – dann siehst du deine Hände (Controller ablegen).';
  else if (handCfg.mode === 'off') $('hp-status').textContent = '';
}

async function applyHandMode() {
  if (!viewer) return;
  viewer.setHands(handCfg.mode === 'xr');
  if (handCfg.mode === 'band') await startBand(); else stopBand();
  syncHandUI();
}

$('p-hands').addEventListener('click', () => { if (openPanel('hand-panel')) syncHandUI(); });
$('hp-close').addEventListener('click', () => { $('hand-panel').hidden = true; });
document.querySelectorAll('input[name=hp-mode]').forEach((r) => r.addEventListener('change', () => {
  handCfg.mode = r.value; saveHandCfg(); applyHandMode();
}));
$('hp-size').addEventListener('input', (e) => { handCfg.size = Number(e.target.value); saveHandCfg(); syncHandUI(); });
$('hp-sens').addEventListener('input', (e) => { handCfg.sens = Number(e.target.value); saveHandCfg(); syncHandUI(); });
$('hp-mark').addEventListener('change', (e) => { handCfg.mark = e.target.checked; saveHandCfg(); });
$('hp-fov').addEventListener('input', (e) => { handCfg.fov = Number(e.target.value); saveHandCfg(); syncHandUI(); });

async function startBand() {
  if (band) return;
  if (!camStream) await startCam();
  if (!camStream) { handCfg.mode = 'off'; saveHandCfg(); syncHandUI(); return; }
  $('kp-cam').checked = true;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  band = { c, ctx, prev: null, lost: 0, raf: 0, vfc: 0, fx: new OneEuro(), fy: new OneEuro(), fr: new OneEuro(0.8, 2) };
  // jedes neue Kamerabild auswerten (requestVideoFrameCallback), sonst jeden Bildschirm-Frame
  const schedule = () => {
    if (!band) return;
    const v = $('cam-bg');
    if (v?.requestVideoFrameCallback) band.vfc = v.requestVideoFrameCallback(() => { step(); schedule(); });
    else band.raf = requestAnimationFrame(() => { step(); schedule(); });
  };
  const step = () => {
    const v = $('cam-bg');
    if (!band || !v || v.readyState < 2 || !viewer || viewer.inXR) return;   // in der Brille uebernimmt der Viewer
    const vw = v.videoWidth, vh = v.videoHeight;
    const cw = 240, ch = Math.max(1, Math.round((240 * vh) / vw));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    ctx.drawImage(v, 0, 0, cw, ch);
    band.last = { data: ctx.getImageData(0, 0, cw, ch).data, w: cw, h: ch };
    const r = findBand(band.last.data, cw, ch, handCfg.color || BAND_DEFAULT, handCfg.sens, false, band.prev);
    if (!r) {
      if (++band.lost > 8) {
        band.prev = null; band.fx.reset(); band.fy.reset(); band.fr.reset();
        viewer.setHole(null); $('band-mark').hidden = true; $('hp-status').textContent = 'Kein Band im Bild.';
      }
      return;
    }
    band.lost = 0; band.prev = r;
    const t = performance.now();
    const x = band.fx.filter(r.x, t), y = band.fy.filter(r.y, t), rr = band.fr.filter(r.r, t);
    // Kamerabild-Koordinaten -> Bildschirm (Kamerabild ist "cover" eingepasst)
    const rect = $('stage').getBoundingClientRect();
    const sc = Math.max(rect.width / vw, rect.height / vh);
    const ox = (rect.width - vw * sc) / 2, oy = (rect.height - vh * sc) / 2;
    const pos = { x: rect.left + ox + x * vw * sc, y: rect.top + oy + y * vh * sc, r: rr * vw * sc * handCfg.size };
    viewer.setHole(pos);
    const m = $('band-mark');
    m.hidden = !handCfg.mark;
    if (handCfg.mark) {
      const br = rr * vw * sc;   // Groesse des Bands selbst
      Object.assign(m.style, { left: `${pos.x - rect.left}px`, top: `${pos.y - rect.top}px`, width: `${br * 2}px`, height: `${br * 2}px` });
    }
    $('hp-status').textContent = 'Band erkannt – das Video ist dort durchsichtig.';
  };
  schedule();
}
// Farbe des Bands uebernehmen: Band in die Bildmitte halten und tippen
$('hp-learn').addEventListener('click', async () => {
  if (handCfg.mode !== 'band') { handCfg.mode = 'band'; saveHandCfg(); await applyHandMode(); }
  setTimeout(() => {
    const l = band?.last;
    const col = l && learnBand(l.data, l.w, l.h, 0.5, 0.5, 0.22);
    if (!col) { toast('Kein farbiges Band in der Bildmitte gefunden'); return; }
    handCfg.color = col; saveHandCfg(); syncHandUI();
    toast(`Band-Farbe übernommen (Farbton ${col.hue}°)`);
  }, 300);
});
$('hp-unlearn').addEventListener('click', () => { delete handCfg.color; saveHandCfg(); syncHandUI(); toast('Standardfarbe Rot'); });
function stopBand() {
  if (!band) return;
  cancelAnimationFrame(band.raf);
  try { $('cam-bg')?.cancelVideoFrameCallback?.(band.vfc); } catch {}
  band = null;
  viewer?.setHole(null); $('band-mark').hidden = true;
}
$('p-gyro').addEventListener('click', async () => {
  if (!viewer) return;
  const on = await viewer.setGyro(!viewer.gyro);
  $('p-gyro').classList.toggle('on', on);
  if (!on && !viewer.gyro) toast('Bewegungssensor aus');
  else toast('Bewegungssensor an – Handy bewegen zum Umschauen');
});
/* ---------------- Greenscreen ----------------
 * Gruene Stellen im Video werden durchsichtig. Dahinter ist dann:
 *  - in der Brille mit "Durchsicht": dein Zimmer (Passthrough-Kamera der Brille)
 *  - am Handy mit "Handy-Kamera dahinter": das Bild der Rueckkamera
 *  - sonst schwarz
 */
let chromaKey = '';
let camStream = null;
let picking = false;
const KEY_SLIDERS = { hue: (v) => `${v}°`, sat: (v) => `${Math.round(v * 200)} %`, soft: (v) => `${Math.round(v * 100)} %`,
  choke: (v) => `${v} px`, spill: (v) => `${Math.round(v * 100)} %`, lumMin: (v) => `${Math.round(v * 100)} %`, lumMax: (v) => `${Math.round(v * 100)} %` };

function syncKeyUI(st) {
  $('p-key').classList.toggle('on', st.on);
  $('kp-on').checked = st.on; $('kp-mask').checked = st.mask;
  $('kp-color').value = st.color;
  for (const [k, f] of Object.entries(KEY_SLIDERS)) { $(`kp-${k}`).value = st[k]; $(`kv-${k}`).textContent = f(Number(st[k])); }
}

// Schluesselfarbe automatisch aus dem aktuellen Bild suchen
async function autoKeyNow(showToast = true) {
  if (!viewer) return false;
  const img = grabFrame(viewer.video, 320);
  const k = img && autoKey(img);
  if (!k) { if (showToast) toast('Keine deutliche Hintergrundfarbe gefunden – nimm die Pipette'); return false; }
  viewer.setChroma({ on: true, color: k.color, hue: k.hue, sat: k.sat });
  if (showToast) toast(`Hintergrundfarbe ${k.color} gefunden`);
  return true;
}
function autoKeyWhenReady(showToast) {
  let tries = 0;
  const go = () => { if (!viewer) return; const img = grabFrame(viewer.video, 64); const ok = img && fromFrame(img).informative;
    if (ok || tries > 8) autoKeyNow(showToast); else { tries++; setTimeout(go, 800); } };
  setTimeout(go, 800);
}

$('p-key').addEventListener('click', () => {
  openPanel('key-panel');
  $('kp-cam-row').hidden = !navigator.mediaDevices?.getUserMedia;
  $('kp-save').hidden = !uploadEnabled || !navigator.onLine;
});
$('kp-close').addEventListener('click', () => { $('key-panel').hidden = true; setPicking(false); viewer?.setChroma({ mask: false }); });
$('kp-on').addEventListener('change', (e) => {
  viewer?.setChroma({ on: e.target.checked });
  // zum ersten Mal an und noch reine Standardfarbe? -> Farbe selbst suchen
  if (e.target.checked && viewer?.chromaState().color === CHROMA_DEFAULT.color) autoKeyNow(true);
});
$('kp-mask').addEventListener('change', (e) => viewer?.setChroma({ mask: e.target.checked, on: true }));
$('kp-color').addEventListener('input', (e) => viewer?.setChroma({ color: e.target.value, on: true }));
$('kp-auto').addEventListener('click', () => autoKeyNow(true));
for (const k of Object.keys(KEY_SLIDERS)) {
  $(`kp-${k}`).addEventListener('input', (e) => viewer?.setChroma({ [k]: Number(e.target.value), on: true }));
}
$('kp-reset').addEventListener('click', () => { viewer?.setChroma({ ...CHROMA_DEFAULT, on: true }); autoKeyNow(false); });
$('kp-save').addEventListener('click', async () => {
  const item = fmtCtx?.item;
  if (!item || !viewer) return;
  const base = item.name.replace(/\.[^.]+$/, '');
  const old = item.meta ? await loadSidecarRaw(item.meta.name) : null;
  try {
    await put(`/upload/${encodeURIComponent(`${base}.json`)}`, JSON.stringify({ ...old, format: old?.format || viewer.format,
      chroma: { ...viewer.chromaState(), mask: false } }), 'application/json');
    item.meta = { name: `${base}.json` };
    toast('Greenscreen-Einstellung gespeichert – gilt auf allen Geräten');
  } catch (e) { toast(`Speichern ging nicht (${e.message})`, 4000); }
});

function setPicking(on) {
  picking = on;
  $('stage').classList.toggle('picking', on);
  $('kp-pick').classList.toggle('pill-accent', on);
  $('kp-hint').textContent = on ? 'Tippe im Video auf das Grün' : '';
}
$('kp-pick').addEventListener('click', () => setPicking(!picking));
// Pipette faengt den Tipp ab, bevor der Viewer ihn als Ziehen nimmt
$('stage').addEventListener('pointerdown', (e) => {
  if (!picking || !viewer) return;
  e.stopPropagation(); e.preventDefault();
  const c = viewer.pickColor(e.clientX, e.clientY);
  setPicking(false);
  if (c) { viewer.setChroma({ color: c, on: true }); toast(`Farbe ${c} wird durchsichtig`); }
  else toast('Farbe konnte nicht gelesen werden');
}, true);

async function startCam() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    toast(location.protocol === 'https:' || location.hostname === 'localhost'
      ? 'Kein Zugriff auf die Kamera' : 'Kamera geht nur über HTTPS', 4000);
    $('kp-cam').checked = false; return;
  }
  const v = document.createElement('video');
  v.id = 'cam-bg'; v.className = 'cam-bg';
  v.muted = true; v.playsInline = true; v.setAttribute('playsinline', '');
  v.srcObject = camStream;
  $('stage').prepend(v);
  v.play().catch(() => {});
  if (!viewer.chromaState().on) viewer.setChroma({ on: true });
  // Kamera + Bewegungssensor = das Video "steht" im Raum
  if (!viewer.gyro && !$('p-gyro').hidden) $('p-gyro').click();
}
function stopCam() {
  if (band) { stopBand(); if (handCfg.mode === 'band') { handCfg.mode = 'off'; saveHandCfg(); syncHandUI(); } }
  camStream?.getTracks().forEach((t) => t.stop()); camStream = null;
  $('cam-bg')?.remove();
  $('kp-cam').checked = false;
}
$('kp-cam').addEventListener('change', (e) => (e.target.checked ? startCam() : stopCam()));

$('p-back').addEventListener('click', () => { if (history.state?.player) history.back(); else closePlayer(); });
// Zurueck-Taste/-Geste: zuerst VR/Durchsicht beenden, erst dann den Player schliessen
addEventListener('popstate', () => {
  if (viewer?.inXR) { viewer.endXR(); history.pushState({ player: true }, ''); return; }
  closePlayer();
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && viewer?.inXR) viewer.endXR(); });

// Knoepfe im Handy-Durchsicht-Modus
function syncOverlay() {
  if (!video || !viewer) return;
  setIcon($('xo-play'), video.paused ? 'play_arrow' : 'pause');
  $('xo-key').classList.toggle('on', viewer.chromaState().on);
}
// Tipps auf die Knoepfe sollen nicht zusaetzlich als Tipp in die 3D-Szene gehen
$('xr-overlay').addEventListener('beforexrselect', (e) => e.preventDefault());
$('xo-exit').addEventListener('click', () => viewer?.endXR());
$('xo-play').addEventListener('click', () => { if (video) { video.paused ? video.play() : video.pause(); } });
$('xo-back').addEventListener('click', () => { if (video) video.currentTime = Math.max(0, video.currentTime - 10); });
$('xo-fwd').addEventListener('click', () => { if (video?.duration) video.currentTime = Math.min(video.duration - 0.25, video.currentTime + 10); });
$('xo-key').addEventListener('click', () => { viewer?.setChroma({ on: !viewer.chromaState().on }); syncOverlay(); });
$('xo-center').addEventListener('click', () => viewer?._recenterXR());

initUpload().finally(() => { loadList(); if (uploadEnabled) showPending(); });
