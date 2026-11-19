#!/usr/bin/env node
// Supervisor de Gestor DeCA y eCMR.
//
// Arranca server.js y lo vuelve a arrancar si se detiene. Además aplica las actualizaciones de forma segura:
//  - Cuando el servidor termina con el código 75 y data/actualizacion.json está «lista», mueve el código actual
//    a la copia de seguridad, coloca la nueva versión y la arranca (estado «pendiente»).
//  - Si la nueva versión se cae o no responde durante el periodo de prueba, restaura el código y la base de
//    datos anteriores (estado «revertida») y vuelve a arrancar la versión antigua.
//
// IMPORTANTE: este archivo solo usa módulos de Node y no carga nada del resto de la aplicación, porque sigue
// ejecutándose mientras los demás archivos se sustituyen. Los cambios en este archivo surten efecto la próxima
// vez que se reinicie la aplicación por completo.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// Igual que server.js: DECA_DATA permite guardar los datos fuera de la carpeta de la aplicación
const DATA = process.env.DECA_DATA ? path.resolve(process.env.DECA_DATA) : path.join(ROOT, 'data');
const ESTADO = path.join(DATA, 'actualizacion.json');
const MANIFIESTO = path.join(ROOT, '.archivos-instalados.json');
const EXIT_ACTUALIZAR = 75;
const PROTEGIDOS = new Set(['data', '.git', '.env']);
// Archivos de versiones anteriores a la 1.2 (que no tenían manifiesto de archivos instalados)
const ANTIGUOS = ['server.js', 'actualizaciones.js', 'public', 'scripts', 'docs', 'package.json', 'package-lock.json', 'README.md', 'icon.svg', 'manifest.webmanifest', '.gitignore', 'node_modules', '.archivos-instalados.json'];

const log = m => console.log(`[supervisor ${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${m}`);
const leer = () => { try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return null; } };
const escribir = st => { fs.writeFileSync(ESTADO + '.tmp', JSON.stringify(st, null, 2)); fs.renameSync(ESTADO + '.tmp', ESTADO); };
// Mueve un archivo o carpeta. Si origen y destino están en montajes distintos (p. ej. volúmenes de Docker
// anidados) renameSync falla con EXDEV y se copia y borra en su lugar.
const mover = (a, b) => {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  try { fs.renameSync(a, b); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(a, b, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fs.rmSync(a, { recursive: true, force: true });
  }
};

let hijo = null, parando = false, fallosSeguidos = 0, temporizadorSalud = null, abortarPorSalud = false;

// Sustituye el código actual por la versión preparada en st.staging
function aplicar(st) {
  const codigo = path.join(st.copia, 'codigo');
  const nuevos = fs.readdirSync(st.staging).filter(n => !PROTEGIDOS.has(n));
  let previos = [];
  try { previos = JSON.parse(fs.readFileSync(MANIFIESTO, 'utf8')); } catch { previos = ANTIGUOS; }
  const aRetirar = [...new Set([...previos, ...nuevos, '.archivos-instalados.json'])].filter(n => !PROTEGIDOS.has(n) && fs.existsSync(path.join(ROOT, n)));
  const retirados = [], instalados = [];
  try {
    for (const n of aRetirar) { mover(path.join(ROOT, n), path.join(codigo, n)); retirados.push(n); }
    for (const n of nuevos) { mover(path.join(st.staging, n), path.join(ROOT, n)); instalados.push(n); }
    fs.writeFileSync(MANIFIESTO, JSON.stringify(nuevos.concat('.archivos-instalados.json'), null, 2));
  } catch (e) {
    // Si algo falla a mitad, se deshace lo movido y se sigue con la versión anterior
    log('Error al colocar la nueva versión: ' + e.message + '. Se mantiene la versión anterior.');
    for (const n of instalados.reverse()) try { mover(path.join(ROOT, n), path.join(st.staging, n)); } catch {}
    try { fs.rmSync(MANIFIESTO, { force: true }); } catch {}
    for (const n of retirados.reverse()) try { mover(path.join(codigo, n), path.join(ROOT, n)); } catch {}
    escribir({ ...st, estado: 'fallida', motivo: 'No se pudieron sustituir los archivos: ' + e.message });
    return false;
  }
  escribir({ ...st, estado: 'pendiente', retirados, instalados, aplicada: new Date().toISOString() });
  log(`Versión ${st.hasta} colocada. Periodo de prueba: ${st.saludSegundos || 60} s.`);
  return true;
}

// Restaura el código y la base de datos anteriores
function revertir(st, motivo) {
  log(`La versión ${st.hasta} ha fallado (${motivo}). Restaurando la ${st.desde}…`);
  const codigo = path.join(st.copia, 'codigo'), fallida = path.join(st.copia, 'version-fallida');
  for (const n of st.instalados || []) try { if (fs.existsSync(path.join(ROOT, n))) mover(path.join(ROOT, n), path.join(fallida, n)); } catch (e) { log('Aviso: ' + e.message); }
  try { fs.rmSync(MANIFIESTO, { force: true }); } catch {}
  for (const n of st.retirados || []) try { mover(path.join(codigo, n), path.join(ROOT, n)); } catch (e) { log('Aviso al restaurar ' + n + ': ' + e.message); }
  // Base de datos: se guarda la de la versión fallida (por si tuviera datos nuevos) y se recupera la copia previa
  const dbActual = path.join(DATA, 'app.db'), dbCopia = path.join(st.copia, 'app.db');
  try {
    if (fs.existsSync(dbCopia)) {
      fs.mkdirSync(fallida, { recursive: true });
      if (fs.existsSync(dbActual)) fs.copyFileSync(dbActual, path.join(fallida, 'app.db'));
      for (const ext of ['-wal', '-shm', '-journal']) fs.rmSync(dbActual + ext, { force: true });
      fs.copyFileSync(dbCopia, dbActual);
    }
  } catch (e) { log('Aviso al restaurar la base de datos: ' + e.message); }
  escribir({ ...st, estado: 'revertida', motivo, revertida: new Date().toISOString() });
  log(`Versión ${st.desde} restaurada.`);
}

function arrancar() {
  const inicio = Date.now();
  abortarPorSalud = false;
  hijo = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DECA_SUPERVISADO: '1' } });
  const st = leer();
  clearTimeout(temporizadorSalud);
  if (st?.estado === 'pendiente') {
    // Si pasado el periodo de prueba la nueva versión no se ha confirmado (p. ej. se ha quedado colgada), se revierte
    temporizadorSalud = setTimeout(() => {
      if (leer()?.estado === 'pendiente' && hijo) { abortarPorSalud = true; log('La nueva versión no ha confirmado que funciona.'); hijo.kill('SIGTERM'); }
    }, ((st.saludSegundos || 60) + 45) * 1000);
  }
  hijo.on('exit', (code, signal) => {
    hijo = null;
    clearTimeout(temporizadorSalud);
    if (parando) return process.exit(code ?? 0);
    const st = leer();
    if (code === EXIT_ACTUALIZAR) {
      if (st?.estado === 'lista') aplicar(st);
      return arrancar();
    }
    if (st?.estado === 'pendiente') {
      revertir(st, abortarPorSalud ? 'no respondió durante el periodo de prueba' : `se detuvo con el código ${code ?? signal}`);
      return setTimeout(arrancar, 500);
    }
    // Caída normal: se reinicia con una espera que crece si falla nada más arrancar
    fallosSeguidos = Date.now() - inicio < 15000 ? fallosSeguidos + 1 : 0;
    const espera = Math.min(60000, 1000 * 2 ** Math.min(fallosSeguidos, 6));
    log(`El servidor se ha detenido (${code ?? signal}). Reiniciando en ${Math.round(espera / 1000)} s…`);
    setTimeout(arrancar, espera);
  });
}

for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { parando = true; if (hijo) hijo.kill(s); else process.exit(0); });

fs.mkdirSync(DATA, { recursive: true });
// Si el supervisor se detuvo justo cuando había una actualización preparada, se aplica ahora
const inicial = leer();
if (inicial?.estado === 'lista' && fs.existsSync(inicial.staging || '')) aplicar(inicial);
arrancar();
