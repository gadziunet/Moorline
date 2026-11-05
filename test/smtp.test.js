import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sendMail, buildMessage, encodeHeader } from '../src/smtp.js';

/** A tiny pretend SMTP server: records commands and the message. */
function fakeServer({ cert, auth = 'PLAIN LOGIN' } = {}) {
  const seen = { commands: [], data: '' };
  const server = net.createServer((raw) => {
    let sock = raw;
    let inData = false;
    let buf = '';
    const say = (l) => sock.write(`${l}\r\n`);
    const onData = (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; say('250 2.0.0 queued as 1234'); } else seen.data += `${line}\n`;
          continue;
        }
        seen.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          sock.write(`250-fake.example.com\r\n${cert && sock === raw ? '250-STARTTLS\r\n' : ''}250-AUTH ${auth}\r\n250 8BITMIME\r\n`);
        } else if (verb === 'STARTTLS') {
          say('220 go ahead');
          raw.off('data', onData);
          sock = new tls.TLSSocket(raw, { isServer: true, ...cert });
          sock.on('data', onData);
        } else if (verb === 'AUTH') {
          if (line.startsWith('AUTH PLAIN')) say(Buffer.from(line.split(' ')[2], 'base64').toString() === '\0panel\0s3cret' ? '235 ok' : '535 5.7.8 Authentication failed');
          else say('334 VXNlcm5hbWU6');
        } else if (verb === 'DATA') { inData = true; say('354 end with .'); } else if (verb === 'QUIT') { say('221 bye'); sock.end(); } else say('250 ok');
      }
    };
    sock.on('data', onData);
    say('220 fake.example.com ESMTP');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => server.close() })));
}

const mail = { from: 'Stackmoor <panel@example.com>', to: 'me@example.com', subject: 'Kopia się nie udała', text: 'Linia 1\n.kropka na początku\nzażółć' };

test('message: UTF-8 subject, base64 body', () => {
  assert.equal(encodeHeader('Backup done'), 'Backup done');
  assert.equal(encodeHeader('Kopia się nie udała'), `=?UTF-8?B?${Buffer.from('Kopia się nie udała').toString('base64')}?=`);
  const m = buildMessage({ ...mail, to: ['me@example.com'], messageId: 'x@y' });
  assert.match(m, /Content-Type: text\/plain; charset=utf-8/);
  const body = m.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString(), mail.text);
});

test('sends through a plain SMTP server with a login', async () => {
  const srv = await fakeServer();
  try {
    const r = await sendMail({ ...mail, host: '127.0.0.1', port: srv.port, security: 'none', user: 'panel', pass: 's3cret' });
    assert.equal(r.ok, true);
    assert.deepEqual(srv.seen.commands.slice(1, 5).map((c) => c.split(' ')[0]), ['AUTH', 'MAIL', 'RCPT', 'DATA']);
    assert.equal(srv.seen.commands[2], 'MAIL FROM:<panel@example.com>');
    assert.match(srv.seen.data, /Subject: =\?UTF-8\?B\?/);
  } finally { srv.close(); }
});

test('a wrong password comes back as a readable error', async () => {
  const srv = await fakeServer();
  try {
    await assert.rejects(sendMail({ ...mail, host: '127.0.0.1', port: srv.port, security: 'none', user: 'panel', pass: 'nope' }), /AUTH: 535 5.7.8 Authentication failed/);
  } finally { srv.close(); }
});

let cert = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-smtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  cert = { key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) };
} catch { /* no openssl here – skip the TLS test */ }

test('STARTTLS: upgrades the connection; a self-signed certificate needs "insecure"', { skip: !cert && 'openssl not available' }, async () => {
  const srv = await fakeServer({ cert });
  try {
    await assert.rejects(sendMail({ ...mail, host: '127.0.0.1', port: srv.port, security: 'starttls', user: 'panel', pass: 's3cret' }), /self-signed|certificate/i);
    const r = await sendMail({ ...mail, host: '127.0.0.1', port: srv.port, security: 'starttls', user: 'panel', pass: 's3cret', insecure: true });
    assert.equal(r.ok, true);
    assert.ok(srv.seen.commands.includes('STARTTLS'));
  } finally { srv.close(); }
});

test('a server that goes silent or closes ends with an error instead of waiting forever', async () => {
  const silent = net.createServer((s) => s.write('220 hello\r\n'));
  const closing = net.createServer((s) => { s.write('220 hello\r\n'); s.on('data', () => s.destroy()); });
  await Promise.all([silent, closing].map((x) => new Promise((r) => x.listen(0, '127.0.0.1', r))));
  try {
    await assert.rejects(sendMail({ ...mail, host: '127.0.0.1', port: silent.address().port, security: 'none', timeout: 300 }), /timeout/);
    await assert.rejects(sendMail({ ...mail, host: '127.0.0.1', port: closing.address().port, security: 'none' }), /closed the connection|ECONNRESET/);
  } finally { silent.close(); closing.close(); }
});
