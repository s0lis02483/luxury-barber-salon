/**
 * api/calendar.js — Luxury Barber Salon · Google Calendar + Resend email
 *
 * GET  /api/calendar?date=YYYY-MM-DD
 *   → { date, slots: [{ time:'HH:MM', busy:bool }, ...] }
 *
 * POST /api/calendar
 *   Body: { name, email, service, serviceName, date, time, price, duration, lang }
 *   → { eventId, eventLink, message }
 */

const { google } = require('googleapis');
const { Resend }  = require('resend');

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

/* ── Email ────────────────────────────────────────────────────────── */

function fmtDateLong(dateStr, lang) {
  const locale = lang === 'en' ? 'en-US' : 'sl-SI';
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString(locale, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function fmtTimeFmt(timeStr, lang) {
  const [h, m] = timeStr.split(':').map(Number);
  if (lang === 'en') {
    const ap = h >= 12 ? 'PM' : 'AM';
    const hr = h > 12 ? h - 12 : h === 0 ? 12 : h;
    return `${hr}:${String(m).padStart(2, '0')} ${ap}`;
  }
  return `${h}:${String(m).padStart(2, '0')}`;
}

function buildEmail({ name, serviceName, date, time, price, duration, lang }) {
  const isSl   = lang !== 'en';
  const L = isSl ? {
    subject:  `Potrditev rezervacije — ${serviceName}`,
    greeting: `Vidimo se kmalu, ${name}!`,
    sub:      'Vaša rezervacija je potrjena. Spodaj so podrobnosti termina.',
    rows: [
      ['Storitev',  serviceName],
      ['Datum',     fmtDateLong(date, 'sl')],
      ['Čas',       fmtTimeFmt(time, 'sl')],
      ['Trajanje',  `${duration} min`],
      ['Cena',      `€${price}`],
    ],
    info:   'V primeru sprememb nas pokličite vsaj 2 uri pred terminom.',
    footer: '© Luxury Barber Salon · Kjer tradicija sreča eleganco',
  } : {
    subject:  `Booking Confirmed — ${serviceName}`,
    greeting: `See you soon, ${name}!`,
    sub:      'Your appointment is confirmed. Here are the details.',
    rows: [
      ['Service',   serviceName],
      ['Date',      fmtDateLong(date, 'en')],
      ['Time',      fmtTimeFmt(time, 'en')],
      ['Duration',  `${duration} min`],
      ['Price',     `€${price}`],
    ],
    info:   'If you need to reschedule, please call us at least 2 hours in advance.',
    footer: '© Luxury Barber Salon · Where Craft Meets Luxury',
  };

  const rows = L.rows.map(([label, value]) => `
    <tr>
      <td style="padding:13px 0;border-bottom:1px solid #1e1e1e;vertical-align:top;width:38%;">
        <span style="font-family:Helvetica,Arial,sans-serif;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#555;">${label}</span>
      </td>
      <td style="padding:13px 0 13px 16px;border-bottom:1px solid #1e1e1e;vertical-align:top;">
        <span style="font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:300;color:#FAFAFA;">${value}</span>
      </td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="${lang || 'sl'}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:48px 20px;">
  <tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

    <!-- logo bar -->
    <tr><td style="padding-bottom:32px;border-bottom:1px solid #1e1e1e;text-align:center;">
      <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:#C9A84C;">
        ✦&nbsp;&nbsp;Luxury Barber Salon&nbsp;&nbsp;✦
      </p>
    </td></tr>

    <!-- confirmed badge + greeting -->
    <tr><td style="padding:36px 0 28px;text-align:center;">
      <p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:#4ade80;">
        ✓&nbsp; ${isSl ? 'Rezervacija potrjena' : 'Booking Confirmed'}
      </p>
      <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:300;color:#FAFAFA;line-height:1.25;">
        ${L.greeting}
      </h1>
      <p style="margin:14px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.7;color:#666;">
        ${L.sub}
      </p>
    </td></tr>

    <!-- details card -->
    <tr><td style="background:#111;border:1px solid #242424;border-top:2px solid #C9A84C;padding:8px 24px 4px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${rows}
      </table>
    </td></tr>

    <!-- info note -->
    <tr><td style="padding:24px 0 0;">
      <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.7;color:#555;text-align:center;">
        ${L.info}
      </p>
    </td></tr>

    <!-- address -->
    <tr><td style="padding:20px 0;text-align:center;">
      <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.8;color:#444;">
        123 Luxury Avenue, New York, NY<br>+1 (555) 000-0000
      </p>
    </td></tr>

    <!-- footer -->
    <tr><td style="border-top:1px solid #1a1a1a;padding:20px 0 0;text-align:center;">
      <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#2a2a2a;">
        ${L.footer}
      </p>
    </td></tr>

  </table>
  </td></tr>
</table>
</body></html>`;

  return { subject: L.subject, html };
}

async function sendConfirmationEmail({ name, email, serviceName, date, time, price, duration, lang }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set — skipping email');
    return;
  }
  const resend = new Resend(apiKey);
  const { subject, html } = buildEmail({ name, serviceName, date, time, price, duration, lang });
  try {
    await resend.emails.send({
      from:    'onboarding@resend.dev',
      to:      email,
      subject,
      html,
    });
    console.log(`[email] Sent confirmation to ${email}`);
  } catch (err) {
    // Email failure must never break the booking — log and continue
    console.error('[email] Send failed:', err.message);
  }
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

    /* ── POST: create a booking event + send confirmation email ────── */
    if (req.method === 'POST') {
      const { name, email, service, serviceName, date, time, price, duration, lang } = req.body || {};

      if (!name || !email || !date || !time || !serviceName) {
        return res.status(400).json({ error: 'Missing required fields: name, email, date, time, serviceName' });
      }

      const dur    = Number(duration) || 60;
      const offset = getOffset(date);

      // ── Authoritative double-booking check ──────────────────────────
      // Query freebusy for the exact slot duration before creating the
      // event. This blocks both existing bookings AND personal calendar
      // events that overlap the requested window.
      const slotStart = localToDate(date, time, offset);
      const slotEnd   = new Date(slotStart.getTime() + dur * 60 * 1000);

      const fbCheck = await calendar.freebusy.query({
        requestBody: {
          timeMin:  slotStart.toISOString(),
          timeMax:  slotEnd.toISOString(),
          timeZone: TIMEZONE,
          items:    [{ id: CALENDAR_ID }],
        },
      });

      const alreadyBusy = fbCheck.data.calendars?.[CALENDAR_ID]?.busy || [];
      if (alreadyBusy.length > 0) {
        return res.status(409).json({
          error:   'slot_taken',
          message: 'This time slot is no longer available. Please choose a different time.',
        });
      }
      // ─────────────────────────────────────────────────────────────────

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

      // Send confirmation email to the customer (non-blocking)
      await sendConfirmationEmail({ name, email, serviceName, date, time, price, duration, lang });

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
