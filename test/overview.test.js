import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview } from '../src/overview.js';

test('overview: addresses, last backup per stack, size of the newest run, events in order', () => {
  const o = buildOverview({
    domain: 'home.example.com',
    routes: [{ stack: 'cloud', subdomain: 'cloud' }, { stack: 'cloud', subdomain: 'files' }, { stack: 'vault', subdomain: 'vault' }],
    snapshots: [
      { stack: 'cloud', time: '2026-10-30T17:31:00Z', size: 100, run: 'r2' },
      { stack: 'vault', time: '2026-10-30T17:31:00Z', size: 5, run: 'r2' },
      { stack: 'cloud', time: '2026-10-29T17:31:00Z', size: 90, run: 'r1' },
    ],
    backupsConfigured: true,
    backupHistory: [{ at: '2026-10-30T17:31:00Z', kind: 'verify', ok: true }, { at: '2026-10-30T17:30:00Z', kind: 'scheduled', ok: true, stacks: 2 }],
    operations: [{ stack: 'cloud', action: 'restart', status: 'ok', started_at: '2026-10-30 18:00:00' }],
    tunnels: [{ name: 'office', status: { state: 'up' }, stacks: [{ stack: 'x' }] }],
    domainStatus: { enabled: true, domain: 'home.example.com', running: true, certificate: true },
  });
  assert.equal(o.addresses.cloud, 'cloud.home.example.com');
  assert.equal(o.addresses.vault, 'vault.home.example.com');
  assert.deepEqual(o.backup.perStack.cloud, { at: '2026-10-30T17:31:00Z', size: 100 });
  assert.equal(o.backup.lastSize, 105);
  assert.equal(o.backup.last.kind, 'scheduled');
  assert.deepEqual(o.vpn, [{ name: 'office', state: 'up', stacks: 1 }]);
  assert.equal(o.events[0].type, 'action');
  assert.equal(o.events[0].at, '2026-10-30T18:00:00Z');
  assert.equal(o.domain.certificate, true);
  assert.equal(o.serverIp, null);
  assert.equal(buildOverview({ serverIp: '192.168.1.10' }).serverIp, '192.168.1.10');
});

test('overview: nothing set up yet', () => {
  const o = buildOverview({});
  assert.deepEqual(o.addresses, {});
  assert.equal(o.domain.enabled, false);
  assert.equal(o.backup.last, null);
  assert.deepEqual(o.events, []);
});
