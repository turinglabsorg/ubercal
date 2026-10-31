/**
 * Booking emails through Resend: the guest's confirmation and reminders, and the
 * owner's notice. Without a key nothing is sent and nothing else changes.
 */

const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export class Mailer {
  constructor({ apiKey = "", from = "ubercal <bookings@fluxkit.dev>", apiBase = "https://api.resend.com", log = () => {} } = {}) {
    this.apiKey = apiKey;
    this.from = from;
    this.apiBase = apiBase;
    this.log = log;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  /** One email; the Resend id, or "" when mail is off or Resend refused it (logged, never thrown). */
  async send({ to, subject, html, text, replyTo }) {
    if (!this.apiKey) return "";
    try {
      const response = await fetch(`${this.apiBase}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.log("mail refused", response.status, data?.name || data?.message || "");
        return "";
      }
      return String(data.id || "");
    } catch (error) {
      this.log("mail failed", error?.message || error);
      return "";
    }
  }
}

/** A moment in words, in a time zone: "Monday 2 November, 10:00–10:30 (Europe/Rome)". */
export function when(start, end, timeZone) {
  const zone = timeZone || "UTC";
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long" }).format(start);
  const time = (date) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(date);
  return `${day}, ${time(start)}–${time(end)} (${zone.replace(/_/g, " ")})`;
}

function layout({ badge, title, lines, button }) {
  const rows = lines.map(([label, value]) => `<tr><td style="padding:6px 12px 6px 0;color:#7d7887;font-size:13px;font-weight:700;white-space:nowrap;vertical-align:top">${escape(label)}</td><td style="padding:6px 0;color:#121117;font-size:15px">${escape(value).replace(/\n/g, "<br>")}</td></tr>`).join("");
  const action = button ? `<p style="margin:22px 0 0"><a href="${escape(button.href)}" style="display:inline-block;padding:12px 18px;border:2px solid #121117;border-radius:12px;background:#ffd23f;color:#121117;font-weight:800;text-decoration:none">${escape(button.label)}</a></p>` : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#fffaf0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;border:2px solid #121117;border-radius:16px;background:#ffffff" cellspacing="0" cellpadding="0"><tr><td style="padding:24px">
<span style="display:inline-block;padding:4px 10px;border:2px solid #121117;border-radius:999px;background:#19c27a;color:#121117;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase">${escape(badge)}</span>
<h1 style="margin:14px 0 16px;color:#121117;font-size:22px;line-height:1.25">${escape(title)}</h1>
<table role="presentation" cellspacing="0" cellpadding="0">${rows}</table>${action}
</td></tr></table>
<p style="margin:16px 0 0;color:#7d7887;font-size:12px">Sent by <a href="https://ubercal.fluxkit.dev" style="color:#7d7887">ubercal</a>, an open-source fluxkit tool.</p>
</td></tr></table></body></html>`;
}

function plain({ title, lines, button }) {
  return [title, "", ...lines.map(([label, value]) => `${label}: ${value}`), ...(button ? ["", `${button.label}: ${button.href}`] : []), "", "Sent by ubercal (https://ubercal.fluxkit.dev)."].join("\n");
}

function message(parts) {
  return { html: layout(parts), text: plain(parts) };
}

/** The emails of one booking: `kind` is "confirmed", "owner", "day" or "hour". */
export function bookingEmail(kind, { appointment, page, ownerName, ownerEmail }) {
  const guestZone = appointment.guestZone || page.timeZone;
  const time = when(appointment.start, appointment.end, kind === "owner" ? page.timeZone : guestZone);
  const meet = appointment.meet ? { href: appointment.meet, label: "Join with Google Meet" } : null;
  const host = ownerName || ownerEmail;
  if (kind === "owner") {
    return {
      to: ownerEmail, replyTo: appointment.email,
      subject: `New booking: ${appointment.name}, ${time}`,
      ...message({ badge: "new booking", title: `${appointment.name} booked ${page.name}`, button: meet, lines: [
        ["When", time], ["Who", `${appointment.name} <${appointment.email}>`], ...(appointment.notes ? [["Notes", appointment.notes]] : []),
      ] }),
    };
  }
  const intro = { confirmed: ["booked", `You're booked with ${host}`, `Booked: ${page.name} with ${host}, ${time}`],
    day: ["tomorrow", `Tomorrow: ${page.name} with ${host}`, `Tomorrow: ${page.name} with ${host}, ${time}`],
    hour: ["in an hour", `In an hour: ${page.name} with ${host}`, `In an hour: ${page.name} with ${host}`] }[kind];
  return {
    to: appointment.email, replyTo: ownerEmail,
    subject: intro[2],
    ...message({ badge: intro[0], title: intro[1], button: meet, lines: [
      ["What", page.name], ["When", time], ["With", host], ...(appointment.notes ? [["Your notes", appointment.notes]] : []),
      ...(kind === "confirmed" ? [["Calendar", "Google Calendar sends the invitation separately: accept it to keep the meeting in your calendar. To change anything, reply to this email."]] : []),
    ] }),
  };
}
