#!/usr/bin/env node
// Crea el paquete firmado de una versión: release/gestor-deca-ecmr-<versión>.tar.gz y su firma .sig (Ed25519).
// Incluye el código y las dependencias de producción, así que la instalación no necesita descargar nada de npm.
// La clave privada se lee de DECA_CLAVE_FIRMA (contenido PEM, p. ej. desde un secreto de GitHub) o de
// ~/.gestor-deca/clave-firma-actualizaciones.pem. Nunca se guarda en el repositorio.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const raiz = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
const NOMBRE = pkg.name; // el actualizador busca <name>-<versión>.tar.gz
const salida = path.join(raiz, 'release');
const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'deca-release-'));
const destino = path.join(trabajo, NOMBRE);

const ARCHIVOS = ['server.js', 'actualizaciones.js', 'seguridad.js', 'integracion.js', 'plugins.js', 'clave-actualizaciones.pem', 'public', 'scripts', 'docs',
  'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'icon.svg', 'manifest.webmanifest', 'Dockerfile',
  'docker-compose.example.yml', '.dockerignore', '.gitignore'];

const pem = process.env.DECA_CLAVE_FIRMA || (() => {
  try { return fs.readFileSync(path.join(os.homedir(), '.gestor-deca', 'clave-firma-actualizaciones.pem'), 'utf8'); } catch { return null; }
})();
if (!pem) { console.error('Falta la clave privada de firma (DECA_CLAVE_FIRMA o ~/.gestor-deca/clave-firma-actualizaciones.pem).'); process.exit(1); }
const clave = crypto.createPrivateKey(pem);
// La clave privada debe corresponder a la pública incluida en el código; si no, las instalaciones rechazarían el paquete
const publica = crypto.createPublicKey(fs.readFileSync(path.join(raiz, 'clave-actualizaciones.pem'), 'utf8'));
if (crypto.createPublicKey(clave).export({ type: 'spki', format: 'der' }).compare(publica.export({ type: 'spki', format: 'der' })) !== 0) {
  console.error('La clave privada no corresponde a clave-actualizaciones.pem.'); process.exit(1);
}

console.log(`Preparando ${NOMBRE} ${pkg.version}…`);
fs.mkdirSync(destino, { recursive: true });
for (const f of ARCHIVOS) if (fs.existsSync(path.join(raiz, f))) fs.cpSync(path.join(raiz, f), path.join(destino, f), { recursive: true });
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destino, stdio: 'inherit' });
// Los enlaces simbólicos no se admiten en las actualizaciones (y .bin no hace falta)
fs.rmSync(path.join(destino, 'node_modules', '.bin'), { recursive: true, force: true });
fs.rmSync(path.join(destino, 'node_modules', '.package-lock.json'), { force: true });

// Comprobación: el paquete debe arrancar por sí solo. Se cargan server.js y todos sus módulos con datos temporales;
// si falta un archivo (p. ej. un módulo nuevo que no está en ARCHIVOS), se detiene antes de firmar nada.
for (const f of fs.readdirSync(raiz).filter((x) => x.endsWith('.js') && !ARCHIVOS.includes(x))) {
  console.error(`${f} no está en la lista de archivos del paquete (ARCHIVOS).`); process.exit(1);
}
const datosPrueba = fs.mkdtempSync(path.join(os.tmpdir(), 'deca-release-datos-'));
try {
  execFileSync(process.execPath, ['-e', "require('./server.js'); process.exit(0)"], { cwd: destino, env: { ...process.env, DECA_DATA: datosPrueba, WHATSAPP_API: '' }, stdio: 'pipe' });
  console.log('Comprobación del paquete: server.js y sus módulos cargan correctamente.');
} catch (e) {
  console.error(`El paquete no arranca:\n${String(e.stderr || e.message).slice(0, 2000)}`); process.exit(1);
} finally { fs.rmSync(datosPrueba, { recursive: true, force: true }); }

fs.mkdirSync(salida, { recursive: true });
const archivo = path.join(salida, `${NOMBRE}-${pkg.version}.tar.gz`);
execFileSync('tar', ['--no-xattrs', '-czf', archivo, '-C', trabajo, NOMBRE], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const firma = crypto.sign(null, fs.readFileSync(archivo), clave).toString('base64');
fs.writeFileSync(archivo + '.sig', firma + '\n');
fs.rmSync(trabajo, { recursive: true, force: true });

if (!crypto.verify(null, fs.readFileSync(archivo), publica, Buffer.from(firma, 'base64'))) { console.error('La firma no se ha podido comprobar.'); process.exit(1); }
console.log(`Paquete: ${path.relative(raiz, archivo)} (${(fs.statSync(archivo).size / 1048576).toFixed(1)} MB), firmado.`);
