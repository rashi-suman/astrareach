'use strict';

const { toDate, formatInTimeZone } = require('date-fns-tz');

/**
 * Interpret date + clock time in an IANA timezone as one absolute instant (UTC-backed Date).
 * @param {string} dateStr - YYYY-MM-DD from <input type="date">
 * @param {string} timeStr - HH:mm or HH:mm:ss from <input type="time">
 * @param {string} timeZone - e.g. Asia/Kolkata
 * @returns {Date|null}
 */
function scheduledInstantFromParts(dateStr, timeStr, timeZone) {
  if (!dateStr || !timeStr) return null;
  const tz = timeZone && String(timeZone).trim() ? timeZone : 'UTC';
  const t = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
  const d = toDate(`${dateStr}T${t}`, { timeZone: tz });
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Current HH:mm in a zone (for matching daily send window). */
function clockHHMMInZone(date, timeZone) {
  const tz = timeZone && String(timeZone).trim() ? timeZone : 'UTC';
  return formatInTimeZone(date, tz, 'HH:mm');
}

module.exports = { scheduledInstantFromParts, clockHHMMInZone };
