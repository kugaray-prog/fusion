/**
 * GeoAttend email relay -- Google Apps Script.
 *
 * Sends the admin verification-code emails from the Google account that
 * deploys this script (services/mailService.js calls it over HTTPS, which
 * works on Render where SMTP is blocked).
 *
 * Setup:
 *   1. script.google.com > New project, paste this file in place of Code.gs.
 *   2. Project Settings (gear) > Script Properties > Add property:
 *        RELAY_SECRET = a long random string (same value as MAIL_RELAY_SECRET)
 *   3. Deploy > New deployment > type "Web app":
 *        Execute as: Me    Who has access: Anyone
 *      Authorize when asked, then copy the Web app URL (ends in /exec)
 *      into MAIL_RELAY_URL.
 *   After editing this file: Deploy > Manage deployments > edit > Version: New version.
 */

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('RELAY_SECRET');
    if (!secret || req.secret !== secret) return reply({ ok: false, error: 'bad_secret' });

    var to = String(req.to || '').trim();
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return reply({ ok: false, error: 'invalid recipient' });
    if (MailApp.getRemainingDailyQuota() < 1) return reply({ ok: false, error: 'daily email quota reached, try again tomorrow' });

    MailApp.sendEmail({
      to: to, // one recipient only
      subject: String(req.subject || '').slice(0, 250),
      body: String(req.text || ''),
      htmlBody: String(req.html || ''),
      name: String(req.name || 'GeoAttend').slice(0, 80)
    });
    return reply({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

// Lets you open the /exec URL in a browser to check the deployment is live.
function doGet() {
  return reply({ ok: true, service: 'GeoAttend mail relay' });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
