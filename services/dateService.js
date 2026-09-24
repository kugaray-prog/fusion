/**
 * Returns a date as 'YYYY-MM-DD' in the server's local timezone (pinned to
 * Asia/Manila in server.js). Use this instead of toISOString().slice(0, 10),
 * which gives the UTC date -- 8 hours behind, so anything between midnight and
 * 8:00 AM Philippine time landed on the previous day.
 */
function localDate(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = { localDate };
