// Pruebas de la verificación del teléfono, la recuperación de la contraseña por WhatsApp y las passkeys.
// Se usa una base de datos temporal y un puente de WhatsApp falso que guarda los mensajes enviados.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const enviados = [];
const puente = http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; });
  req.on('end', () => { enviados.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"success":true,"message":"ok"}'); });
});

let base, server, app, db;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deca-test-'));

test.before(async () => {
  await new Promise(r => puente.listen(0, '127.0.0.1', r));
  process.env.DECA_DATA = tmp;
  process.env.WHATSAPP_API = `http://127.0.0.1:${puente.address().port}`;
  process.env.BASE_URL = 'http://localhost:9999';
  process.env.UPDATE_DISABLED = '1';
  ({ app, db } = require('../server.js'));
  server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); puente.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Cliente mínimo que conserva la cookie de sesión
function cliente() {
  let cookie = '';
  return async (ruta, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + ruta, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
}
const ultimoCodigo = () => enviados.at(-1).message;

test('flujo completo de seguridad de cuentas', async t => {
  const admin = cliente();
  let r = await admin('/api/setup', { usuario: 'admin', nombre: 'Admin', clave: 'Segura123!x', claveConfirm: 'Segura123!x' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  await t.test('sin teléfono verificado solo se puede verificar', async () => {
    r = await admin('/api/yo');
    assert.equal(r.data.verificar_telefono, true);
    r = await admin('/api/docs');
    assert.equal(r.status, 403);
    assert.equal(r.data.verificarTelefono, true);
  });

  await t.test('verificación del teléfono por WhatsApp', async () => {
    r = await admin('/api/cuenta/telefono', { telefono: '600 11 22 33' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(enviados.length, 2);
    assert.equal(enviados[0].recipient, '34600112233');
    assert.match(enviados[0].message, /^Este es tu código para verificar tu teléfono en 7DeCA: \d{6}\. ¿No has sido tú\? Ignora este mensaje\.$/);
    assert.match(ultimoCodigo(), /^\d{6}$/);
    r = await admin('/api/cuenta/telefono/verificar', { codigo: '000000' === ultimoCodigo() ? '111111' : '000000' });
    assert.equal(r.status, 400);
    r = await admin('/api/cuenta/telefono/verificar', { codigo: ultimoCodigo() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await admin('/api/ajustes');
    assert.equal(r.status, 200);
  });

  await t.test('un segundo envío antes de un minuto se rechaza', async () => {
    r = await admin('/api/cuenta/telefono', { telefono: '600112233' });
    assert.equal(r.status, 429);
  });

  await t.test('recuperación de la contraseña de una cuenta bloqueada', async () => {
    // Usuario con teléfono verificado y bloqueado por intentos fallidos
    r = await admin('/api/usuarios', { usuario: 'mayte', nombre: 'Mayte', clave: 'Inicial123!', rol: 'usuario', permisos: [], telefono: '+34 611 223 344' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    db.prepare("UPDATE usuarios SET telefono_verificado=1, intentos_fallidos=8, bloqueado_hasta=? WHERE usuario='mayte'").run(Date.now() + 15 * 60e3);
    const anon = cliente();
    r = await anon('/api/login', { usuario: 'mayte', clave: 'Inicial123!' });
    assert.equal(r.status, 429);
    assert.equal(r.data.bloqueada, true);

    const n = enviados.length;
    r = await anon('/api/recuperar/solicitar', { usuario: 'mayte' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(enviados.length, n + 2);
    assert.equal(enviados[n].recipient, '34611223344');
    const codigo = enviados[n + 1].message;
    assert.equal(enviados[n].message, `Este es tu código para restablecer la contraseña de 7DeCA: ${codigo}. ¿No has sido tú? Ignora este mensaje.`);

    // Usuario inexistente: misma respuesta y ningún mensaje
    r = await anon('/api/recuperar/solicitar', { usuario: 'noexiste' });
    assert.equal(r.status, 200);
    assert.equal(enviados.length, n + 2);

    r = await anon('/api/recuperar/comprobar', { usuario: 'mayte', codigo });
    assert.equal(r.status, 200);
    r = await anon('/api/recuperar/confirmar', { usuario: 'mayte', codigo, clave: 'corta', claveConfirm: 'corta' });
    assert.equal(r.status, 400);
    r = await anon('/api/recuperar/confirmar', { usuario: 'mayte', codigo, clave: 'Campanilla74@', claveConfirm: 'Campanilla74@' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await anon('/api/yo');
    assert.equal(r.data.usuario, 'mayte');
    const u = db.prepare("SELECT intentos_fallidos, bloqueado_hasta FROM usuarios WHERE usuario='mayte'").get();
    assert.equal(u.intentos_fallidos, 0); assert.equal(u.bloqueado_hasta, 0);
    // El código ya no sirve
    r = await anon('/api/recuperar/confirmar', { usuario: 'mayte', codigo, clave: 'Otra12345!', claveConfirm: 'Otra12345!' });
    assert.equal(r.status, 400);
    // Aviso de cambio enviado
    assert.match(enviados.at(-1).message, /Se ha cambiado la contraseña/);
  });

  await t.test('cinco códigos erróneos invalidan el código', async () => {
    db.prepare("DELETE FROM codigos").run();
    const anon = cliente();
    await anon('/api/recuperar/solicitar', { usuario: 'mayte' });
    const codigo = ultimoCodigo();
    const malo = codigo === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await anon('/api/recuperar/comprobar', { usuario: 'mayte', codigo: malo });
    r = await anon('/api/recuperar/comprobar', { usuario: 'mayte', codigo });
    assert.equal(r.status, 400);
  });

  await t.test('opciones de passkey', async () => {
    r = await admin('/api/passkeys/registro/opciones', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.rp.id, 'localhost');
    assert.equal(r.data.authenticatorSelection.residentKey, 'required');
    const anon = cliente();
    r = await anon('/api/passkeys/acceso/opciones', {});
    assert.equal(r.status, 200);
    assert.ok(r.data.id && r.data.opciones.challenge);
    r = await anon('/api/passkeys/acceso/verificar', { id: r.data.id, respuesta: { id: 'desconocida', response: {} } });
    assert.equal(r.status, 400);
  });

  await t.test('cambio de la propia contraseña', async () => {
    r = await admin('/api/cuenta/clave', { actual: 'mal', nueva: 'Nueva12345!', confirmar: 'Nueva12345!' });
    assert.equal(r.status, 400);
    r = await admin('/api/cuenta/clave', { actual: 'Segura123!x', nueva: 'Nueva12345!', confirmar: 'Nueva12345!' });
    assert.equal(r.status, 200);
    r = await admin('/api/yo');
    assert.equal(r.status, 200, 'la sesión actual sigue abierta');
  });
});
