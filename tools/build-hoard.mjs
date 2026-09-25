// Builds the PWA of Hypatia's Hoard (served by the local Python server at "/"):
// `npm run build` -> dist-hoard/, which `python -m hypatia` serves.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, VITE_BASE_URL: '/', VITE_HOARD: '1' };
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(args) {
  const result = spawnSync(npx, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['tsc']);
run(['vite', 'build', '--outDir', 'dist-hoard', '--emptyOutDir']);
console.log('Built dist-hoard/ — start the server with: python -m hypatia');
