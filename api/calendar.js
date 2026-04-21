/**
 * api/calendar.js — Luxury Barber Salon · Google Calendar integration
 *
 * GET  /api/calendar?date=YYYY-MM-DD
 *   → { date, slots: [{ time:'HH:MM', busy:bool }, ...] }
 *
 * POST /api/calendar
 *   Body: { name, email, service, serviceName, date, time, price, duration }
 *   → { eventId, eventLink, message }
 */

const { google } = require('googleapis');

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const TIMEZONE    = 'Europe/Ljubljana';

/* ── Auth ─────────────────────────────────────────────────────────── */
function getAuth() {
  const email      = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!email || !privateKey) {
    throw new Error('Missing Google service account credentials (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY)');
  }

  return new google.auth.JWT(
    email,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/calendar'],
  );
}

/* ── Timezone helpers ─────────────────────────────────────────────── */

/**
 * Returns the UTC offset (in hours) for Europe/Ljubljana on a given date.
 * CEST (UTC+2) runs from last Sunday of March 01:00 UTC
 * to last Sunday of October 01:00 UTC.
 */
function getOffset(dateStr) {
  const d    = new Date(dateStr + 'T12:00:00Z');
  const year = d.getUTCFullYear();

  const lastSundayOf = (month) => {
    const last = new Date(Date.UTC(year, month, 31));
    last.setUTCDate(31 - last.getUTCDay()); // roll back to last Sunday
    last.setUTCHours(1, 0, 0, 0);           // 01:00 UTC = transition moment
    return last;
  };

  const dstStart = lastSundayOf(2);  // March
  const dstEnd   = lastSundayOf(9);  // October

  return d >= dstStart && d < dstEnd ? 2 : 1;
}

/** Convert a local Ljubljana date+time string to a UTC Date object. */
function localToDate(dateStr, timeStr, offsetHours) {
  const [y, mo, day] = dateStr.split('-').map(Number);
  const [h, m]       = timeStr.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, day, h - offsetHours, m, 0));
}

/** Add minutes to a HH:MM time string and return a new HH:MM string. */
function addMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const total  = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/* ── Slot generation ──────────────────────────────────────────────── */
// Salon open 09:00–19:00; generate 30-min slots 09:00 → 18:30
function generateSlots() {
  const slots = [];
  for (let h = 9; h < 19; h++) {
    for (const m of [0, 30]) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
}

/* ── Handler ──────────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  // CORS (same-origin in production, but handy for local dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!CALENDAR_ID) {
    return res.status(500).json({ error: 'GOOGLE_CALENDAR_ID environment variable not set' });
  }

  let calendar;
  try {
    calendar = google.calendar({ version: 'v3', auth: getAuth() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  try {
    /* ── GET: busy slots for a date ─────────────────────────────────── */
    if (req.method === 'GET') {
      const { date } = req.query;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
      }

      const offset = getOffset(date);
      const pad    = String(offset).padStart(2, '0');
      const timeMin = `${date}T00:00:00+${pad}:00`;
      const timeMax = `${date}T23:59:59+${pad}:00`;

      const fb = await calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          timeZone: TIMEZONE,
          items: [{ id: CALENDAR_ID }],
        },
      });

      const busyPeriods = fb.data.calendars?.[CALENDAR_ID]?.busy || [];

      const slots = generateSlots().map((time) => {
        const slotStart = localToDate(date, time, offset);
        const slotEnd   = new Date(slotStart.getTime() + 30 * 60 * 1000);

        const isBusy = busyPeriods.some((p) => {
          const bs = new Date(p.start);
          const be = new Date(p.end);
          return slotStart < be && slotEnd > bs; // overlap test
        });

        return { time, busy: isBusy };
      });

      return res.status(200).json({ date, slots });
    }

    /* ── POST: create a booking event ───────────────────────────────── */
    if (req.method === 'POST') {
      const { name, email, service, serviceName, date, time, price, duration } = req.body || {};

      if (!name || !email || !date || !time || !serviceName) {
        return res.status(400).json({ error: 'Missing required fields: name, email, date, time, serviceName' });
      }

      const dur     = Number(duration) || 60;
      const endTime = addMinutes(time, dur);

      const event = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: `${serviceName} — ${name}`,
          description: [
            `Stranka / Client: ${name}`,
            `E-pošta / Email:  ${email}`,
            `Storitev / Service: ${serviceName}`,
            `Trajanje / Duration: ${dur} min`,
            `Cena / Price: €${price}`,
          ].join('\n'),
          start: { dateTime: `${date}T${time}:00`, timeZone: TIMEZONE },
          end:   { dateTime: `${date}T${endTime}:00`, timeZone: TIMEZONE },
          colorId: '5', // banana / gold
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'email',  minutes: 24 * 60 }, // 1 day before
              { method: 'popup',  minutes: 60 },       // 1 hour before
            ],
          },
        },
      });

      return res.status(201).json({
        eventId:   event.data.id,
        eventLink: event.data.htmlLink,
        message:   'Booking created successfully',
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[calendar API]', err?.response?.data || err.message);
    return res.status(500).json({
      error:   'Google Calendar API error',
      message: err?.response?.data?.error?.message || err.message,
    });
  }
};
