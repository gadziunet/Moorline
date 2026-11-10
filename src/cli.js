// Small maintenance commands, run inside the container:
//   docker exec stackmoor node src/cli.js unlock       – allow opening the panel by IP again
//   docker exec stackmoor node src/cli.js setup-code   – show the one-time setup code
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { openDb, saveSettings } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const [cmd] = process.argv.slice(2);

if (cmd === 'unlock') {
  const db = openDb(path.join(dataDir, 'panel.db'));
  saveSettings(db, { panelDomainOnly: false });
  console.log('The panel can be opened by IP address again.');
} else if (cmd === 'setup-code') {
  // Read-only: the panel creates the code on start and removes it once the account exists.
  let code = '';
  try { code = fs.readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim(); } catch { /* none */ }
  if (!code) {
    console.error('No setup code – the administrator account already exists.');
    process.exit(2);
  }
  console.log(code);
} else {
  console.log('Usage: node src/cli.js unlock | setup-code');
  process.exit(cmd ? 1 : 0);
}
