// One-time setup code. Until the administrator account exists, everyone who can reach the
// panel could create it or restore a server from their own backup. The code proves that
// the person in the browser can also read the server (install.sh output or `docker logs`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// No 0/O, 1/I/L: easy to read out loud and to type.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 12;

/** "ab cd-ef…" → "ABCDEF…": spaces and dashes do not matter, nor does letter case. */
export const normalizeCode = (value) => String(value ?? '').toUpperCase().replace(/[\s-]/g, '');

/** "ABCDEFGHJKMN" → "ABCD-EFGH-JKMN" */
export const formatCode = (code) => code.match(/.{1,4}/g).join('-');

function newCode() {
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

export function createSetupToken({ dataDir, hasUsers }) {
  const file = path.join(dataDir, 'setup-token');

  function read() {
    try {
      return normalizeCode(fs.readFileSync(file, 'utf8')) || null;
    } catch {
      return null;
    }
  }

  function clear() {
    fs.rmSync(file, { force: true });
  }

  /** The code to show, created on first use. None (and the file removed) once an account exists. */
  function ensure() {
    if (hasUsers()) {
      clear();
      return null;
    }
    let code = read();
    if (!code) {
      code = newCode();
      fs.writeFileSync(file, `${formatCode(code)}\n`, { mode: 0o600 });
    }
    return formatCode(code);
  }

  /** True when the value matches the saved code (constant-time compare). */
  function check(value) {
    const code = read();
    const given = normalizeCode(value);
    if (!code || !given) return false;
    const a = Buffer.from(code);
    const b = Buffer.from(given);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return { ensure, check, clear, file };
}
