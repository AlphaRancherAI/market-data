// market-hours.js — CME equity-index futures (ES/NQ) session gate, US Central time.
//
// CME Globe schedule for ES/NQ:
//   Sunday 17:00 CT  →  Friday 16:00 CT
//   Daily maintenance halt: 16:00–17:00 CT (Mon–Thu); also the daily settlement gap.
//
// We treat the session as OPEN whenever it's within the weekly window AND not in the
// 16:00–17:00 CT daily break. This is intentionally simple (no holiday calendar).

// Get current wall-clock parts in America/Chicago without extra deps.
function chicagoParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight
  return { dow: wdMap[parts.weekday], hour, minute: parseInt(parts.minute, 10) };
}

function isFuturesOpen(date = new Date()) {
  const { dow, hour } = chicagoParts(date);
  // Saturday: always closed.
  if (dow === 6) return false;
  // Sunday: opens at 17:00 CT.
  if (dow === 0) return hour >= 17;
  // Friday: closes at 16:00 CT.
  if (dow === 5) return hour < 16;
  // Mon–Thu: open all day except the 16:00–17:00 maintenance break.
  return !(hour === 16);
}

module.exports = { isFuturesOpen, chicagoParts };
