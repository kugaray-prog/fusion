const dns = require('dns').promises;

// Outgoing email (admin verification codes). Two HTTP-based senders --
// Render's free instances block outbound SMTP, so Gmail/SMTP would only
// work on localhost:
//
//   Brevo (https://www.brevo.com, free 300/day)
//     BREVO_API_KEY     API key (Brevo > SMTP & API > API Keys)
//     MAIL_FROM_EMAIL   sender address, verified in Brevo (Senders)
//   Google Apps Script relay (scripts/mail-relay.gs, sends from the Google
//   account that deployed it -- no activation needed)
//     MAIL_RELAY_URL    the script's Web App URL (.../exec)
//     MAIL_RELAY_SECRET the same secret set as RELAY_SECRET in the script
//   MAIL_FROM_NAME      optional display name for both (default "GeoAttend CSPC")
//
// With both set, Brevo is tried first and the relay is the fallback. With
// neither, development servers print the email to the terminal instead;
// production refuses (sendMail throws).

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const FROM_NAME = () => process.env.MAIL_FROM_NAME || 'GeoAttend CSPC';

const hasBrevo = () => Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL);
const hasRelay = () => Boolean(process.env.MAIL_RELAY_URL && process.env.MAIL_RELAY_SECRET);

function isConfigured() {
  return hasBrevo() || hasRelay();
}

async function sendMail({ to, subject, html, text }) {
  if (!isConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('Email sending is not configured on this server (set MAIL_RELAY_URL/MAIL_RELAY_SECRET or BREVO_API_KEY/MAIL_FROM_EMAIL).'), { status: 503 });
    }
    console.log('\n[mail] No email sender configured -- email NOT sent, printed here instead:');
    console.log(`[mail] To: ${to}\n[mail] Subject: ${subject}\n[mail] ${text || html}\n`);
    return { sent: false, printed: true };
  }

  const message = { to, subject, html, text };
  let brevoError = null;
  if (hasBrevo()) {
    try {
      return await sendViaBrevo(message);
    } catch (err) {
      if (!hasRelay()) throw err;
      brevoError = err;
      console.warn(`[mail] Brevo failed (${err.message}); trying the Apps Script relay.`);
    }
  }
  try {
    return await sendViaRelay(message);
  } catch (err) {
    if (brevoError) console.error('[mail] Both senders failed.');
    throw err;
  }
}

async function sendViaBrevo({ to, subject, html, text }) {
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM_EMAIL, name: FROM_NAME() },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[mail] Brevo rejected the email to ${to}: ${res.status} ${body}`);
    throw Object.assign(new Error(`The verification email could not be sent. ${explainBrevoError(res.status, body)}`), { status: 502 });
  }
  return { sent: true, via: 'brevo' };
}

// POSTs to the Apps Script Web App, which sends with MailApp. Apps Script
// answers a POST with a redirect to the result; fetch follows it.
async function sendViaRelay({ to, subject, html, text }) {
  const fail = (reason) => Object.assign(new Error(`The verification email could not be sent. ${reason}`), { status: 502 });
  let res;
  try {
    res = await fetch(process.env.MAIL_RELAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: process.env.MAIL_RELAY_SECRET, to, subject, html, text, name: FROM_NAME() }),
      redirect: 'follow'
    });
  } catch (err) {
    console.error(`[mail] Apps Script relay unreachable: ${err.message}`);
    throw fail('The email relay could not be reached. Check MAIL_RELAY_URL.');
  }
  const body = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(body); } catch (e) { /* HTML = not deployed for "Anyone" */ }
  if (!res.ok || !data || !data.ok) {
    console.error(`[mail] Apps Script relay failed for ${to}: ${res.status} ${body.slice(0, 300)}`);
    if (!data) throw fail('The email relay did not answer. Redeploy the Apps Script as a Web App with access set to "Anyone", and use the URL ending in /exec.');
    if (data.error === 'bad_secret') throw fail('MAIL_RELAY_SECRET does not match RELAY_SECRET in the Apps Script.');
    throw fail(`Apps Script said: ${data.error || `HTTP ${res.status}`}`);
  }
  return { sent: true, via: 'relay' };
}

// Turns Brevo's error response into a fix the admin can act on.
function explainBrevoError(status, body) {
  let message = '';
  try { message = JSON.parse(body).message || ''; } catch (e) { message = body; }
  if (/unrecogni[sz]ed IP/i.test(message)) {
    return 'Brevo blocked this server\'s IP address. In Brevo, open Security > Authorized IPs and deactivate IP blocking (the host\'s IP changes, so it can\'t be allow-listed).';
  }
  if (/not yet activated/i.test(message)) {
    return 'Brevo has not activated email sending on this account yet. Complete your Brevo profile and ask contact@brevo.com to activate transactional email.';
  }
  if (/sender/i.test(message)) {
    return `Brevo rejected the sender: MAIL_FROM_EMAIL (${process.env.MAIL_FROM_EMAIL}) must exactly match a verified sender in Brevo (Senders, Domains & Dedicated IPs > Senders).`;
  }
  if (status === 401) {
    return 'Brevo rejected the API key. BREVO_API_KEY must be an API key (starts with "xkeysib-"), not an SMTP key.';
  }
  return `Brevo said: ${message || `HTTP ${status}`}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A syntactically valid address whose domain can actually receive mail (has
// MX records, or at least an A record as the SMTP fallback). Catches typos
// like "gmial.com" before an OTP is wasted on them. DNS failures other than
// "no such domain" don't block -- the OTP itself proves the inbox exists.
async function checkDeliverable(email) {
  if (!EMAIL_RE.test(email || '')) return { ok: false, reason: 'Enter a valid email address.' };
  const domain = email.split('@')[1].toLowerCase();
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length) return { ok: true };
  } catch (err) {
    if (!['ENOTFOUND', 'ENODATA'].includes(err.code)) return { ok: true };
  }
  try {
    await dns.resolve4(domain);
    return { ok: true };
  } catch (err) {
    if (!['ENOTFOUND', 'ENODATA'].includes(err.code)) return { ok: true };
  }
  return { ok: false, reason: `"${domain}" can't receive email. Check the address for typos.` };
}

module.exports = { sendMail, isConfigured, checkDeliverable };
