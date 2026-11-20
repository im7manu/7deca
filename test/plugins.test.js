// Pruebas del sistema de plugins: subir un paquete, interfaz, CSP, puntos de extensión y eventos.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let base, server;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deca-plugins-'));
test.before(async () => {
  process.env.DECA_DATA = tmp;
  process.env.BASE_URL = 'http://localhost:9997';
  delete process.env.WHATSAPP_API;
  const { app } = require('../server.js');
  server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function cliente() {
  let cookie = '';
  return async (ruta, body, method = body !== undefined ? 'POST' : 'GET', tipo = 'application/json') => {
    const r = await fetch(base + ruta, { method, headers: { 'Content-Type': tipo, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
  };
}

function paquete(manifest, archivos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  for (const [f, c] of Object.entries(archivos)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  const tgz = path.join(os.tmpdir(), `plugin-${Date.now()}.tar.gz`);
  execFileSync('tar', ['-czf', tgz, '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return fs.readFileSync(tgz);
}

const SERVIDOR = `
export function register(ctx) {
  ctx.router.get('/hola', (req, res) => res.json({ hola: req.u.usuario, secreto: ctx.descifrar(ctx.cifrar('x')) }));
  ctx.extender('doc.datos', (datos) => ({ ...datos, marca: 'puesta por el plugin' }));
  ctx.extender('integracion.envio', ({ envio }) => ({ extra: envio.id * 10 }));
  ctx.hooks.on('ubicacion.guardada', ({ id }) => ctx.setAjuste('ultima_ubicacion', id));
}`;

test('plugins: subir, cargar, CSP, extensiones, eventos y desinstalar', async () => {
  const admin = cliente();
  let r = await admin('/api/setup', { usuario: 'admin', nombre: 'Admin', clave: 'Segura123!x', claveConfirm: 'Segura123!x', empresa_nombre: 'Transportes Prueba', empresa_nif: 'B12345674' });
  assert.equal(r.status, 200);

  // Paquetes rechazados: CSP con http y versión mínima superior
  r = await admin('/api/plugins/subir', paquete({ id: 'malo', nombre: 'Malo', version: '1.0.0', csp: { img: ['http://inseguro.test'] } }, {}), 'POST', 'application/gzip');
  assert.equal(r.status, 400); assert.match(r.data.error, /https/);
  r = await admin('/api/plugins/subir', paquete({ id: 'futuro', nombre: 'Futuro', version: '1.0.0', app_min: '99.0.0' }, {}), 'POST', 'application/gzip');
  assert.equal(r.status, 400); assert.match(r.data.error, /necesita Gestor DeCA 99/);

  const pk = paquete({ id: 'demo', nombre: 'Demo', version: '1.0.0', server: 'server.mjs', ui: { scripts: ['ui/demo.js'] }, csp: { img: ['https://tile.openstreetmap.org'] } }, { 'server.mjs': SERVIDOR, 'ui/demo.js': 'window.demo=1;' });
  r = await admin('/api/plugins/subir', pk, 'POST', 'application/gzip');
  assert.equal(r.status, 200, JSON.stringify(r.data));

  r = await admin('/api/plugins/ui');
  assert.match(r.data[0].scripts[0], /^\/plugins\/demo\/ui\/demo\.js\?v=1\.0\.0-\d+$/);
  assert.equal((await fetch(base + '/plugins/demo/ui/demo.js')).status, 401, 'sin sesión no se sirven los archivos');
  r = await admin('/plugins/demo/ui/demo.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /img-src 'self' data: blob: https:\/\/tile\.openstreetmap\.org/);

  r = await admin('/api/p/demo/hola');
  assert.deepEqual(r.data, { hola: 'admin', secreto: 'x' });

  // doc.datos e integración
  await admin('/api/empresas', { nombre: 'Cliente', nif: 'A06111222', tipo: 'Cliente' });
  const emp = (await admin('/api/empresas')).data[0];
  r = await admin('/api/docs', { tipo: 'deca', estado: 'emitido', datos: { contraparte_id: emp.id, matricula: '1234 KLM', origen: 'A', destinos: ['B'], f_carga: '2026-11-10', mercancia: 'Grava', peso: 1000 } });
  assert.equal(r.status, 200);
  const doc = (await admin('/api/docs?tipo=deca')).data[0];
  assert.equal(doc.datos.marca, 'puesta por el plugin');
  const tk = (await admin('/api/integraciones', { nombre: 'Prueba' })).data.token;
  const env = await fetch(base + '/api/integracion/v1/envios', { headers: { Authorization: `Bearer ${tk}` } }).then(x => x.json());
  assert.equal(env.envios[0].extra, env.envios[0].id * 10);

  // Evento de ubicación (devuelve el id)
  r = await admin('/api/ubicaciones', { nombre: 'Nave', direccion: 'Calle 1', ciudad: 'Madrid' });
  assert.ok(r.data.id);
  await new Promise(x => setTimeout(x, 50));
  const { db } = require('../server.js');
  assert.equal(JSON.parse(db.prepare("SELECT valor FROM plugin_ajustes WHERE clave='ultima_ubicacion'").get().valor), r.data.id);

  // Desactivar y desinstalar
  r = await admin('/api/plugins/demo/activo', { activo: false });
  assert.equal(r.status, 200);
  assert.equal((await admin('/api/p/demo/hola')).status, 404);
  r = await admin('/api/plugins/demo', undefined, 'DELETE');
  assert.equal(r.status, 200);
  assert.deepEqual((await admin('/api/plugins/ui')).data, []);
  assert.doesNotMatch((await admin('/')).headers.get('content-security-policy'), /openstreetmap/);
});
