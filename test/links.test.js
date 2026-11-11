import test from 'node:test';
import assert from 'node:assert/strict';
import { openTargets, portHost } from '../public/links.js';

const containers = [{ ports: ['3001→3001/tcp', '8443→443/tcp', '53→53/udp'] }];

test('links: panel opened by IP – ports on that IP', () => {
  assert.deepEqual(openTargets({ containers, hostname: '192.168.1.10', serverIp: '192.168.1.20' }),
    ['http://192.168.1.10:3001', 'https://192.168.1.10:8443']);
});

test('links: panel opened by its domain – ports on the server address, not the domain', () => {
  assert.deepEqual(openTargets({ containers, hostname: 'panel.example.com', serverIp: '192.168.1.10' }),
    ['http://192.168.1.10:3001', 'https://192.168.1.10:8443']);
});

test('links: a name without a known server address stays as it is', () => {
  assert.equal(portHost('server.local', null), 'server.local');
  assert.equal(portHost('::1', '192.168.1.10'), '[::1]');
});

test('links: a stack with subdomains opens them (https through Caddy), whatever the panel address', () => {
  const routes = [{ subdomain: 'kuma' }, { subdomain: 'kuma' }, { subdomain: 'status' }];
  assert.deepEqual(openTargets({ domain: 'example.com', routes, containers, hostname: 'panel.example.com', serverIp: '192.168.1.10' }),
    ['https://kuma.example.com', 'https://status.example.com']);
  // no subdomains left: back to the ports
  assert.deepEqual(openTargets({ domain: 'example.com', routes: [], containers, hostname: '192.168.1.10' }),
    ['http://192.168.1.10:3001', 'https://192.168.1.10:8443']);
});
