import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const server = resolve(root, 'scripts', 'supervisor.js');
if (!existsSync(server)) {
  console.error('No se encuentra scripts/supervisor.js');
  process.exit(1);
}
console.log('Iniciando 7DeCA con Node...');
const child = spawn(process.execPath, [server], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.PORT || '3000' },
});
child.on('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
