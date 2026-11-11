import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, verifyNobody, loginRateLimit } from '../src/auth.js';

test('passwords: hashed asynchronously, checked, wrong ones and broken hashes refused', async () => {
  const h = await hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong password!', h), false);
  assert.equal(await verifyPassword('anything', 'md5$abc'), false);
  assert.equal(await verifyNobody('anything'), false);
});

test('passwords: an unknown user takes about as long as a real one', async () => {
  const h = await hashPassword('correct horse battery');
  const time = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  await verifyNobody('x'); // first call prepares the stand-in hash
  const real = await time(() => verifyPassword('wrong password!', h));
  const nobody = await time(() => verifyNobody('wrong password!'));
  assert.ok(nobody > real / 3, `unknown user ${nobody} ms vs real ${real} ms`);
});

test('login limit: 10 tries per address, then 429; another address has its own count', () => {
  const run = (ip) => {
    const out = {};
    const res = { status(c) { out.status = c; return this; }, json() { return this; } };
    loginRateLimit({ ip, t: (k) => k }, res, () => { out.next = true; });
    return out;
  };
  for (let i = 0; i < 10; i += 1) assert.ok(run('192.168.1.50').next);
  assert.equal(run('192.168.1.50').status, 429);
  assert.ok(run('192.168.1.51').next);
});

test('login limit: IPv6 addresses of one /64 share a count', () => {
  const run = (ip) => {
    const out = {};
    const res = { status(c) { out.status = c; return this; }, json() { return this; } };
    loginRateLimit({ ip, t: (k) => k }, res, () => { out.next = true; });
    return out;
  };
  for (let i = 1; i <= 10; i += 1) assert.ok(run(`2001:db8:1:2::${i.toString(16)}`).next);
  assert.equal(run('2001:db8:1:2:abcd:ef01:2345:6789').status, 429);
  assert.ok(run('2001:db8:1:3::1').next); // another /64
});
