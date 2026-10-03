'use strict';
// ---- SMTP notifications (Gmail) --------------------------------------------
// Tiny hand-rolled SMTP-over-TLS sender instead of nodemailer: everything in
// nodejs-project.zip ships inside the APK / OTA updates, so zero-dependency
// wins. Speaks the raw protocol on smtp.gmail.com:465 (implicit TLS) with the
// app password.
//
// Sends are serialized on a promise chain and fire-and-forget from the request
// handlers — mail must never delay or break sign-up / feedback, and a failure
// here only logs.

const tls = require('tls');
// set MAIL_DEBUG=1 to get a full wire transcript of each SMTP conversation
const MAIL_DEBUG = !!process.env.MAIL_DEBUG;

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;
const TO = 'nukenoob2010@gmail.com'; // from AND to — a self-notification inbox
const USER = 'nukenoob2010@gmail.com';
// Gmail app password ("rtbx gphg nhvi mjwb" with the spaces stripped)
const PASS = 'rtbxgphgnhvimjwb';
const NUL = String.fromCharCode(0);
const AUTH = Buffer.from(NUL + USER + NUL + PASS).toString('base64');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Subjects stay pure ASCII: RFC 2047 encoded words (=?UTF-8?B?...?=) make
// Gmail DISCARD the message silently — proven live with same-content probes
// (ASCII subject → inbox; encoded em-dash subject → gone, not even Spam).
// Non-ASCII text still reaches you, in the base64 body. Strip CR/LF so a
// title can't forge headers; dash variants map to '-' to keep the wording.
function encSubject(s) {
  const clean = String(s || '')
    .replace(/[‐‒–—―−]/g, '-')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return clean.slice(0, 250) || 'AniNinja notification';
}

function buildMessage(subject, text) {
  const head = [
    `From: AniNinja <${USER}>`,
    `To: <${TO}>`,
    `Subject: ${encSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    // deliberately no Auto-Submitted: Gmail bins same-account auto-generated
    // mail into Spam (or drops it silently) — learned from a live probe
  ];
  // single unwrapped base64 line — the exact body shape of the probe that
  // proved deliverable; wrapped base64 matches it in no visible way, but this
  // is one less delta vs. what Gmail demonstrably accepts
  const body = b64(text);
  return head.join('\r\n') + '\r\n\r\n' + body + '\r\n.\r\n';
}

// One SMTP conversation: greeting → EHLO → AUTH PLAIN → MAIL/RCPT/DATA → QUIT.
function smtpSession(message) {
  return new Promise((resolve, reject) => {
    let sock;
    let done = false;
    const fail = (why) => {
      if (done) return;
      done = true;
      try { sock && sock.destroy(); } catch {}
      reject(new Error(why));
    };
    sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST }, () => start());
    sock.setTimeout(25000, () => fail('timeout'));

    // steps[i] = expect code[i], then run steps[i].next() to send the next
    // command (the EHLO reply is multiline but still ends on "250 ").
    // A step with NO next just waits for its reply (the greeting's EHLO was
    // already sent in start()); ONLY a step with final:true closes the session.
    const steps = [
      { code: 220 },
      { code: 250, next: () => `AUTH PLAIN ${AUTH}\r\n` },
      { code: 235, next: () => `MAIL FROM:<${USER}>\r\n` },
      { code: 250, next: () => `RCPT TO:<${TO}>\r\n` },
      { code: 250, next: () => 'DATA\r\n' },
      { code: 354, next: () => message },
      { code: 250, next: () => 'QUIT\r\n' },
      { code: 221, final: true },
    ];
    let stepIdx = -1;
    let buf = '';
    let lines = [];

    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const cut = buf.lastIndexOf('\r\n');
      if (cut < 0) return; // wait for a whole line
      for (const line of buf.slice(0, cut + 2).split('\r\n')) if (line) lines.push(line);
      buf = buf.slice(cut + 2);
      const last = lines[lines.length - 1];
      if (MAIL_DEBUG) console.log('S:', JSON.stringify(lines));
      const m = /^(\d{3}) (.*)$/.exec(last); // space = final line of the reply
      if (!m) return; // "250-" continuation still streaming
      lines = [];
      const code = Number(m[1]);
      const step = steps[++stepIdx];
      if (!step || code !== step.code) {
        return fail(`unexpected reply at step ${stepIdx}: ${code} ${m[2]}`);
      }
      let out = null;
      try { out = step.next && step.next(); } catch (e) { return fail(String(e)); }
      if (step.final) {
        done = true;
        try { sock.end(); } catch {}
        resolve();
      } else if (out) {
        sock.write(out);
      }
    });
    sock.on('error', (e) => fail(String(e && (e.message || e))));

    function start() {
      try { sock.write('EHLO probe\r\n'); } catch (e) { fail(String(e)); }
    }
  });
}

let chain = Promise.resolve();

function queue(kind, subject, text) {
  chain = chain.then(() => smtpSession(buildMessage(subject, text)))
    .then(() => console.log(`[mail] ${kind} notice sent`))
    .catch((e) => console.error(`[mail] ${kind} notice failed:`, e.message || e));
  return chain;
}

// someone created a fresh Google account on the app (new vs. returning is
// GoTrue's user.created_at, probed by the caller)
function signupNotice(gUser) {
  const when = new Date().toUTCString();
  return queue(
    'signup',
    `New AniNinja sign-up — ${gUser.name || gUser.email}`,
    [
      `A new user just signed up on AniNinja with Google.`,
      ``,
      `When:  ${when}`,
      `Name:  ${gUser.name || '(none)'}`,
      `Email: ${gUser.email || '(unknown)'}`,
      `ID:    ${gUser.id || '(unknown)'}`,
    ].join('\n'),
  );
}

function feedbackNotice(f) {
  const author = f.author || '(unknown)';
  const when = new Date().toUTCString();
  return queue(
    'feedback',
    `AniNinja feedback: ${f.title || '(untitled)'}`,
    [
      `New feedback posted on the AniNinja board.`,
      ``,
      `From:   ${author}`,
      `When:   ${when}`,
      `Title:  ${f.title || '(untitled)'}`,
      f.id ? `Post:   https://supabase.com/dashboard — feedback row ${f.id}` : '',
      ``,
      `----`,
      String(f.body || ''),
    ].join('\n'),
  );
}

module.exports = { signupNotice, feedbackNotice };
// diagnostics hook used by scripts/ (not part of the app surface)
module.exports._internals = { buildMessage, smtpSession, queue };