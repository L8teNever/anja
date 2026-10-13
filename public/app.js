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
addEventListener('online', () => { updateNet(); loadList(); checkForUpdate(); });
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
    out.push({ ...g.sources[0], base: g.base, poster: g.poster });
  }
  return out.sort((a, b) => a.base.localeCompare(b.base, 'de'));
}

async function loadList() {
  const list = $('list');
  let items = [];
  try {
    const r = await fetch('/videos/', { cache: 'no-store' });
    items = groupVideos(await r.json());
  } catch { items = []; }
  const offline = await cachedSet();

  // offline: nur gespeicherte Videos anbieten
  if (!navigator.onLine) items = items.filter((f) => offline.has(`/videos/${encodeURIComponent(f.name)}`));

  if (!items.length) {
    list.innerHTML = `<div class="empty">${navigator.onLine
      ? 'Noch keine Videos auf dem Server.<br><small>360°-Videos (.mp4/.webm) in den Video-Ordner legen.</small>'
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

  viewer = new Viewer($('stage'), video);
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

loadList();
