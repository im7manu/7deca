// API de integración de solo lectura para otras aplicaciones (p. ej. el plugin «Gestor DeCA» de Facturador).
//
// El administrador crea tokens en Usuarios › Integraciones. Cada token se muestra una sola vez; en la base de
// datos solo se guarda su hash SHA-256. Las peticiones llevan la cabecera «Authorization: Bearer <token>».
// La API no permite modificar nada.
//
//   GET /api/integracion/v1/estado
//   GET /api/integracion/v1/envios?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&tipo=deca|ecmr&estado=emitido,cerrado
//   GET /api/integracion/v1/empresas | vehiculos | conductores

const crypto = require('crypto');

function crearIntegracion({ db, logAudit, normDatos, num, url, version, ajustes, extensionesDe = () => [] }) {
  db.exec(`CREATE TABLE IF NOT EXISTS tokens_integracion(
    id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, prefijo TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
    creado TEXT NOT NULL, creado_por TEXT, ultimo_uso TEXT, ultimo_ip TEXT, revocado INTEGER DEFAULT 0
  )`);
  const sha = t => crypto.createHash('sha256').update(t).digest('hex');
  const publico = t => ({ id: t.id, nombre: t.nombre, prefijo: t.prefijo, creado: t.creado, creado_por: t.creado_por || '', ultimo_uso: t.ultimo_uso || '', ultimo_ip: t.ultimo_ip || '' });

  // Límite sencillo por token: 120 peticiones por minuto
  const uso = new Map();
  const dentroDeLimite = id => {
    const a = Date.now(), l = (uso.get(id) || []).filter(t => a - t < 60e3);
    if (l.length >= 120) return false;
    l.push(a); uso.set(id, l); return true;
  };

  function autenticar(req, res, next) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(deca_[A-Za-z0-9_-]{20,100})$/);
    const t = m && db.prepare('SELECT * FROM tokens_integracion WHERE hash=? AND revocado=0').get(sha(m[1]));
    if (!t) {
      logAudit('integración', req.ip, 'INTEGRACION_TOKEN_INVALIDO', 'Petición a la API de integración con un token inválido o revocado', 'alerta');
      return res.status(401).json({ error: 'Token de integración no válido.' });
    }
    if (!dentroDeLimite(t.id)) return res.status(429).json({ error: 'Demasiadas peticiones. Espera un minuto.' });
    db.prepare('UPDATE tokens_integracion SET ultimo_uso=?, ultimo_ip=? WHERE id=?').run(new Date().toISOString(), req.ip || '', t.id);
    req.integracion = t;
    next();
  }

  const fechaOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  function envio(d) {
    const x = normDatos(JSON.parse(d.datos || '{}'));
    const out = {
      id: d.id, numero: num(d), tipo: d.tipo, estado: d.estado || 'emitido', creado: d.creado, modificado: d.modificado || d.creado,
      fecha: x.f_carga || String(d.creado || '').slice(0, 10), mi_papel: x.mi_papel || 'transportista',
      contraparte: { nombre: x.contraparte_nombre || '', nif: x.contraparte_nif || '', direccion: x.contraparte_direccion || '' },
      destinatario: x.destinatario || '', origen: x.origen || '', destinos: x.destinos || [], mercancia: x.mercancia || '',
      peso_kg: Number(x.peso) || 0, bultos: Number(x.bultos) || 0, matricula: x.matricula || '', remolque: x.remolque || '',
      conductor: { nombre: x.conductor_nombre || '', dni: x.conductor_dni || '' }, albaran: x.nalbaran || '',
      observaciones: x.obs || '', pdf: url(d),
    };
    // Campos que añaden los plugins (p. ej. «ruta» con los km del plugin Rutas)
    for (const { id, fn } of extensionesDe('integracion.envio')) {
      try { Object.assign(out, fn({ envio: out, datos: x, doc: d }) || {}); } catch (e) { console.error(`[plugin ${id}] integracion.envio:`, e.message); }
    }
    return out;
  }

  function rutas(app, adm) {
    // ---- API con token (se monta antes de la comprobación de sesión) ----
    app.get('/api/integracion/v1/estado', autenticar, (req, res) => res.json({
      aplicacion: 'Gestor DeCA y eCMR', version, token: req.integracion.nombre,
      empresa: { nombre: ajustes().nombre || '', nif: ajustes().nif || '' },
    }));
    app.get('/api/integracion/v1/envios', autenticar, (req, res) => {
      const q = req.query, w = [], p = [];
      if (q.tipo === 'deca' || q.tipo === 'ecmr') { w.push('tipo=?'); p.push(q.tipo); }
      const estados = String(q.estado || 'emitido,cerrado').split(',').filter(e => ['borrador', 'emitido', 'anulado', 'cerrado'].includes(e));
      if (estados.length) { w.push(`COALESCE(estado,'emitido') IN (${estados.map(() => '?').join(',')})`); p.push(...estados); }
      let lista = db.prepare(`SELECT * FROM docs ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 2000`).all(...p).map(envio);
      if (fechaOk(q.desde)) lista = lista.filter(e => e.fecha >= q.desde);
      if (fechaOk(q.hasta)) lista = lista.filter(e => e.fecha <= q.hasta);
      res.json({ envios: lista });
    });
    app.get('/api/integracion/v1/empresas', autenticar, (_, res) => res.json({ empresas: db.prepare('SELECT id,nombre,nif,direccion,cp,ciudad,email,tel,tipo FROM empresas ORDER BY nombre').all() }));
    app.get('/api/integracion/v1/vehiculos', autenticar, (_, res) => res.json({ vehiculos: db.prepare('SELECT id,matricula,tipo,modelo,estado,itv FROM vehiculos ORDER BY matricula').all() }));
    app.get('/api/integracion/v1/conductores', autenticar, (_, res) => res.json({ conductores: db.prepare('SELECT id,nombre,dni,telefono,email,activo FROM conductores ORDER BY nombre').all().map(c => ({ ...c, activo: !!c.activo })) }));
    app.use('/api/integracion', (_, res) => res.status(404).json({ error: 'No encontrado' }));

    return function rutasAdmin() {
      app.get('/api/integraciones', adm, (_, res) => res.json(db.prepare('SELECT * FROM tokens_integracion WHERE revocado=0 ORDER BY id DESC').all().map(publico)));
      app.post('/api/integraciones', adm, (req, res) => {
        const nombre = String(req.body?.nombre || '').trim().slice(0, 60);
        if (!nombre) return res.status(400).json({ error: 'Pon un nombre para reconocer la integración (p. ej. «Facturador»).' });
        const token = 'deca_' + crypto.randomBytes(32).toString('base64url');
        const r = db.prepare('INSERT INTO tokens_integracion(nombre,prefijo,hash,creado,creado_por) VALUES(?,?,?,?,?)')
          .run(nombre, token.slice(0, 12), sha(token), new Date().toISOString(), req.u.usuario);
        logAudit(req.u.usuario, req.ip, 'INTEGRACION_CREADA', `Token de integración «${nombre}» creado`, 'aviso');
        res.json({ ...publico(db.prepare('SELECT * FROM tokens_integracion WHERE id=?').get(r.lastInsertRowid)), token });
      });
      app.delete('/api/integraciones/:id', adm, (req, res) => {
        const t = db.prepare('SELECT * FROM tokens_integracion WHERE id=? AND revocado=0').get(Number(req.params.id));
        if (!t) return res.status(404).json({ error: 'No encontrado.' });
        db.prepare('UPDATE tokens_integracion SET revocado=1 WHERE id=?').run(t.id);
        logAudit(req.u.usuario, req.ip, 'INTEGRACION_REVOCADA', `Token de integración «${t.nombre}» revocado`, 'aviso');
        res.json({ ok: 1 });
      });
    };
  }

  return { rutas };
}

module.exports = { crearIntegracion };
