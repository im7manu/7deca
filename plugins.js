// Sistema de plugins de 7DeCA.
//
// Un plugin es una carpeta <datos>/plugins/<id>/ con un plugin.json:
// {
//   "id": "mi-plugin", "nombre": "Mi plugin", "version": "1.0.0", "descripcion": "...", "app_min": "1.5.0",
//   "server": "server.mjs",                       // opcional: export function register(ctx)
//   "ui": { "scripts": ["ui/plugin.js"], "estilos": ["ui/plugin.css"] },   // opcional: se cargan en la aplicación
//   "csp": { "img": ["https://tile.openstreetmap.org"], "script": [], "connect": [], "style": [], "font": [] }
// }
//
// Los plugins se descargan del registro (registry.json en GitHub) y se verifican con SHA-256, o se suben a mano
// como .tar.gz. Se guardan dentro de la carpeta de datos, así que las actualizaciones de la aplicación no los borran.
// IMPORTANTE: un plugin ejecuta código con los mismos permisos que la aplicación. Instala solo plugins de confianza.
//
// Puntos de extensión del servidor (ctx.extender(punto, fn)):
//   'doc.datos'         (datos, { tipo, doc }) => datos     Ajusta los datos de un envío antes de guardarlo
//   'integracion.envio' ({ envio, datos, doc }) => objeto  Campos extra para la API de integración (p. ej. { ruta })
// Eventos (ctx.hooks.on(evento, fn)):
//   'doc.guardado'       { doc, datos, nuevo, usuario }
//   'ubicacion.guardada' { id, body, usuario }
//   'ubicacion.borrada'  { id }

const express = require('express');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const exec = promisify(execFile);
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const rutaPeligrosa = e => e.startsWith('/') || /^[a-z]:/i.test(e) || e.includes('\\') || e.split('/').includes('..');
const ID_VALIDO = /^[a-z0-9][a-z0-9-]{1,40}$/;
const REGISTRO_DEFECTO = 'https://raw.githubusercontent.com/im7manu/7deca-plugins/main/registry.json';
// Solo para desarrollo: permite registros y descargas por http
const URL_PERMITIDA = process.env.DECA_PLUGINS_DEV_HTTP === '1' ? /^https?:\/\// : /^https:\/\//;
// Orígenes que un plugin puede añadir a la política de seguridad de contenidos (solo https, sin rutas)
const ORIGEN_CSP = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const TIPOS_CSP = ['img', 'script', 'connect', 'style', 'font', 'frame'];

const cmpVersion = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

function crearPlugins({ db, DATA, version, logAudit }) {
  const DIR = process.env.DECA_PLUGINS ? path.resolve(process.env.DECA_PLUGINS) : path.join(DATA, 'plugins');
  fs.mkdirSync(DIR, { recursive: true });
  db.exec(`CREATE TABLE IF NOT EXISTS plugins(
    id TEXT PRIMARY KEY, version TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1, manifest TEXT NOT NULL, instalado TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plugin_ajustes(clave TEXT PRIMARY KEY, valor TEXT)`);

  // Clave de la instalación para cifrar secretos de los plugins (p. ej. claves de API)
  const fClave = path.join(DATA, 'secreto.key');
  if (!fs.existsSync(fClave)) fs.writeFileSync(fClave, crypto.randomBytes(32), { mode: 0o600 });
  const clave = fs.readFileSync(fClave);
  const cifrar = texto => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', clave, iv);
    const enc = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
  };
  const descifrar = s => {
    const [v, iv, tag, enc] = String(s).split(':');
    if (v !== 'v1') throw new Error('Formato cifrado desconocido');
    const d = crypto.createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
  };
  const getAjuste = (k, def = null) => { const r = db.prepare('SELECT valor FROM plugin_ajustes WHERE clave=?').get(k); try { return r ? JSON.parse(r.valor) : def; } catch { return def; } };
  const setAjuste = (k, v) => db.prepare('INSERT INTO plugin_ajustes(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor').run(k, JSON.stringify(v));

  const hooks = new EventEmitter();
  hooks.setMaxListeners(50);
  const routers = new Map();
  const extensiones = new Map();
  const temporizadores = new Map();
  const paradas = new Map(); // id -> funciones que el plugin quiere ejecutar al desactivarlo (cerrar conexiones…)
  const cargados = new Set();
  let reinicioPendiente = false;
  let deps = {};

  const extensionesDe = punto => [...(extensiones.get(punto)?.entries() || [])].sort((a, b) => a[0].localeCompare(b[0])).map(([id, fn]) => ({ id, fn }));
  // Aplica las extensiones de un punto en cadena sin que un plugin roto tumbe la petición
  function aplicar(punto, valor, extra) {
    for (const { id, fn } of extensionesDe(punto)) {
      try { const r = fn(valor, extra); if (r !== undefined) valor = r; } catch (e) { console.error(`[plugin ${id}] ${punto}:`, e.message); }
    }
    return valor;
  }
  function emitir(evento, datos) {
    for (const fn of hooks.listeners(evento)) {
      Promise.resolve().then(() => fn(datos)).catch(e => console.error(`[plugins] ${evento}:`, e.message));
    }
  }

  function quitar(id) {
    for (const fn of paradas.get(id) || []) { try { fn(); } catch (e) { console.error(`[plugin ${id}] al parar:`, e.message); } }
    paradas.delete(id);
    routers.delete(id);
    for (const m of extensiones.values()) m.delete(id);
    for (const t of temporizadores.get(id) || []) clearInterval(t);
    temporizadores.delete(id);
    for (const ev of hooks.eventNames()) for (const fn of hooks.listeners(ev)) if (fn.__plugin === id) hooks.off(ev, fn);
  }

  function leerManifest(dir) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    if (!ID_VALIDO.test(m.id || '')) throw new Error('plugin.json: id no válido');
    if (!m.nombre || !m.version) throw new Error('plugin.json: faltan nombre o version');
    if (m.app_min && cmpVersion(version, m.app_min) < 0) throw new Error(`Este plugin necesita 7DeCA ${m.app_min} o posterior (tienes la ${version}).`);
    const rutas = [m.server, ...(m.ui?.scripts || []), ...(m.ui?.estilos || [])].filter(Boolean);
    for (const rel of rutas) {
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(dir + path.sep)) throw new Error('plugin.json: ruta fuera del plugin');
    }
    for (const t of Object.keys(m.csp || {})) {
      if (!TIPOS_CSP.includes(t) || !Array.isArray(m.csp[t]) || !m.csp[t].every(o => ORIGEN_CSP.test(o))) throw new Error('plugin.json: «csp» solo admite orígenes https');
    }
    return m;
  }

  async function activar(id) {
    const dir = path.join(DIR, id);
    const m = leerManifest(dir);
    quitar(id);
    if (m.server) {
      const router = express.Router();
      const datos = path.join(DATA, 'plugins-datos', id);
      fs.mkdirSync(datos, { recursive: true });
      const hooksPlugin = {
        on(ev, fn) { fn.__plugin = id; hooks.on(ev, fn); return hooksPlugin; },
        emit: (ev, d) => emitir(ev, d),
      };
      const ctx = {
        router, db, express, manifest: m, dir, dataDir: datos, version,
        hooks: hooksPlugin, logAudit: deps.logAudit || logAudit, adm: deps.adm, can: deps.can, need: deps.need, ajustes: deps.ajustes,
        docs: deps.docs, lib: deps.lib, base: deps.BASE, dataRoot: DATA, extensionesDe,
        // Reinicia la aplicación (solo con supervisor, que la vuelve a arrancar)
        reiniciar() { if (process.env.DECA_SUPERVISADO !== '1') throw new Error('La aplicación no tiene supervisor (npm start): reiníciala a mano.'); setTimeout(() => process.exit(0), 500); },
        getAjuste, setAjuste, cifrar, descifrar,
        extender(punto, fn) {
          if (!extensiones.has(punto)) extensiones.set(punto, new Map());
          extensiones.get(punto).set(id, fn);
        },
        alParar(fn) { paradas.set(id, [...(paradas.get(id) || []), fn]); },
        cada(ms, fn) {
          const t = setInterval(() => Promise.resolve().then(fn).catch(e => console.error(`[${id}]`, e)), ms);
          t.unref();
          temporizadores.set(id, [...(temporizadores.get(id) || []), t]);
          return t;
        },
      };
      const mod = await import(`${pathToFileURL(path.join(dir, m.server)).href}?v=${Date.now()}`);
      if (typeof mod.register === 'function') await mod.register(ctx);
      routers.set(id, router);
      cargados.add(id);
    }
    return m;
  }

  async function cargar() {
    for (const p of db.prepare('SELECT id FROM plugins WHERE activo=1').all()) {
      try { await activar(p.id); console.log(`Plugin cargado: ${p.id}`); }
      catch (e) { console.error(`No se pudo cargar el plugin ${p.id}:`, e.message); }
    }
  }

  const registroUrl = () => process.env.DECA_PLUGINS_REGISTRY || getAjuste('registro_plugins') || REGISTRO_DEFECTO;
  async function obtenerRegistro() {
    const url = registroUrl();
    if (!URL_PERMITIDA.test(url)) throw new Error('El registro de plugins debe ser una URL https');
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`No se pudo leer el registro de plugins (${r.status})`);
    const d = await r.json();
    return { url, plugins: Array.isArray(d.plugins) ? d.plugins : [] };
  }

  async function instalarDesdeRegistro(id) {
    const { plugins } = await obtenerRegistro();
    const p = plugins.find(x => x.id === id);
    if (!p) throw new Error('El plugin no está en el registro');
    if (!URL_PERMITIDA.test(p.url || '') || !/^[a-f0-9]{64}$/i.test(p.sha256 || '')) throw new Error('Entrada del registro incompleta (url https y sha256 obligatorios)');
    const r = await fetch(p.url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
    if (!r.ok) throw new Error(`Descarga fallida (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 40 * 1024 * 1024) throw new Error('El plugin es demasiado grande');
    if (crypto.createHash('sha256').update(buf).digest('hex') !== p.sha256.toLowerCase()) throw new Error('La firma SHA-256 no coincide: descarga rechazada');
    return instalarPaquete(buf, id);
  }

  async function instalarPaquete(buf, idEsperado = null) {
    const staging = fs.mkdtempSync(path.join(DIR, '.tmp-'));
    try {
      const archivo = path.join(staging, 'plugin.tar.gz');
      fs.writeFileSync(archivo, buf);
      const extraido = path.join(staging, 'x');
      fs.mkdirSync(extraido);
      const { stdout } = await exec(TAR, ['-tzf', archivo]);
      for (const e of stdout.split('\n').filter(Boolean)) if (rutaPeligrosa(e)) throw new Error('El paquete contiene rutas no permitidas');
      await exec(TAR, ['-xzf', archivo, '-C', extraido, '--no-same-owner', '--no-same-permissions']);
      const revisar = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isSymbolicLink()) throw new Error('El paquete contiene enlaces simbólicos');
          if (e.isDirectory()) revisar(path.join(d, e.name));
        }
      };
      revisar(extraido);
      let raiz = extraido;
      const hijos = fs.readdirSync(extraido);
      if (!fs.existsSync(path.join(raiz, 'plugin.json')) && hijos.length === 1) raiz = path.join(extraido, hijos[0]);
      const m = leerManifest(raiz);
      if (idEsperado && m.id !== idEsperado) throw new Error('El id del paquete no coincide con el registro');
      if (cargados.has(m.id)) reinicioPendiente = true;
      const destino = path.join(DIR, m.id);
      fs.rmSync(destino, { recursive: true, force: true });
      fs.renameSync(raiz, destino);
      db.prepare(`INSERT INTO plugins(id,version,activo,manifest,instalado) VALUES(?,?,1,?,?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version, manifest=excluded.manifest, activo=1, instalado=excluded.instalado`)
        .run(m.id, m.version, JSON.stringify(m), new Date().toISOString());
      await activar(m.id);
      return m;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  const instalados = () => db.prepare('SELECT * FROM plugins ORDER BY id').all().map(p => ({ ...p, activo: !!p.activo, manifest: JSON.parse(p.manifest) }));
  const activos = () => instalados().filter(p => p.activo);

  // Orígenes extra de la política de seguridad de contenidos que piden los plugins activos (se recalcula al cambiar)
  let cacheCsp = null;
  function csp() {
    if (cacheCsp) return cacheCsp;
    const out = {};
    for (const p of activos()) for (const [t, l] of Object.entries(p.manifest.csp || {})) {
      if (!TIPOS_CSP.includes(t)) continue;
      out[t] = [...new Set([...(out[t] || []), ...l.filter(o => ORIGEN_CSP.test(o))])];
    }
    return (cacheCsp = out);
  }
  const cambiado = () => { cacheCsp = null; };

  /** Monta las rutas. Se llama después de la comprobación de sesión. */
  function rutas(app, { adm, can, need, ajustes, logAudit: la, docs, lib, BASE }) {
    deps = { adm, can, need, ajustes, logAudit: la, docs, lib, BASE };
    const L = (req, accion, detalle, sev = 'aviso') => la(req.u.usuario, req.ip, accion, detalle, sev);

    // Lo que necesita la interfaz (cualquier usuario con sesión)
    // ?v= cambia con la versión y con cada instalación, para que el navegador no use una copia antigua de la caché
    app.get('/api/plugins/ui', (req, res) => res.json(activos().filter(p => p.manifest.ui).map(p => {
      const v = encodeURIComponent(`${p.version}-${Date.parse(p.instalado) || 0}`);
      return {
        id: p.id, nombre: p.manifest.nombre, version: p.version,
        scripts: (p.manifest.ui.scripts || []).map(s => `/plugins/${p.id}/${s}?v=${v}`),
        estilos: (p.manifest.ui.estilos || []).map(s => `/plugins/${p.id}/${s}?v=${v}`),
      };
    })));

    app.get('/api/plugins', adm, (_, res) => res.json({ instalados: instalados(), reinicio_pendiente: reinicioPendiente, supervisado: process.env.DECA_SUPERVISADO === '1', registro: registroUrl() }));
    app.get('/api/plugins/registro', adm, async (_, res) => {
      try { res.json(await obtenerRegistro()); } catch (e) { res.status(502).json({ error: e.message, url: registroUrl() }); }
    });
    app.post('/api/plugins/reiniciar', adm, (req, res) => {
      if (process.env.DECA_SUPERVISADO !== '1') return res.status(400).json({ error: 'La aplicación no se está ejecutando con supervisor (npm start): reiníciala a mano.' });
      L(req, 'APP_REINICIADA', 'Reinicio desde la página de plugins');
      res.json({ ok: 1 });
      setTimeout(() => process.exit(0), 500);
    });
    app.post('/api/plugins/subir', adm, express.raw({ type: () => true, limit: 40 * 1024 * 1024 }), async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length < 20 || req.body[0] !== 0x1f || req.body[1] !== 0x8b) throw new Error('Sube un paquete .tar.gz de plugin');
        const m = await instalarPaquete(req.body);
        cambiado();
        L(req, 'PLUGIN_SUBIDO', `${m.id} ${m.version} (archivo, sha256 ${crypto.createHash('sha256').update(req.body).digest('hex').slice(0, 16)}…)`, 'alerta');
        res.json({ ok: 1, manifest: m, reinicio_pendiente: reinicioPendiente });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/plugins/:id/instalar', adm, async (req, res) => {
      const id = String(req.params.id);
      if (!ID_VALIDO.test(id)) return res.status(400).json({ error: 'Id no válido' });
      try {
        const m = await instalarDesdeRegistro(id);
        cambiado();
        L(req, 'PLUGIN_INSTALADO', `${id} ${m.version}`);
        res.json({ ok: 1, manifest: m, reinicio_pendiente: reinicioPendiente });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/plugins/:id/activo', adm, async (req, res) => {
      const id = String(req.params.id);
      if (!db.prepare('SELECT 1 FROM plugins WHERE id=?').get(id)) return res.status(404).json({ error: 'No instalado' });
      const activo = !!req.body?.activo;
      try {
        if (activo) await activar(id); else quitar(id);
        db.prepare('UPDATE plugins SET activo=? WHERE id=?').run(activo ? 1 : 0, id);
        cambiado();
        L(req, activo ? 'PLUGIN_ACTIVADO' : 'PLUGIN_DESACTIVADO', id);
        res.json({ ok: 1 });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/plugins/:id', adm, (req, res) => {
      const id = String(req.params.id);
      if (!ID_VALIDO.test(id)) return res.status(400).json({ error: 'Id no válido' });
      quitar(id);
      db.prepare('DELETE FROM plugins WHERE id=?').run(id);
      fs.rmSync(path.join(DIR, id), { recursive: true, force: true });
      cambiado();
      L(req, 'PLUGIN_DESINSTALADO', id);
      res.json({ ok: 1, aviso: 'Reinicia la aplicación para descargar por completo el código del plugin. Sus datos se conservan.' });
    });

    // API propia de cada plugin: /api/p/<id>/...
    app.use('/api/p/:pluginId', (req, res, next) => {
      const r = routers.get(req.params.pluginId);
      if (!r) return res.status(404).json({ error: 'Plugin no disponible' });
      r(req, res, next);
    });
  }

  /** Archivos estáticos de los plugins (solo con sesión iniciada). */
  function estaticos(app) {
    app.use('/plugins/:pluginId', (req, res, next) => {
      const id = req.params.pluginId;
      if (!req.u) return res.status(401).end();
      if (!ID_VALIDO.test(id) || !db.prepare('SELECT 1 FROM plugins WHERE id=? AND activo=1').get(id)) return res.status(404).end();
      express.static(path.join(DIR, id), { dotfiles: 'deny', index: false, maxAge: '1h' })(req, res, next);
    });
  }

  return { cargar, rutas, estaticos, csp, aplicar, emitir, extensionesDe, cifrar, descifrar, DIR };
}

module.exports = { crearPlugins, cmpVersion };
