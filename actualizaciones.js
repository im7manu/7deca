// Actualizaciones automáticas desde las Releases de GitHub.
//
// Flujo seguro:
//  1. buscar(): consulta la última Release publicada (no borradores ni pre-releases) del repositorio configurado.
//     Solo se ofrecen versiones que incluyan el paquete deca-ecmr-<versión>.tar.gz y su firma .sig.
//  2. instalar(): descarga el paquete, comprueba su firma Ed25519 con la clave pública incluida en la aplicación
//     (clave-actualizaciones.pem) y lo rechaza si no cuadra. Después lo extrae en data/actualizaciones/<versión>,
//     lo verifica (nombre, versión, sintaxis, versión de Node) y prepara sus dependencias (el paquete ya las trae).
//     La aplicación sigue funcionando mientras tanto.
//  3. Copia de seguridad de la base de datos en data/copias/<fecha>-<de>-a-<a>/.
//  4. Se escribe data/actualizacion.json con estado «lista» y el servidor termina con el código 75.
//  5. El supervisor (scripts/supervisor.js, que sigue ejecutando el código antiguo) mueve el código actual a la
//     copia de seguridad, coloca el nuevo y arranca. Si la nueva versión falla durante el periodo de prueba,
//     el supervisor restaura el código y la base de datos anteriores.
//
// La carpeta data/ (base de datos y PDF) nunca se sustituye.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const EXIT_ACTUALIZAR = 75;
const PROTEGIDOS = new Set(['data', '.git', '.env', 'node_modules']);
const NOMBRE_ESTADO = 'actualizacion.json';
// Rutas peligrosas dentro de un paquete: absolutas, con unidad (C:), con \ o que suben de carpeta
const rutaPeligrosa = e => e.startsWith('/') || /^[a-z]:/i.test(e) || e.includes('\\') || e.split('/').includes('..');

const cmpVer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
};
// Comprueba un requisito sencillo de "engines" como ">=22.13"
const cumpleNode = req => {
  const m = String(req || '').match(/>=\s*([\d.]+)/);
  return !m || cmpVer(process.versions.node, m[1]) >= 0;
};

function crearActualizador({ db, logAudit, ROOT, DATA, version, nombre }) {
  const REPO = process.env.UPDATE_REPO || 'im7manu/7deca';
  const API = (process.env.UPDATE_API || 'https://api.github.com').replace(/\/$/, '');
  const DESACTIVADO = process.env.UPDATE_DISABLED === '1';
  const SUPERVISADO = process.env.DECA_SUPERVISADO === '1';
  const DIR_STAGING = path.join(DATA, 'actualizaciones');
  const DIR_COPIAS = path.join(DATA, 'copias');
  const FICH_ESTADO = path.join(DATA, NOMBRE_ESTADO);
  const MAX_COPIAS = Number(process.env.UPDATE_KEEP_BACKUPS || 3);
  const SALUD_S = Number(process.env.UPDATE_HEALTH_SECONDS || 60);

  const clavePublica = () => {
    const pem = process.env.UPDATE_PUBKEY || (() => { try { return fs.readFileSync(path.join(ROOT, 'clave-actualizaciones.pem'), 'utf8'); } catch { return null; } })();
    try { return pem ? crypto.createPublicKey(pem) : null; } catch { return null; }
  };
  const horario = () => {
    const h = getCfg('horario', { inicio: 3, fin: 5 });
    const ok = n => Number.isInteger(n) && n >= 0 && n <= 23;
    return ok(h.inicio) && ok(h.fin) && h.inicio !== h.fin ? h : { inicio: 3, fin: 5 };
  };
  const enHorario = (hora, { inicio, fin }) => (inicio < fin ? hora >= inicio && hora < fin : hora >= inicio || hora < fin);

  // Solo se descargan actualizaciones por HTTPS (http solo se admite en local, para pruebas)
  const apiOk = /^https:\/\//.test(API) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API);

  db.exec('CREATE TABLE IF NOT EXISTS config(clave TEXT PRIMARY KEY, valor TEXT)');
  const getCfg = (k, def) => { const r = db.prepare('SELECT valor FROM config WHERE clave=?').get(k); return r ? JSON.parse(r.valor) : def; };
  const setCfg = (k, v) => db.prepare('INSERT INTO config(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor').run(k, JSON.stringify(v));

  let disponible = null, ultimaComprobacion = null, errorComprobacion = '';
  let progreso = null; // { fase, inicio, error }

  const leerEstado = () => { try { return JSON.parse(fs.readFileSync(FICH_ESTADO, 'utf8')); } catch { return null; } };
  const escribirEstado = st => { fs.writeFileSync(FICH_ESTADO + '.tmp', JSON.stringify(st, null, 2)); fs.renameSync(FICH_ESTADO + '.tmp', FICH_ESTADO); };

  async function gh(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': 'gestor-deca-ecmr-actualizador', Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(opts.timeout || 20000),
      redirect: 'follow',
    });
    return r;
  }

  async function buscar(usuario = 'sistema') {
    if (DESACTIVADO) throw new Error('Las actualizaciones están desactivadas en este servidor (UPDATE_DISABLED=1).');
    if (!apiOk) throw new Error('La dirección de actualizaciones no es segura (debe ser HTTPS).');
    try {
      const r = await gh(`${API}/repos/${REPO}/releases/latest`);
      ultimaComprobacion = new Date().toISOString();
      if (r.status === 404) { disponible = null; errorComprobacion = ''; return null; }
      if (!r.ok) throw new Error(`GitHub respondió ${r.status}`);
      const rel = await r.json();
      const ver = String(rel.tag_name || '').replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+$/.test(ver)) throw new Error(`La última versión publicada tiene una etiqueta no válida: ${rel.tag_name}`);
      const paquete = (rel.assets || []).find(a => a.name === `${nombre}-${ver}.tar.gz`);
      const firma = (rel.assets || []).find(a => a.name === `${nombre}-${ver}.tar.gz.sig`);
      const nueva = cmpVer(ver, version) > 0 && !rel.draft && !rel.prerelease;
      if (nueva && (!paquete || !firma)) throw new Error(`La versión ${ver} no incluye el paquete firmado; no se instalará.`);
      disponible = nueva
        ? { version: ver, tag: rel.tag_name, nombre: rel.name || rel.tag_name, fecha: rel.published_at, notas: String(rel.body || '').slice(0, 8000), url: rel.html_url, paquete: paquete.browser_download_url, firma: firma.browser_download_url, tamano: paquete.size }
        : null;
      errorComprobacion = '';
      if (disponible && usuario !== 'sistema') logAudit(usuario, '', 'ACTUALIZACION_DISPONIBLE', `Versión ${ver} disponible (instalada ${version})`);
      return disponible;
    } catch (e) {
      ultimaComprobacion = new Date().toISOString();
      errorComprobacion = e.name === 'TimeoutError' ? 'No se pudo contactar con GitHub (tiempo agotado).' : e.message;
      throw new Error(errorComprobacion);
    }
  }

  // Lista los elementos de una carpeta, rechazando enlaces simbólicos fuera de node_modules
  function revisarArbol(dir, rel = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isSymbolicLink()) throw new Error(`El paquete contiene un enlace simbólico no permitido: ${r}`);
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') revisarArbol(path.join(dir, e.name), r);
    }
  }

  function npmCmd() {
    const win = process.platform === 'win32';
    const local = path.join(path.dirname(process.execPath), win ? 'npm.cmd' : 'npm');
    return { cmd: fs.existsSync(local) ? local : (win ? 'npm.cmd' : 'npm'), shell: win };
  }
  function ejecutar(cmd, args, cwd, shell) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd, shell, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' } });
      let out = '';
      p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
      const t = setTimeout(() => { p.kill(); reject(new Error('La instalación de dependencias tardó demasiado.')); }, 10 * 60e3);
      p.on('error', e => { clearTimeout(t); reject(e); });
      p.on('exit', code => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`npm terminó con error (${code}): ${out.slice(-600)}`)); });
    });
  }

  async function instalar(usuario = 'sistema', ip = '') {
    if (DESACTIVADO) throw new Error('Las actualizaciones están desactivadas en este servidor (UPDATE_DISABLED=1).');
    if (!clavePublica()) throw new Error('Falta la clave pública de las actualizaciones (clave-actualizaciones.pem): no se pueden comprobar las firmas.');
    if (!SUPERVISADO) throw new Error('Para instalar actualizaciones, la aplicación debe arrancarse con «npm start» (incluye el supervisor que la reinicia y la restaura si algo falla).');
    if (progreso && !progreso.error) throw new Error('Ya hay una actualización en curso.');
    const rel = disponible || await buscar(usuario);
    if (!rel) throw new Error('No hay ninguna versión nueva disponible.');
    progreso = { fase: 'Descargando la versión ' + rel.version, inicio: new Date().toISOString(), version: rel.version };
    logAudit(usuario, ip, 'ACTUALIZACION_INICIADA', `Actualización de ${version} a ${rel.version}`, 'aviso');
    // Se ejecuta en segundo plano; el estado se consulta con estado()
    (async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const staging = path.join(DIR_STAGING, `${rel.version}-${stamp}`);
      try {
        fs.mkdirSync(staging, { recursive: true });
        // 1. Descarga del paquete y de su firma
        const descargar = async (u, max) => {
          const r = await gh(u, { timeout: 5 * 60e3, headers: { Accept: 'application/octet-stream' } });
          if (!r.ok) throw new Error(`No se pudo descargar la versión (${r.status}).`);
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length > max) throw new Error('El archivo descargado tiene un tamaño anómalo.');
          return b;
        };
        const [buf, sig] = await Promise.all([descargar(rel.paquete, 200 * 1024 * 1024), descargar(rel.firma, 10000)]);
        if (buf.length < 1000) throw new Error('El archivo descargado tiene un tamaño anómalo.');
        // 2. Firma digital: si no cuadra con la clave pública de la aplicación, se rechaza sin abrir el paquete
        progreso.fase = 'Comprobando la firma digital';
        let firmaOk = false;
        try { firmaOk = crypto.verify(null, buf, clavePublica(), Buffer.from(sig.toString('utf8').trim(), 'base64')); } catch {}
        if (!firmaOk) throw new Error('La firma digital del paquete no es válida: actualización rechazada.');
        const tgz = path.join(staging, 'paquete.tar.gz');
        fs.writeFileSync(tgz, buf);
        // 3. Extracción (tar está incluido en Linux, macOS y Windows 10+)
        progreso.fase = 'Comprobando la nueva versión';
        const lista = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (lista.status !== 0) throw new Error('No se pudo leer el paquete de la actualización.');
        const peligrosa = lista.stdout.split('\n').filter(Boolean).find(rutaPeligrosa);
        if (peligrosa) throw new Error(`El paquete contiene una ruta no permitida: ${peligrosa}`);
        const ext = path.join(staging, 'extraido');
        fs.mkdirSync(ext);
        const t = spawnSync('tar', ['-xzf', tgz, '-C', ext], { encoding: 'utf8' });
        if (t.status !== 0) throw new Error('No se pudo descomprimir la actualización: ' + (t.stderr || t.error?.message || ''));
        fs.unlinkSync(tgz);
        // El paquete contiene una única carpeta
        const top = fs.readdirSync(ext).filter(n => fs.statSync(path.join(ext, n)).isDirectory());
        if (top.length !== 1) throw new Error('El paquete descargado no tiene el formato esperado.');
        const nuevo = path.join(ext, top[0]);
        // 4. Verificación
        revisarArbol(nuevo);
        const pkgFile = path.join(nuevo, 'package.json');
        if (!fs.existsSync(pkgFile) || !fs.existsSync(path.join(nuevo, 'server.js'))) throw new Error('Al paquete le faltan archivos esenciales (package.json o server.js).');
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg.name !== nombre) throw new Error(`El paquete pertenece a otra aplicación («${pkg.name}»).`);
        if (pkg.version !== rel.version) throw new Error(`La versión del paquete (${pkg.version}) no coincide con la publicada (${rel.version}).`);
        if (cmpVer(pkg.version, version) <= 0) throw new Error('El paquete no es más reciente que la versión instalada.');
        if (!cumpleNode(pkg.engines?.node)) throw new Error(`La nueva versión necesita Node ${pkg.engines.node} y este servidor tiene ${process.versions.node}. Actualiza Node antes de continuar.`);
        for (const f of ['server.js', 'actualizaciones.js', 'seguridad.js', 'integracion.js', 'scripts/supervisor.js']) {
          const fp = path.join(nuevo, f);
          if (!fs.existsSync(fp)) continue;
          const c = spawnSync(process.execPath, ['--check', fp], { encoding: 'utf8' });
          if (c.status !== 0) throw new Error(`El archivo ${f} de la nueva versión tiene errores: ${(c.stderr || '').split('\n').slice(0, 4).join(' ')}`);
        }
        const traeDeps = fs.existsSync(path.join(nuevo, 'node_modules'));
        for (const p of PROTEGIDOS) if (p !== 'node_modules' && fs.existsSync(path.join(nuevo, p))) fs.rmSync(path.join(nuevo, p), { recursive: true, force: true });
        // 5. Dependencias: el paquete firmado ya las incluye. Si no las trajera: si no cambian se copian las
        //    actuales; si cambian se instalan en la carpeta temporal
        const lockNuevo = path.join(nuevo, 'package-lock.json'), lockActual = path.join(ROOT, 'package-lock.json');
        const mismas = fs.existsSync(lockNuevo) && fs.existsSync(lockActual) && fs.readFileSync(lockNuevo, 'utf8') === fs.readFileSync(lockActual, 'utf8') && fs.existsSync(path.join(ROOT, 'node_modules'));
        if (traeDeps) {
          // nada que hacer
        } else if (mismas) {
          progreso.fase = 'Preparando las dependencias';
          fs.cpSync(path.join(ROOT, 'node_modules'), path.join(nuevo, 'node_modules'), { recursive: true, verbatimSymlinks: true });
        } else {
          progreso.fase = 'Instalando las dependencias de la nueva versión';
          const { cmd, shell } = npmCmd();
          await ejecutar(cmd, fs.existsSync(lockNuevo) ? ['ci', '--omit=dev'] : ['install', '--omit=dev'], nuevo, shell);
        }
        // 6. Copia de seguridad de la base de datos
        progreso.fase = 'Haciendo la copia de seguridad';
        // Se registra antes de copiar la base de datos para que el apunte sobreviva a una posible restauración
        logAudit(usuario, ip, 'ACTUALIZACION_PREPARADA', `Versión ${rel.version} descargada y verificada. Copia de seguridad y reinicio.`, 'aviso');
        const copia = path.join(DIR_COPIAS, `${stamp}-${version}-a-${rel.version}`);
        fs.mkdirSync(copia, { recursive: true });
        db.exec(`VACUUM INTO '${path.join(copia, 'app.db').replace(/'/g, "''")}'`);
        fs.writeFileSync(path.join(copia, 'info.json'), JSON.stringify({ fecha: new Date().toISOString(), desde: version, hasta: rel.version, por: usuario }, null, 2));
        // 7. Se deja todo listo para que el supervisor haga el cambio
        progreso.fase = 'Reiniciando la aplicación';
        escribirEstado({ estado: 'lista', desde: version, hasta: rel.version, staging: nuevo, copia, carpetaTemporal: staging, por: usuario, fecha: new Date().toISOString(), saludSegundos: SALUD_S });
        setTimeout(() => process.exit(EXIT_ACTUALIZAR), 800);
      } catch (e) {
        console.error('Actualización fallida:', e);
        progreso.error = e.message;
        progreso.fase = 'Error';
        logAudit(usuario, ip, 'ACTUALIZACION_FALLIDA', `No se instaló la versión ${rel.version}: ${e.message}`, 'alerta');
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      }
    })();
    return progreso;
  }

  function listarCopias() {
    if (!fs.existsSync(DIR_COPIAS)) return [];
    return fs.readdirSync(DIR_COPIAS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
      const dir = path.join(DIR_COPIAS, e.name);
      let info = {}; try { info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf8')); } catch {}
      const db = path.join(dir, 'app.db');
      return { id: e.name, fecha: info.fecha || '', desde: info.desde || '', hasta: info.hasta || '', resultado: info.resultado || '', tamano: fs.existsSync(db) ? fs.statSync(db).size : 0 };
    }).sort((a, b) => b.id.localeCompare(a.id));
  }
  const rutaCopia = id => {
    if (!/^[\w.-]+$/.test(id)) return null;
    const f = path.join(DIR_COPIAS, id, 'app.db');
    return path.resolve(f).startsWith(path.resolve(DIR_COPIAS) + path.sep) && fs.existsSync(f) ? f : null;
  };
  // Conserva solo las copias más recientes (cada una incluye el código anterior, que ocupa espacio)
  function podarCopias() {
    listarCopias().slice(MAX_COPIAS).forEach(c => { try { fs.rmSync(path.join(DIR_COPIAS, c.id), { recursive: true, force: true }); } catch {} });
  }

  // Al arrancar: confirma una actualización recién instalada o informa de una restauración
  function alArrancar() {
    const st = leerEstado();
    if (!st) return;
    const marcarCopia = resultado => { try { const f = path.join(st.copia, 'info.json'); const i = JSON.parse(fs.readFileSync(f, 'utf8')); i.resultado = resultado; fs.writeFileSync(f, JSON.stringify(i, null, 2)); } catch {} };
    if (st.estado === 'pendiente' && st.hasta === version) {
      console.log(`Actualización a ${version}: periodo de prueba de ${st.saludSegundos || SALUD_S} s.`);
      setTimeout(() => {
        const ahora = leerEstado();
        if (ahora?.estado !== 'pendiente') return;
        escribirEstado({ ...ahora, estado: 'completada', completada: new Date().toISOString() });
        marcarCopia('completada');
        logAudit(ahora.por, '', 'ACTUALIZACION_COMPLETADA', `Actualizada de ${ahora.desde} a ${ahora.hasta}`, 'aviso');
        try { if (ahora.carpetaTemporal) fs.rmSync(ahora.carpetaTemporal, { recursive: true, force: true }); } catch {}
        podarCopias();
        console.log(`Actualización a ${version} completada.`);
      }, (st.saludSegundos || SALUD_S) * 1000).unref();
    } else if ((st.estado === 'revertida' || st.estado === 'fallida') && !st.notificada) {
      marcarCopia(st.estado);
      logAudit(st.por, '', st.estado === 'revertida' ? 'ACTUALIZACION_REVERTIDA' : 'ACTUALIZACION_FALLIDA',
        `La versión ${st.hasta} no arrancó correctamente; se ha restaurado la ${st.desde}. ${st.motivo || ''}`.trim(), 'alerta');
      escribirEstado({ ...st, notificada: true });
      try { if (st.carpetaTemporal) fs.rmSync(st.carpetaTemporal, { recursive: true, force: true }); } catch {}
    }
  }

  // Comprobación periódica e instalación automática nocturna (si está activada)
  function programar() {
    if (DESACTIVADO || !apiOk) return;
    const ciclo = async () => {
      try {
        await buscar();
        if (disponible && getCfg('auto', false) && SUPERVISADO && enHorario(new Date().getHours(), horario()) && !progreso) await instalar('sistema (automática)');
      } catch (e) { /* se muestra en el panel */ }
    };
    setTimeout(ciclo, 60e3).unref();
    setInterval(ciclo, 60 * 60e3).unref(); // cada hora (la API de GitHub permite 60 consultas/h sin clave)
  }

  function estado() {
    const st = leerEstado();
    return {
      version, repo: REPO, supervisado: SUPERVISADO, desactivado: DESACTIVADO, auto: !!getCfg('auto', false), horario: horario(), firma: !!clavePublica(),
      ultimaComprobacion, error: errorComprobacion, disponible, progreso,
      ultimo: st ? { estado: st.estado, desde: st.desde, hasta: st.hasta, fecha: st.completada || st.fecha, motivo: st.motivo || '' } : null,
      copias: listarCopias(),
    };
  }

  const setHorario = (inicio, fin) => {
    inicio = Number(inicio); fin = Number(fin);
    const ok = n => Number.isInteger(n) && n >= 0 && n <= 23;
    if (!ok(inicio) || !ok(fin) || inicio === fin) throw new Error('El horario de instalación no es válido.');
    setCfg('horario', { inicio, fin });
  };

  return { buscar, instalar, estado, alArrancar, programar, rutaCopia, setAuto: v => setCfg('auto', !!v), setHorario, enHorario, hayAviso: () => {
    const st = leerEstado();
    if (st && st.estado === 'revertida' && Date.now() - new Date(st.revertida || st.fecha).getTime() < 7 * 864e5) return { nivel: 'crit', titulo: `La actualización a ${st.hasta} falló y se restauró la ${st.desde}`, detalle: 'Revisa el registro en Usuarios › Actualizaciones.' };
    if (disponible && !(getCfg('auto', false) && SUPERVISADO)) return { nivel: 'warn', titulo: `Nueva versión disponible: ${disponible.version}`, detalle: 'Instálala desde Usuarios › Actualizaciones.' };
    return null;
  } };
}

module.exports = { crearActualizador, EXIT_ACTUALIZAR, cmpVer, NOMBRE_ESTADO };
