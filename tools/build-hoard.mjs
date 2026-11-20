// Builds the PWA of Hypatia's Hoard (served by the local Python server at "/"):
// `npm run build` -> dist-hoard/, which `python -m hypatia` serves.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEnv } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, VITE_BASE_URL: '/', VITE_HOARD: '1' };
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Carry forward published donation destinations when rebuilding an existing local installation.
const donationPatterns = {
  VITE_DONATION_PAYPAL_URL: /https:\/\/www\.paypal\.com\/donate\/\?[^"'\s\\<>]+/,
  VITE_DONATION_COFFEE_URL: /https:\/\/buymeacoffee\.com\/[a-zA-Z0-9_-]+/,
};
const configured = loadEnv('production', root);
const inherited = Object.entries(donationPatterns).filter(([key]) => !Object.hasOwn(configured, key));
if (inherited.length) {
  const previousDist = path.join(root, 'dist-hoard');
  try {
    const html = readFileSync(path.join(previousDist, 'index.html'), 'utf8');
    const entry = html.match(/src="\/assets\/(index-[\w-]+\.js)"/)?.[1];
    const bundle = entry ? readFileSync(path.join(previousDist, 'assets', entry), 'utf8') : '';
    for (const [key, pattern] of inherited) {
      const url = bundle.match(pattern)?.[0];
      if (url) env[key] = url;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function run(args) {
  const result = spawnSync(npx, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['tsc']);
run(['vite', 'build', '--outDir', 'dist-hoard', '--emptyOutDir']);
console.log('Built dist-hoard/ — start the server with: python -m hypatia');
