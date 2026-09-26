const dns = require('dns').promises;

// Outgoing email through Brevo's HTTP API (https://www.brevo.com — free tier:
// 300 emails/day). HTTP rather than SMTP because Render's free instances
// block outbound SMTP ports, so Gmail/SMTP would work on localhost only.
//
// .env:
//   BREVO_API_KEY     API key (Brevo > SMTP & API > API Keys)
//   MAIL_FROM_EMAIL   sender address, verified in Brevo (Senders & IP > Senders)
//   MAIL_FROM_NAME    optional display name (default "GeoAttend CSPC")
//
// Without BREVO_API_KEY, development servers print the email to the
// terminal instead of sending it; production refuses (sendMail throws).

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

function isConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL);
}

async function sendMail({ to, subject, html, text }) {
  if (!isConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('Email sending is not configured on this server (set BREVO_API_KEY and MAIL_FROM_EMAIL).'), { status: 503 });
    }
    console.log('\n[mail] BREVO_API_KEY / MAIL_FROM_EMAIL not set -- email NOT sent, printed here instead:');
    console.log(`[mail] To: ${to}\n[mail] Subject: ${subject}\n[mail] ${text || html}\n`);
    return { sent: false, printed: true };
  }

  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME || 'GeoAttend CSPC' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[mail] Brevo rejected the email to ${to}: ${res.status} ${body}`);
    throw Object.assign(new Error('The verification email could not be sent. Please try again later.'), { status: 502 });
  }
  return { sent: true };
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
