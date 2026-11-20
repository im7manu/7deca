// Seguridad de las cuentas: teléfono verificado por WhatsApp, recuperación de la contraseña con un código
// enviado por WhatsApp y acceso con passkeys (WebAuthn).
//
// WhatsApp: los mensajes se envían a través de un puente HTTP compatible con whatsapp-mcp
// (POST <WHATSAPP_API>/api/send con { recipient, message }). Si WHATSAPP_API no está configurado, la
// verificación del teléfono no se exige y la recuperación por WhatsApp no está disponible.
//
// Códigos: 6 cifras, válidos 10 minutos, como máximo 5 intentos por código. Se guarda solo su hash.
// Envíos limitados por usuario (uno por minuto, cinco por hora) y por dirección IP.

const crypto = require('crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const NOMBRE_APP = '7DeCA';
const CODIGO_MIN = 10;
const CODIGO_INTENTOS = 5;

// Normaliza un teléfono a solo dígitos con prefijo internacional. Los móviles y fijos españoles de 9 cifras
// reciben el prefijo 34. Devuelve '' si no parece un número válido.
function normalizarTelefono(t) {
  let s = String(t || '').trim().replace(/[\s().-]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (/^[6789]\d{8}$/.test(s)) s = '34' + s;
  return /^[1-9]\d{7,14}$/.test(s) ? s : '';
}
const ocultarTelefono = t => (t ? `+${String(t).slice(0, 2)} ··· ··· ${String(t).slice(-3)}` : '');

function nombreDispositivo(ua = '') {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Dispositivo';
}

function crearSeguridad({ db, BASE, logAudit, hash, okPw, validatePassword, abrirSesion }) {
  const WA_API = (process.env.WHATSAPP_API || '').replace(/\/$/, '');
  const whatsapp = !!WA_API;
  const exigirTelefono = whatsapp && process.env.WHATSAPP_EXIGIR !== '0';
  const base = new URL(BASE);
  const RP_ID = process.env.RP_ID || base.hostname;
  const ORIGEN = process.env.RP_ORIGIN || base.origin;

  db.exec(`
    CREATE TABLE IF NOT EXISTS codigos(
      id INTEGER PRIMARY KEY, uid INTEGER NOT NULL, tipo TEXT NOT NULL, destino TEXT NOT NULL,
      hash TEXT NOT NULL, expira INTEGER NOT NULL, intentos INTEGER DEFAULT 0, usado INTEGER DEFAULT 0, creado INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS codigos_uid ON codigos(uid, tipo);
    CREATE TABLE IF NOT EXISTS passkeys(
      id TEXT PRIMARY KEY, uid INTEGER NOT NULL, clave_publica BLOB NOT NULL, contador INTEGER DEFAULT 0,
      transportes TEXT DEFAULT '[]', nombre TEXT DEFAULT '', creada TEXT, ultimo_uso TEXT, sincronizada INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS passkeys_uid ON passkeys(uid);
  `);
  for (const sql of [
    "ALTER TABLE usuarios ADD COLUMN telefono TEXT DEFAULT ''",
    'ALTER TABLE usuarios ADD COLUMN telefono_verificado INTEGER DEFAULT 0',
  ]) { try { db.exec(sql); } catch {} }

  // ---------------- WhatsApp ----------------
  async function enviarWhatsApp(telefono, mensaje) {
    if (!whatsapp) throw new Error('El envío por WhatsApp no está configurado en este servidor.');
    const r = await fetch(`${WA_API}/api/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: telefono, message: mensaje }), signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success === false) throw new Error(`WhatsApp no aceptó el mensaje${d.message ? ': ' + d.message : ''}`);
  }
  // El código va además en un mensaje aparte para poder copiarlo con una pulsación larga
  async function enviarCodigo(telefono, texto, codigo) {
    await enviarWhatsApp(telefono, texto);
    await enviarWhatsApp(telefono, codigo);
  }

  // ---------------- Límites de envío ----------------
  const porIp = new Map();
  function limiteIp(ip, max = 10, ventana = 60 * 60e3) {
    const ahora = Date.now();
    const lista = (porIp.get(ip) || []).filter(t => ahora - t < ventana);
    if (lista.length >= max) return false;
    lista.push(ahora); porIp.set(ip, lista);
    return true;
  }
  setInterval(() => { const a = Date.now(); for (const [k, v] of porIp) if (!v.some(t => a - t < 60 * 60e3)) porIp.delete(k); }, 30 * 60e3).unref();

  function limiteUsuario(uid, tipo) {
    const ahora = Date.now();
    const ult = db.prepare('SELECT creado FROM codigos WHERE uid=? AND tipo=? ORDER BY id DESC LIMIT 1').get(uid, tipo);
    if (ult && ahora - ult.creado < 60e3) return `Espera ${Math.ceil((60e3 - (ahora - ult.creado)) / 1000)} s antes de pedir otro código.`;
    const n = db.prepare('SELECT count(*) AS c FROM codigos WHERE uid=? AND tipo=? AND creado>?').get(uid, tipo, ahora - 60 * 60e3).c;
    if (n >= 5) return 'Has pedido demasiados códigos. Inténtalo dentro de una hora.';
    return null;
  }

  // ---------------- Códigos ----------------
  const hashCodigo = (codigo, sal) => sal + ':' + crypto.createHash('sha256').update(sal + ':' + codigo).digest('hex');
  function crearCodigo(uid, tipo, destino) {
    const codigo = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const sal = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE codigos SET usado=1 WHERE uid=? AND tipo=? AND usado=0').run(uid, tipo);
    db.prepare('INSERT INTO codigos(uid,tipo,destino,hash,expira,creado) VALUES(?,?,?,?,?,?)')
      .run(uid, tipo, destino, hashCodigo(codigo, sal), Date.now() + CODIGO_MIN * 60e3, Date.now());
    db.prepare('DELETE FROM codigos WHERE creado<?').run(Date.now() - 7 * 864e5);
    return codigo;
  }
  // Comprueba el código vigente de un usuario. Los fallos cuentan; con «consumir» se marca como usado.
  function comprobarCodigo(uid, tipo, codigo, consumir) {
    const c = db.prepare('SELECT * FROM codigos WHERE uid=? AND tipo=? AND usado=0 ORDER BY id DESC LIMIT 1').get(uid, tipo);
    if (!c || c.expira < Date.now()) return { error: 'El código ha caducado o no existe. Pide uno nuevo.' };
    if (c.intentos >= CODIGO_INTENTOS) return { error: 'Has superado los intentos permitidos para este código. Pide uno nuevo.' };
    const limpio = String(codigo || '').replace(/\D/g, '');
    const [sal, esperado] = c.hash.split(':');
    const calculado = hashCodigo(limpio, sal).split(':')[1];
    const ok = limpio.length === 6 && crypto.timingSafeEqual(Buffer.from(calculado, 'hex'), Buffer.from(esperado, 'hex'));
    if (!ok) {
      db.prepare('UPDATE codigos SET intentos=intentos+1 WHERE id=?').run(c.id);
      const quedan = CODIGO_INTENTOS - c.intentos - 1;
      return { error: quedan > 0 ? `Código incorrecto. Te quedan ${quedan} intento${quedan === 1 ? '' : 's'}.` : 'Código incorrecto. Pide uno nuevo.' };
    }
    if (consumir) db.prepare('UPDATE codigos SET usado=1 WHERE id=?').run(c.id);
    return { ok: true, destino: c.destino };
  }

  const ipDe = req => req.ip || req.socket.remoteAddress || '';
  const usuarioPorNombre = n => db.prepare('SELECT * FROM usuarios WHERE usuario=?').get(String(n || '').trim().toLowerCase());

  // ---------------- Passkeys ----------------
  const desafios = new Map(); // id → { challenge, uid, expira }
  const guardarDesafio = (id, datos) => {
    const a = Date.now();
    for (const [k, v] of desafios) if (v.expira < a) desafios.delete(k);
    desafios.set(id, { ...datos, expira: a + 5 * 60e3 });
  };
  const tomarDesafio = id => {
    const d = desafios.get(id); desafios.delete(id);
    return d && d.expira > Date.now() ? d : null;
  };
  const passkeysDe = uid => db.prepare('SELECT * FROM passkeys WHERE uid=? ORDER BY creada').all(uid);
  const passkeyPublica = p => ({ id: p.id, nombre: p.nombre, creada: p.creada, ultimo_uso: p.ultimo_uso || '', sincronizada: !!p.sincronizada });

  // ---------------- Rutas públicas (sin sesión) ----------------
  function rutasPublicas(app) {
    // Recuperación: 1) pedir código
    app.post('/api/recuperar/solicitar', async (req, res) => {
      const ip = ipDe(req);
      if (!whatsapp) return res.status(503).json({ error: 'La recuperación por WhatsApp no está disponible en este servidor. Pide al administrador que te cambie la contraseña.' });
      if (!limiteIp(ip, 10)) return res.status(429).json({ error: 'Demasiadas solicitudes desde esta conexión. Inténtalo más tarde.' });
      const nombre = String(req.body?.usuario || '').trim().toLowerCase();
      if (!nombre) return res.status(400).json({ error: 'Indica tu usuario.' });
      // Respuesta idéntica exista o no el usuario, para no revelar qué cuentas existen
      const generico = { ok: 1, mensaje: 'Si el usuario existe y tiene un teléfono verificado, recibirás un código por WhatsApp en unos segundos.' };
      const u = usuarioPorNombre(nombre);
      if (!u || !u.activo || !u.telefono || !u.telefono_verificado) {
        logAudit(nombre, ip, 'RECUPERACION_SIN_TELEFONO', u ? 'La cuenta no tiene teléfono verificado o está desactivada' : 'Usuario inexistente', 'aviso');
        return res.json(generico);
      }
      const lim = limiteUsuario(u.id, 'recuperar');
      if (lim) return res.status(429).json({ error: lim });
      const codigo = crearCodigo(u.id, 'recuperar', u.telefono);
      try {
        await enviarCodigo(u.telefono, `Este es tu código para restablecer la contraseña de ${NOMBRE_APP}: ${codigo}. ¿No has sido tú? Ignora este mensaje.`, codigo);
        logAudit(u.usuario, ip, 'RECUPERACION_CODIGO_ENVIADO', `Código enviado por WhatsApp a ${ocultarTelefono(u.telefono)}`, 'aviso');
      } catch (e) {
        db.prepare("UPDATE codigos SET usado=1 WHERE uid=? AND tipo='recuperar'").run(u.id);
        logAudit(u.usuario, ip, 'RECUPERACION_ERROR_ENVIO', e.message, 'alerta');
        return res.status(502).json({ error: 'No se pudo enviar el WhatsApp ahora mismo. Inténtalo en unos minutos o avisa al administrador.' });
      }
      res.json(generico);
    });

    // 2) comprobar el código (sin gastarlo) para pasar a la pantalla de la nueva contraseña
    app.post('/api/recuperar/comprobar', (req, res) => {
      const u = usuarioPorNombre(req.body?.usuario);
      if (!u || !u.activo) return res.status(400).json({ error: 'El código ha caducado o no existe. Pide uno nuevo.' });
      const r = comprobarCodigo(u.id, 'recuperar', req.body?.codigo, false);
      if (r.error) { logAudit(u.usuario, ipDe(req), 'RECUPERACION_CODIGO_FALLIDO', r.error, 'aviso'); return res.status(400).json({ error: r.error }); }
      res.json({ ok: 1 });
    });

    // 3) nueva contraseña: gasta el código, desbloquea la cuenta, cierra las demás sesiones y entra
    app.post('/api/recuperar/confirmar', async (req, res) => {
      const ip = ipDe(req);
      const u = usuarioPorNombre(req.body?.usuario);
      const clave = String(req.body?.clave || '');
      if (!u || !u.activo) return res.status(400).json({ error: 'El código ha caducado o no existe. Pide uno nuevo.' });
      if (clave !== String(req.body?.claveConfirm || '')) return res.status(400).json({ error: 'Las contraseñas no coinciden.' });
      const pwErr = validatePassword(clave);
      if (pwErr) return res.status(400).json({ error: pwErr });
      const r = comprobarCodigo(u.id, 'recuperar', req.body?.codigo, true);
      if (r.error) { logAudit(u.usuario, ip, 'RECUPERACION_CODIGO_FALLIDO', r.error, 'aviso'); return res.status(400).json({ error: r.error }); }
      db.prepare('UPDATE usuarios SET hash=?, intentos_fallidos=0, bloqueado_hasta=0 WHERE id=?').run(hash(clave), u.id);
      db.prepare('DELETE FROM sesiones WHERE uid=?').run(u.id);
      logAudit(u.usuario, ip, 'CLAVE_RESTABLECIDA', 'Contraseña restablecida con un código de WhatsApp; cuenta desbloqueada y sesiones cerradas', 'alerta');
      enviarWhatsApp(u.telefono, `Se ha cambiado la contraseña de tu cuenta de ${NOMBRE_APP}. Si no has sido tú, avisa al administrador cuanto antes.`).catch(() => {});
      abrirSesion(req, res, u);
      res.json({ ok: 1 });
    });

    // Passkeys: acceso sin usuario ni contraseña (credenciales detectables)
    app.post('/api/passkeys/acceso/opciones', async (req, res) => {
      if (!limiteIp('pk:' + ipDe(req), 60)) return res.status(429).json({ error: 'Demasiados intentos. Inténtalo más tarde.' });
      const opciones = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred', allowCredentials: [] });
      const id = crypto.randomBytes(16).toString('hex');
      guardarDesafio(id, { challenge: opciones.challenge, tipo: 'acceso' });
      res.json({ id, opciones });
    });

    app.post('/api/passkeys/acceso/verificar', async (req, res) => {
      const ip = ipDe(req);
      const d = tomarDesafio(String(req.body?.id || ''));
      const resp = req.body?.respuesta;
      if (!d || d.tipo !== 'acceso' || !resp?.id) return res.status(400).json({ error: 'La solicitud ha caducado. Vuelve a intentarlo.' });
      const pk = db.prepare('SELECT * FROM passkeys WHERE id=?').get(String(resp.id));
      if (!pk) { logAudit('', ip, 'PASSKEY_DESCONOCIDA', 'Intento de acceso con una passkey no registrada', 'aviso'); return res.status(400).json({ error: 'Esta passkey no está registrada en la aplicación. Entra con tu contraseña y créala de nuevo en «Mi cuenta».' }); }
      const u = db.prepare('SELECT * FROM usuarios WHERE id=?').get(pk.uid);
      if (!u || !u.activo) return res.status(403).json({ error: 'Esta cuenta de usuario ha sido desactivada por el administrador.' });
      let v;
      try {
        v = await verifyAuthenticationResponse({
          response: resp, expectedChallenge: d.challenge, expectedOrigin: ORIGEN, expectedRPID: RP_ID,
          credential: { id: pk.id, publicKey: new Uint8Array(pk.clave_publica), counter: pk.contador, transports: JSON.parse(pk.transportes || '[]') },
          requireUserVerification: false,
        });
      } catch (e) { v = { verified: false, error: e.message }; }
      if (!v.verified) {
        logAudit(u.usuario, ip, 'PASSKEY_FALLIDA', v.error || 'Firma no válida', 'alerta');
        return res.status(400).json({ error: 'No se pudo comprobar la passkey.' });
      }
      db.prepare('UPDATE passkeys SET contador=?, ultimo_uso=? WHERE id=?').run(v.authenticationInfo.newCounter, new Date().toISOString(), pk.id);
      // La passkey no se puede adivinar: un bloqueo temporal por contraseñas fallidas no impide entrar con ella
      db.prepare('UPDATE usuarios SET intentos_fallidos=0, bloqueado_hasta=0, ultimo_login=?, ultimo_login_ip=? WHERE id=?').run(new Date().toISOString(), ip, u.id);
      logAudit(u.usuario, ip, 'LOGIN_PASSKEY', `Inicio de sesión con la passkey «${pk.nombre}»`);
      abrirSesion(req, res, u);
      res.json({ ok: 1 });
    });
  }

  // ---------------- Rutas con sesión ----------------
  // Mientras el teléfono no esté verificado (y WhatsApp esté configurado) solo se permite verificarlo
  const PERMITIDAS_SIN_TELEFONO = new Set(['/api/yo', '/api/cuenta/telefono', '/api/cuenta/telefono/verificar', '/api/logout', '/api/setup-status']);
  const debeVerificar = u => exigirTelefono && !u.telefono_verificado;

  function rutasPrivadas(app) {
    app.use((req, res, next) => {
      if (!req.u || !req.path.startsWith('/api/') || !debeVerificar(req.u) || PERMITIDAS_SIN_TELEFONO.has(req.path)) return next();
      res.status(403).json({ error: 'Antes de continuar tienes que verificar tu número de teléfono.', verificarTelefono: true });
    });

    app.post('/api/cuenta/telefono', async (req, res) => {
      const ip = ipDe(req);
      if (!whatsapp) return res.status(503).json({ error: 'El envío por WhatsApp no está configurado en este servidor.' });
      const tel = normalizarTelefono(req.body?.telefono);
      if (!tel) return res.status(400).json({ error: 'El número no es válido. Escríbelo con el prefijo del país si no es español (p. ej. +351…).' });
      if (!limiteIp('tel:' + ip, 15)) return res.status(429).json({ error: 'Demasiadas solicitudes. Inténtalo más tarde.' });
      const lim = limiteUsuario(req.u.id, 'verificar');
      if (lim) return res.status(429).json({ error: lim });
      const codigo = crearCodigo(req.u.id, 'verificar', tel);
      try {
        await enviarCodigo(tel, `Este es tu código para verificar tu teléfono en ${NOMBRE_APP}: ${codigo}. ¿No has sido tú? Ignora este mensaje.`, codigo);
      } catch (e) {
        db.prepare("UPDATE codigos SET usado=1 WHERE uid=? AND tipo='verificar'").run(req.u.id);
        logAudit(req.u.usuario, ip, 'TELEFONO_ERROR_ENVIO', e.message, 'alerta');
        return res.status(502).json({ error: 'No se pudo enviar el WhatsApp. Comprueba el número (debe tener WhatsApp) o inténtalo en unos minutos.' });
      }
      logAudit(req.u.usuario, ip, 'TELEFONO_CODIGO_ENVIADO', `Código de verificación enviado a ${ocultarTelefono(tel)}`);
      res.json({ ok: 1, telefono: ocultarTelefono(tel) });
    });

    app.post('/api/cuenta/telefono/verificar', (req, res) => {
      const r = comprobarCodigo(req.u.id, 'verificar', req.body?.codigo, true);
      if (r.error) return res.status(400).json({ error: r.error });
      db.prepare('UPDATE usuarios SET telefono=?, telefono_verificado=1 WHERE id=?').run(r.destino, req.u.id);
      logAudit(req.u.usuario, ipDe(req), 'TELEFONO_VERIFICADO', `Teléfono ${ocultarTelefono(r.destino)} verificado`);
      res.json({ ok: 1, telefono: ocultarTelefono(r.destino) });
    });

    // Cambio de la propia contraseña (se exige la actual); cierra las demás sesiones del usuario
    app.post('/api/cuenta/clave', (req, res) => {
      const b = req.body || {};
      const nueva = String(b.nueva || '');
      if (!okPw(String(b.actual || ''), req.u.hash)) {
        logAudit(req.u.usuario, ipDe(req), 'CLAVE_CAMBIO_FALLIDO', 'Contraseña actual incorrecta', 'aviso');
        return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
      }
      if (nueva !== String(b.confirmar || '')) return res.status(400).json({ error: 'Las contraseñas nuevas no coinciden.' });
      const pwErr = validatePassword(nueva);
      if (pwErr) return res.status(400).json({ error: pwErr });
      db.prepare('UPDATE usuarios SET hash=? WHERE id=?').run(hash(nueva), req.u.id);
      db.prepare('DELETE FROM sesiones WHERE uid=? AND sid<>?').run(req.u.id, req.sid || '');
      logAudit(req.u.usuario, ipDe(req), 'CLAVE_CAMBIADA', 'El usuario ha cambiado su contraseña', 'aviso');
      res.json({ ok: 1 });
    });

    app.get('/api/passkeys', (req, res) => res.json(passkeysDe(req.u.id).map(passkeyPublica)));

    app.post('/api/passkeys/registro/opciones', async (req, res) => {
      const opciones = await generateRegistrationOptions({
        rpName: NOMBRE_APP, rpID: RP_ID,
        userID: Buffer.from(`deca-${req.u.id}`), userName: req.u.usuario, userDisplayName: req.u.nombre,
        attestationType: 'none',
        excludeCredentials: passkeysDe(req.u.id).map(p => ({ id: p.id, transports: JSON.parse(p.transportes || '[]') })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      });
      guardarDesafio('reg:' + req.u.id, { challenge: opciones.challenge, tipo: 'registro', uid: req.u.id });
      res.json(opciones);
    });

    app.post('/api/passkeys/registro/verificar', async (req, res) => {
      const d = tomarDesafio('reg:' + req.u.id);
      if (!d) return res.status(400).json({ error: 'La solicitud ha caducado. Vuelve a intentarlo.' });
      let v;
      try {
        v = await verifyRegistrationResponse({ response: req.body?.respuesta, expectedChallenge: d.challenge, expectedOrigin: ORIGEN, expectedRPID: RP_ID, requireUserVerification: false });
      } catch (e) { return res.status(400).json({ error: 'No se pudo registrar la passkey: ' + e.message }); }
      if (!v.verified) return res.status(400).json({ error: 'No se pudo registrar la passkey.' });
      const { credential, credentialBackedUp } = v.registrationInfo;
      const nombre = String(req.body?.nombre || '').trim().slice(0, 60) || nombreDispositivo(req.headers['user-agent']);
      try {
        db.prepare('INSERT INTO passkeys(id,uid,clave_publica,contador,transportes,nombre,creada,sincronizada) VALUES(?,?,?,?,?,?,?,?)')
          .run(credential.id, req.u.id, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports || []), nombre, new Date().toISOString(), credentialBackedUp ? 1 : 0);
      } catch { return res.status(400).json({ error: 'Esta passkey ya está registrada.' }); }
      logAudit(req.u.usuario, ipDe(req), 'PASSKEY_CREADA', `Nueva passkey «${nombre}»`, 'aviso');
      res.json({ ok: 1, passkeys: passkeysDe(req.u.id).map(passkeyPublica) });
    });

    app.delete('/api/passkeys/:id', (req, res) => {
      const pk = db.prepare('SELECT * FROM passkeys WHERE id=? AND uid=?').get(String(req.params.id), req.u.id);
      if (!pk) return res.status(404).json({ error: 'Passkey no encontrada.' });
      db.prepare('DELETE FROM passkeys WHERE id=?').run(pk.id);
      logAudit(req.u.usuario, ipDe(req), 'PASSKEY_ELIMINADA', `Passkey «${pk.nombre}» eliminada`, 'aviso');
      res.json({ ok: 1, passkeys: passkeysDe(req.u.id).map(passkeyPublica) });
    });
  }

  return {
    rutasPublicas, rutasPrivadas, normalizarTelefono, ocultarTelefono, debeVerificar,
    config: () => ({ whatsapp, exigirTelefono, rpId: RP_ID }),
    numPasskeys: uid => db.prepare('SELECT count(*) AS c FROM passkeys WHERE uid=?').get(uid).c,
    borrarPasskeys: uid => db.prepare('DELETE FROM passkeys WHERE uid=?').run(uid).changes,
  };
}

module.exports = { crearSeguridad, normalizarTelefono, ocultarTelefono };
