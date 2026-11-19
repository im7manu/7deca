// Pruebas de la API de integración con token (solo lectura).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let base, server;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deca-integ-'));
test.before(async () => {
  process.env.DECA_DATA = tmp;
  process.env.BASE_URL = 'http://localhost:9998';
  process.env.UPDATE_DISABLED = '1';
  delete process.env.WHATSAPP_API;
  const { app } = require('../server.js');
  server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function cliente(cab = {}) {
  let cookie = '';
  return async (ruta, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + ruta, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...cab }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
}

test('tokens de integración y API de solo lectura', async () => {
  const admin = cliente();
  let r = await admin('/api/setup', { usuario: 'admin', nombre: 'Admin', clave: 'Segura123!x', claveConfirm: 'Segura123!x', empresa_nombre: 'Transportes Prueba', empresa_nif: 'B12345674' });
  assert.equal(r.status, 200);
  await admin('/api/empresas', { nombre: 'Áridos S.A.', nif: 'A06111222', tipo: 'Cliente' });
  const emp = (await admin('/api/empresas')).data[0];
  r = await admin('/api/docs', { tipo: 'deca', estado: 'emitido', datos: { contraparte_id: emp.id, destinatario: 'Obra', matricula: '1234 KLM', origen: 'Cantera', destinos: ['Obra'], f_carga: '2026-11-10', mercancia: 'Zahorra', peso: 24000, conductor_nombre: 'Juan', conductor_dni: '12345678Z' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await admin('/api/docs', { tipo: 'deca', estado: 'borrador', datos: { contraparte_id: emp.id, matricula: '1234 KLM', origen: 'A', destinos: ['B'], f_carga: '2026-11-11', mercancia: 'Grava', peso: 1000 } });

  // Sin token o con token falso
  assert.equal((await cliente()('/api/integracion/v1/estado')).status, 401);
  assert.equal((await cliente({ Authorization: 'Bearer deca_falsofalsofalsofalsofalso' })('/api/integracion/v1/estado')).status, 401);

  r = await admin('/api/integraciones', { nombre: 'Facturador' });
  assert.equal(r.status, 200);
  const token = r.data.token;
  assert.match(token, /^deca_/);
  r = await admin('/api/integraciones');
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].token, undefined, 'el token no se vuelve a mostrar');

  const integ = cliente({ Authorization: `Bearer ${token}` });
  r = await integ('/api/integracion/v1/estado');
  assert.equal(r.status, 200);
  assert.equal(r.data.empresa.nif, 'B12345674');
  r = await integ('/api/integracion/v1/envios?desde=2026-11-01&hasta=2026-11-30');
  assert.equal(r.status, 200);
  assert.equal(r.data.envios.length, 1, 'por defecto solo emitidos y cerrados');
  const e = r.data.envios[0];
  assert.equal(e.contraparte.nif, 'A06111222');
  assert.equal(e.peso_kg, 24000);
  assert.equal(e.fecha, '2026-11-10');
  assert.match(e.numero, /^DECA-2026-\d{5}$/);
  r = await integ('/api/integracion/v1/envios?estado=borrador');
  assert.equal(r.data.envios.length, 1);
  r = await integ('/api/integracion/v1/empresas');
  assert.equal(r.data.empresas[0].nif, 'A06111222');
  // Solo lectura: el token no da acceso a la API normal
  r = await integ('/api/docs', { tipo: 'deca' });
  assert.equal(r.status, 401);

  const id = (await admin('/api/integraciones')).data[0].id;
  r = await admin(`/api/integraciones/${id}`, null, 'DELETE');
  assert.equal(r.status, 200);
  assert.equal((await integ('/api/integracion/v1/estado')).status, 401, 'token revocado');
});
