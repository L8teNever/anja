// Hochladen in Stuecken mit Fortsetzen (nginx-njs).
// Die App schickt ein Video in 16-MB-Stuecken, mehrere gleichzeitig. Jedes Stueck wird an
// seine Stelle in die Datei geschrieben und abgehakt. Bricht der Upload ab (Seite zu,
// Netz weg), weiss der Server noch, welche Stuecke schon da sind – waehlt man dieselbe
// Datei nochmal, geht es genau dort weiter.
//   GET    /upload-chunk/<name>?total=T&chunk=S          -> {have: [0,1,5,...], exists}
//   PUT    /upload-chunk/<name>?total=T&chunk=S&index=i  -> Stueck i schreiben
//   DELETE /upload-chunk/<name>?total=T&chunk=S          -> abgebrochenen Upload wegwerfen
// Halbfertiges liegt in /videos/.parts/<name>.<T>.<S>/ (Punkt-Ordner, nicht in der Liste).
const fs = require('fs');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,150}\.(mp4|m4v|webm|mov|mkv)$/;
const DIR = '/videos';
const PARTS = '/videos/.parts';

function exists(p) {
  try { fs.statSync(p); return true; } catch (e) { return false; }
}

function reply(r, code, obj) {
  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-store';
  r.return(code, JSON.stringify(obj));
}

function have(dir) {
  try {
    return fs.readdirSync(dir).filter(function (n) { return /^\d+$/.test(n); }).map(Number).sort(function (a, b) { return a - b; });
  } catch (e) { return []; }
}

function removeDir(dir) {
  try { fs.readdirSync(dir).forEach(function (n) { try { fs.unlinkSync(dir + '/' + n); } catch (e) {} }); } catch (e) {}
  try { fs.rmdirSync(dir + '/done'); } catch (e) {}
  try { fs.rmdirSync(dir); } catch (e) {}
}

function chunk(r) {
  const name = r.uri.slice('/upload-chunk/'.length);
  if (!NAME.test(name)) return reply(r, 400, { error: 'name' });
  const total = Number(r.args.total), size = Number(r.args.chunk);
  if (!(total > 0) || Math.floor(total) !== total) return reply(r, 400, { error: 'total' });
  if (!(size >= 1048576 && size <= 33554432)) return reply(r, 400, { error: 'chunk' });
  const n = Math.ceil(total / size);
  const final = DIR + '/' + name;
  const dir = PARTS + '/' + name + '.' + total + '.' + size;
  const data = dir + '/data';

  if (r.method === 'GET') {
    let fin = false;
    try { fin = fs.statSync(final).size === total; } catch (e) {}
    return reply(r, 200, { have: fin ? [] : have(dir), n: n, exists: exists(final), complete: fin });
  }
  if (r.method === 'DELETE') { removeDir(dir); return reply(r, 200, { ok: true }); }
  if (r.method !== 'PUT') return reply(r, 405, { error: 'method' });

  if (exists(final)) {
    let fin = false;
    try { fin = fs.statSync(final).size === total; } catch (e) {}
    return reply(r, 409, { error: 'exists', complete: fin });
  }
  const i = Number(r.args.index);
  if (!(i >= 0) || i >= n || Math.floor(i) !== i) return reply(r, 400, { error: 'index' });
  const body = r.requestBuffer;
  if (body === undefined) return reply(r, 413, { error: 'too-big' });
  const want = Math.min(size, total - i * size);
  if (body.length !== want) return reply(r, 400, { error: 'length', want: want, got: body.length });

  try { fs.mkdirSync(PARTS); } catch (e) {}
  try { fs.mkdirSync(dir); } catch (e) {}
  // Datei nur anlegen, wenn es sie noch nicht gibt ('wx'), sonst nie abschneiden
  try { fs.closeSync(fs.openSync(data, 'wx')); } catch (e) {}
  try {
    const fd = fs.openSync(data, 'r+');
    try { fs.writeSync(fd, body, 0, body.length, i * size); } finally { fs.closeSync(fd); }
    fs.writeFileSync(dir + '/' + i, '');
  } catch (e) {
    return reply(r, 507, { error: 'write', detail: String(e) });
  }

  const got = have(dir);
  if (got.length >= n) {
    // nur eine Anfrage darf fertigstellen: mkdir ist atomar
    try { fs.mkdirSync(dir + '/done'); } catch (e) { return reply(r, 200, { have: got.length, n: n }); }
    try {
      if (fs.statSync(data).size !== total) throw new Error('size');
      fs.renameSync(data, final);
    } catch (e) {
      try { fs.rmdirSync(dir + '/done'); } catch (e2) {}
      return reply(r, 500, { error: 'finish', detail: String(e) });
    }
    removeDir(dir);
    return reply(r, 201, { have: n, n: n, done: true });
  }
  return reply(r, 200, { have: got.length, n: n });
}

export default { chunk };
