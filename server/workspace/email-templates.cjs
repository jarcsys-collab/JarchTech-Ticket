// Email wording and layout. One short message per event: who acted, what happened, what to do next, and one button that
// opens the request inside the app. Deliberately no descriptions, comments, evidence, files, credentials, or tokens.
// Everything people can type (names, titles, locations) is escaped for HTML and stripped of control characters.
const DeadlineCore = require('../../public/deadline-core.js');

const TITLE_MAX = 150, NAME_MAX = 120, LOCATION_MAX = 200, TEXT_MAX = 2000;
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Meetings are stored as the date and time people entered, in workspace time, so they are shown as entered: no conversion.
function meetingTime(value, timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m) return '';
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const text = new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
  return `${text} (${timezone})`;
}

const NOT_AN_INVITE = 'This is a notification, not a calendar invitation.';
const EVENTS = {
  assigned: { subject: 'Assigned to you', did: 'assigned this request to you.', next: 'Open the request to see the requirements and your next step.', button: 'Open request' },
  reassigned: { subject: 'Reassigned to you', did: 'reassigned this request to you.', next: 'Open the request to see where the work stands and your next step.', button: 'Open request' },
  'meeting-proposed': { subject: 'Requirements meeting proposed', did: 'proposed a requirements meeting.', next: 'Open the meeting details and confirm it in the app.', button: 'View meeting', note: NOT_AN_INVITE },
  'meeting-changed': { subject: 'Requirements meeting changed', did: 'changed the requirements meeting.', next: 'Open the meeting details and confirm the new time in the app.', button: 'View meeting', note: NOT_AN_INVITE },
  'meeting-confirmed': { subject: 'Requirements meeting confirmed', did: 'confirmed the requirements meeting.', next: 'After the meeting, record the agreed requirements in the app.', button: 'View meeting', note: NOT_AN_INVITE },
  'agreement-confirm': { subject: 'Agreement ready for your confirmation', did: 'recorded the requirements agreement.', next: 'Review the agreement and confirm it in the app.', button: 'Review agreement' },
  'agreement-worker': { subject: 'Agreement ready for your confirmation', did: 'confirmed the requirements agreement.', next: 'Review the agreement and add your confirmation as the worker.', button: 'Review agreement' },
  'completion-review': { subject: 'Completed work ready for your review', did: 'marked the work done.', next: 'Review the evidence, then confirm completion or return it for correction in the app.', button: 'Review completed work' },
  returned: { subject: 'Returned for correction', did: 'returned this work for correction.', next: 'Open the request to read the reason and make the correction.', button: 'Open request' },
  'ready-to-close': { subject: 'Ready for closure', did: 'recorded the last step before closure. The worker and the Requestor have both confirmed.', next: 'Open the request and close it.', button: 'Open request' },
  closed: { subject: 'Request closed', did: 'closed this request.', next: 'No action is needed. The record stays available in the app.', button: 'Open request' },
  reminder: { button: 'Open request', next: 'Open the request to see what is needed.' },
  test: { subject: 'Test message', did: 'asked for this test message.', next: 'No action is needed. If you can read this, email from JarcTech Ticket reaches you.', button: 'Open JarcTech Ticket' }
};
const REVIEWER_NOTE = 'You are receiving this as an Admin because the Requestor cannot confirm this one themselves. An Admin other than the worker reviews it instead.';
const LABELS = { assigned: 'Assigned', reassigned: 'Reassigned', 'meeting-proposed': 'Meeting proposed', 'meeting-changed': 'Meeting changed', 'meeting-confirmed': 'Meeting confirmed', 'agreement-confirm': 'Agreement to confirm', 'agreement-worker': 'Agreement to confirm', 'completion-review': 'Completion to review', returned: 'Returned for correction', 'ready-to-close': 'Ready for closure', closed: 'Closed', reminder: 'Reminder or escalation', test: 'Test message' };

// input: { event, record, ticketTitle, actorName, link, title (reminders), meeting, location, delivery, timezone, reviewer }
function renderEmail(input) {
  const def = EVENTS[input.event] || EVENTS.reminder;
  const reminder = input.event === 'reminder';
  const actor = clean(input.actorName, NAME_MAX), requestTitle = clean(input.ticketTitle, TITLE_MAX), location = clean(input.location, LOCATION_MAX);
  const lead = reminder ? `${clean(input.title, TITLE_MAX)}.` : `${actor || 'JarcTech Ticket'} ${def.did}`;
  const facts = [
    input.record ? ['Request', requestTitle ? `${input.record}: ${requestTitle}` : input.record] : null,
    input.meeting ? ['Meeting', meetingTime(input.meeting, input.timezone)] : null,
    input.meeting && location ? ['Location', location] : null,
    input.delivery ? ['Delivery date', DeadlineCore.formatDate(input.delivery)] : null,
    reminder ? ['Sent by', 'Automatic reminder'] : null
  ].filter(f => f && f[1]);
  const notes = [def.note, input.reviewer ? REVIEWER_NOTE : null].filter(Boolean);
  const footer = 'Replies to this email do not become comments in JarcTech Ticket. To respond, open the request and use the app. Opening the link changes nothing, and you need to sign in with your own account.';
  const subject = `${input.record ? `${input.record}: ` : 'JarcTech Ticket: '}${reminder ? clean(input.title, TITLE_MAX) : def.subject}`.slice(0, 200);

  const text = [lead, '', ...facts.map(([k, v]) => `${k}: ${v}`), '', `Next: ${def.next}`, ...notes.flatMap(n => ['', n]), '', `${def.button}: ${input.link}`, '', footer].join('\n').slice(0, TEXT_MAX);

  const rows = facts.map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#6c7e80;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:3px 0;color:#1d2a2c">${esc(v)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef5f5;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2a2c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef5f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px">
<tr><td style="background:#007d85;padding:14px 24px;color:#ffffff;font-weight:bold;font-size:16px;border-radius:10px 10px 0 0">JarcTech Ticket</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 16px;font-size:17px;font-weight:bold">${esc(lead)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px">${rows}</table>
<p style="margin:0 0 20px">${esc(def.next)}</p>
${notes.map(n => `<p style="margin:0 0 16px;font-size:13px;color:#4d5f62">${esc(n)}</p>`).join('')}
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#007d85" style="background:#007d85;border-radius:6px"><a href="${esc(input.link)}" style="display:inline-block;padding:11px 22px;color:#ffffff;font-weight:bold;text-decoration:none">${esc(def.button)}</a></td></tr></table>
<p style="margin:24px 0 0;font-size:12px;color:#6c7e80">${esc(footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

module.exports = { LABELS, renderEmail };
