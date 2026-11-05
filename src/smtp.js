// A small SMTP client for notification e-mails (no extra packages): plain, STARTTLS or TLS
// from the start, AUTH PLAIN/LOGIN, one message with a UTF-8 subject and text body.
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
/** "=?UTF-8?B?...?=" when the text is not plain ASCII. */
export const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');

/** The whole message as sent after DATA (dot-stuffed, CRLF line ends). */
export function buildMessage({ from, to, subject, text, date = new Date(), messageId }) {
  const head = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId || `${Date.now()}.${Math.random().toString(36).slice(2)}@stackmoor`}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ].join('\r\n');
  return `${head}\r\n\r\n${wrap76(b64(text))}`;
}

/** Reads SMTP replies (multi-line "250-…" until "250 …"). */
function replies(socket) {
  let buf = '';
  let lines = [];
  let failure = null;
  const waiting = [];
  const queue = [];
  // The connection closed, reset or timed out: every wait ends with an error.
  const fail = (err) => {
    if (failure) return;
    failure = err instanceof Error ? err : new SmtpError('the server closed the connection');
    while (waiting.length) waiting.shift().reject(failure);
  };
  const onError = (err) => fail(err);
  const onClose = () => fail(null);
  socket.on('error', onError);
  socket.on('close', onClose);
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
        lines = [];
        if (waiting.length) waiting.shift().resolve(reply); else queue.push(reply);
      }
    }
  };
  socket.on('data', onData);
  return {
    next: () => {
      if (queue.length) return Promise.resolve(queue.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    // Before STARTTLS: the plain socket is handed to TLS, its own events no longer matter.
    stop: () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); socket.on('error', () => {}); },
  };
}

export class SmtpError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * Sends one e-mail. security: 'tls' (port 465), 'starttls' (587) or 'none' (25, LAN relays).
 * insecure: accept a self-signed certificate (a server in the home network).
 */
export async function sendMail({ host, port, security = 'starttls', user = '', pass = '', insecure = false, from, to, subject, text, timeout = 20000 }) {
  const recipients = (Array.isArray(to) ? to : String(to).split(',')).map((x) => x.trim()).filter(Boolean);
  if (!host || !from || !recipients.length) throw new SmtpError('missing host, sender or recipient');
  const tlsOpts = { servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !insecure };
  let socket = await new Promise((resolve, reject) => {
    const s = security === 'tls'
      ? tls.connect({ host, port, ...tlsOpts }, () => resolve(s))
      : net.connect({ host, port }, () => resolve(s));
    s.setTimeout(timeout, () => s.destroy(new SmtpError('timeout')));
    s.once('error', reject);
  });
  socket.on('error', () => {}); // errors are handled by replies(); this keeps a late one from crashing the panel
  let r = replies(socket);
  const failed = (step, reply) => new SmtpError(`${step}: ${reply.text.split('\n').pop()}`, reply.code);
  const cmd = async (line, ok, step = line.split(' ')[0]) => {
    socket.write(`${line}\r\n`);
    const reply = await r.next();
    if (!ok.includes(reply.code)) throw failed(step, reply);
    return reply;
  };
  try {
    let reply = await r.next();
    if (reply.code !== 220) throw failed('greeting', reply);
    const me = os.hostname().replace(/[^\w.-]/g, '') || 'stackmoor';
    let ehlo = await cmd(`EHLO ${me}`, [250]);
    if (security === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError('the server does not offer STARTTLS');
      await cmd('STARTTLS', [220]);
      r.stop();
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, ...tlsOpts }, () => resolve(s));
        s.once('error', reject);
      });
      socket.on('error', () => {});
      socket.setTimeout(timeout, () => socket.destroy(new SmtpError('timeout')));
      r = replies(socket);
      ehlo = await cmd(`EHLO ${me}`, [250]);
    }
    if (user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
        await cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235], 'AUTH');
      } else {
        await cmd('AUTH LOGIN', [334], 'AUTH');
        await cmd(b64(user), [334], 'AUTH');
        await cmd(b64(pass), [235], 'AUTH');
      }
    }
    const addr = (x) => (x.match(/<([^>]+)>/)?.[1] || x).trim();
    await cmd(`MAIL FROM:<${addr(from)}>`, [250], 'MAIL FROM');
    for (const rcpt of recipients) await cmd(`RCPT TO:<${addr(rcpt)}>`, [250, 251], 'RCPT TO');
    await cmd('DATA', [354]);
    const body = buildMessage({ from, to: recipients, subject, text }).replace(/^\./gm, '..');
    reply = await cmd(`${body}\r\n.`, [250], 'DATA');
    socket.write('QUIT\r\n');
    return { ok: true, reply: reply.text };
  } finally {
    setTimeout(() => socket.destroy(), 200).unref?.();
  }
}
