import { hydrateIcons, icon, setIcon } from '/icons.js';

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
    const m = /^(.*)\.(mp4|m4v|webm|jpe?g)$/i.exec(f.name);
    if (!m) continue;
    const g = by.get(m[1]) || { base: m[1], sources: [] };
    if (/^jpe?g$/i.test(m[2])) g.poster = f; else g.sources.push({ ...f, ext: m[2].toLowerCase() });
    by.set(m[1], g);
  }
  const out = [];
  for (const g of by.values()) {
    if (!g.sources.length) continue;
    const rank = (s) => (s.ext === 'webm' ? (canWebm ? (canMp4 ? 1 : 0) : 3) : (canMp4 ? 0 : 2));
    g.sources.sort((a, b) => rank(a) - rank(b));
    out.push({ ...g.sources[0], base: g.base, poster: g.poster,
      all: [...g.sources.map((x) => x.name), ...(g.poster ? [g.poster.name] : [])] });
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
        <span class="badge ${isOff ? 'off' : ''}">${isOff ? 'Offline verfügbar' : '360°'}</span>
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
    card.querySelector('.thumb').addEventListener('click', () => openPlayer(path, niceName(f.base)));
    card.querySelector('[data-act=cache]').addEventListener('click', (e) => onCacheClick(e.currentTarget, path, f.size, isOff, posterPath));
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

async function onCacheClick(btn, path, size, isOff, posterPath) {
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
  if (!['mp4', 'm4v', 'webm', 'mov'].includes(ext)) return null;
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
  return { base: name, video: `${name}.${ext}`, poster: `${name}.jpg` };
}

// Video lokal oeffnen: Groesse, Abspielbarkeit, Vorschaubild
function analyze(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (info) => {
      if (done) return; done = true; clearTimeout(timer);
      v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
      resolve(info);
    };
    const timer = setTimeout(() => finish({ ok: false }), 20000);
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onloadedmetadata = () => {
      if (!v.videoWidth) { finish({ ok: false }); return; }
      v.currentTime = Math.min(2, (v.duration || 1) / 3);
    };
    v.onseeked = () => {
      const w = v.videoWidth, h = v.videoHeight;
      const c = document.createElement('canvas');
      // bei 3D nur das linke Auge als Vorschau
      const lay = w / h > 3 ? 'lr' : Math.abs(w / h - 1) < 0.08 ? 'tb' : 'mono';
      const sw = lay === 'lr' ? w / 2 : w, sh = lay === 'tb' ? h / 2 : h;
      c.width = 1024; c.height = 512;
      c.getContext('2d').drawImage(v, 0, 0, sw, sh, 0, 0, c.width, c.height);
      c.toBlob((thumb) => finish({ ok: true, w, h, dur: v.duration, thumb }), 'image/jpeg', 0.82);
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

async function uploadFile(file) {
  const names = uploadName(file);
  if (!names) { toast(`„${file.name}“: nur .mp4, .m4v, .webm oder .mov`, 4000); return; }
  const row = uploadRow(niceName(names.base));
  const item = { abort: null, cancelled: false };
  row.querySelector('button').addEventListener('click', () => { item.cancelled = true; item.abort?.(); });
  const pct = row.querySelector('.up-pct'), bar = row.querySelector('.bar > div'), note = row.querySelector('.up-note');
  uploadsRunning++; keepAwake(true);
  try {
    const info = await analyze(file);
    if (item.cancelled) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    if (!info.ok) {
      if (!confirm(`„${file.name}“ kann dieses Gerät nicht abspielen (evtl. HEVC/H.265).\nAuf anderen Geräten geht es vielleicht nicht. Trotzdem hochladen?`)) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
      note.textContent = 'Ohne Vorschaubild – Format hier nicht abspielbar';
    } else {
      const r = info.w / info.h;
      const is360 = Math.abs(r - 2) < 0.1 || Math.abs(r - 1) < 0.08 || Math.abs(r - 4) < 0.2;
      if (!is360 && !confirm(`„${file.name}“ hat ${info.w}×${info.h} Pixel – das ist kein typisches 360°-Format (2:1).\nEs würde verzerrt aussehen. Trotzdem hochladen?`)) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
      const kind = Math.abs(r - 1) < 0.08 ? '3D übereinander' : r > 3 ? '3D nebeneinander' : '360°';
      note.textContent = `${info.w}×${info.h} · ${kind} · ${fmtTime(info.dur)} · ${fmtBytes(file.size)}`;
    }
    const t0 = Date.now();
    await put(`/upload/${encodeURIComponent(names.video)}`, file, file.type || 'video/mp4', (got, total) => {
      const p = Math.floor((got / total) * 100);
      bar.style.width = `${p}%`;
      const rate = got / Math.max(1, (Date.now() - t0) / 1000);
      const left = rate > 0 ? (total - got) / rate : 0;
      pct.textContent = `${p} % · ${fmtBytes(rate)}/s${left > 5 ? ` · noch ${fmtTime(left)}` : ''}`;
    }, item);
    if (info.thumb) { try { await put(`/upload/${encodeURIComponent(names.poster)}`, info.thumb, 'image/jpeg'); } catch {} }
    pct.textContent = 'Fertig'; bar.style.width = '100%'; row.classList.add('done');
    toast(`„${niceName(names.base)}“ ist jetzt auf dem Server`);
    setTimeout(() => { row.remove(); if (!$('uploads').children.length) $('uploads').hidden = true; }, 2500);
  } catch (e) {
    serverNames.delete(names.base.toLowerCase());
    if (e.name === 'AbortError') { row.remove(); toast('Hochladen abgebrochen'); }
    else { row.classList.add('err'); pct.textContent = 'Fehler'; note.textContent = e.message;
      row.querySelector('button').onclick = () => row.remove(); }
    if (!$('uploads').children.length) $('uploads').hidden = true;
  } finally {
    uploadsRunning--; if (!uploadsRunning) keepAwake(false);
    loadList();
  }
}

async function uploadFiles(files) {
  if (!uploadEnabled) { toast('Hochladen ist auf diesem Server aus'); return; }
  if (!navigator.onLine) { toast('Zum Hochladen brauchst du Internet'); return; }
  for (const f of files) await uploadFile(f); // nacheinander, damit die Leitung nicht geteilt wird
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

/* ---------------- Player ---------------- */
let viewer = null, video = null;

async function openPlayer(src, title) {
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
  const hint = $('tap-hint'); hint.classList.remove('gone');
  viewer.onInteract = () => hint.classList.add('gone');
  setTimeout(() => hint.classList.add('gone'), 4000);

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

  video.addEventListener('loadedmetadata', () => { $('p-dur').textContent = fmtTime(video.duration); });
  video.addEventListener('timeupdate', () => {
    $('p-time').textContent = fmtTime(video.currentTime);
    if (!seeking && video.duration) $('p-seek').value = Math.round((video.currentTime / video.duration) * 1000);
  });
  video.addEventListener('play', () => setIcon($('p-play'), 'pause'));
  video.addEventListener('pause', () => setIcon($('p-play'), 'play_arrow'));
  video.addEventListener('error', () => toast(navigator.onLine ? 'Video konnte nicht geladen werden' : 'Dieses Video ist nicht offline gespeichert'));

  try { await video.play(); } catch { /* Browser will erst einen Tipp */ }
  history.pushState({ player: true }, '');
}

function closePlayer() {
  if (!viewer) return;
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
$('p-recenter').addEventListener('click', () => viewer?.recenter());
$('p-gyro').addEventListener('click', async () => {
  if (!viewer) return;
  const on = await viewer.setGyro(!viewer.gyro);
  $('p-gyro').classList.toggle('on', on);
  if (!on && !viewer.gyro) toast('Bewegungssensor aus');
  else toast('Bewegungssensor an – Handy bewegen zum Umschauen');
});
$('p-back').addEventListener('click', () => { if (history.state?.player) history.back(); else closePlayer(); });
addEventListener('popstate', () => closePlayer());

initUpload().finally(loadList);
