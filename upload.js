// Hochladen in Stuecken (njs). Cloudflare laesst nur 100 MB pro Anfrage durch,
// deshalb schickt die App grosse Videos in 8-MB-Teilen:
//   GET    /upload-chunk/<name>?total=N            -> {"size": bisher angekommen}
//   PUT    /upload-chunk/<name>?total=N&offset=X   -> Teil anhaengen; komplett -> fertige Datei
//   DELETE /upload-chunk/<name>?total=N            -> abgebrochenen Upload wegwerfen
// Halbfertige Teile liegen in /videos/.parts (Punkt-Ordner, erscheint nicht in der Liste).
const fs = require('fs');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,150}\.(mp4|m4v|webm|mov|jpg)$/;
const DIR = '/videos';
const TMP = '/videos/.parts';

function size(p) {
  try { return fs.statSync(p).size; } catch (e) { return -1; }
}

function reply(r, code, obj) {
  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-store';
  r.return(code, JSON.stringify(obj));
}

function chunk(r) {
  const name = r.uri.slice('/upload-chunk/'.length);
  if (!NAME.test(name)) return reply(r, 400, { error: 'name' });
  const total = Number(r.args.total);
  if (!(total >= 0) || !Number.isInteger(total)) return reply(r, 400, { error: 'total' });

  const final = `${DIR}/${name}`;
  const part = `${TMP}/${name}.${total}.part`;

  if (r.method === 'GET') return reply(r, 200, { size: Math.max(0, size(part)), exists: size(final) >= 0 });

  if (r.method === 'DELETE') {
    try { fs.unlinkSync(part); } catch (e) { /* schon weg */ }
    return reply(r, 200, { size: 0 });
  }

  if (r.method !== 'PUT') return reply(r, 405, { error: 'method' });

  if (size(final) >= 0) return reply(r, 409, { error: 'exists' });
  const offset = Number(r.args.offset);
  if (!(offset >= 0) || offset > total) return reply(r, 400, { error: 'offset' });

  try { fs.mkdirSync(TMP); } catch (e) { /* gibt es schon */ }
  const have = Math.max(0, size(part));
  if (offset !== 0 && have !== offset) return reply(r, 409, { error: 'offset', size: have });

  const body = r.requestBuffer;
  if (body === undefined) return reply(r, 413, { error: 'too-big' });

  try {
    if (offset === 0) fs.writeFileSync(part, body);
    else fs.appendFileSync(part, body);
  } catch (e) {
    return reply(r, 507, { error: 'write', detail: String(e) });
  }

  const now = size(part);
  if (now > total) {
    try { fs.unlinkSync(part); } catch (e) {}
    return reply(r, 400, { error: 'too-long' });
  }
  if (now === total) {
    fs.renameSync(part, final);
    return reply(r, 201, { size: now, done: true });
  }
  return reply(r, 200, { size: now });
}

export default { chunk };
