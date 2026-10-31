/**
 * Booking emails through Resend: the guest's confirmation and reminders (in the
 * guest's language), and the owner's notices. Without a key nothing is sent.
 */

const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export const LANGUAGES = ["en", "it", "es", "fr"];
const LOCALES = { en: "en-GB", it: "it-IT", es: "es-ES", fr: "fr-FR" };

// What a guest reads, in each language the booking page speaks.
const GUEST = {
  en: {
    badge: { confirmed: "booked", day: "tomorrow", hour: "in an hour" },
    title: { confirmed: (host) => `You're booked with ${host}`, day: (host, page) => `Tomorrow: ${page} with ${host}`, hour: (host, page) => `In an hour: ${page} with ${host}` },
    subject: { confirmed: (host, page, time) => `Booked: ${page} with ${host}, ${time}`, day: (host, page, time) => `Tomorrow: ${page} with ${host}, ${time}`, hour: (host, page) => `In an hour: ${page} with ${host}` },
    accept: "One more step: accept the Google Calendar invitation we just sent you (answer “Yes”), so the meeting is confirmed in your calendar too.",
    pending: "You have not accepted the Google Calendar invitation yet: answer “Yes” to confirm the meeting.",
    what: "What", when: "When", with: "With", notes: "Your notes", change: "To change anything, reply to this email.", join: "Join with Google Meet",
    footer: "Sent by ubercal, an open-source fluxkit tool.",
  },
  it: {
    badge: { confirmed: "prenotato", day: "domani", hour: "tra un'ora" },
    title: { confirmed: (host) => `Hai prenotato con ${host}`, day: (host, page) => `Domani: ${page} con ${host}`, hour: (host, page) => `Tra un'ora: ${page} con ${host}` },
    subject: { confirmed: (host, page, time) => `Prenotato: ${page} con ${host}, ${time}`, day: (host, page, time) => `Domani: ${page} con ${host}, ${time}`, hour: (host, page) => `Tra un'ora: ${page} con ${host}` },
    accept: "Un ultimo passo: accetta l'invito di Google Calendar che ti abbiamo appena mandato (rispondi “Sì”), così l'incontro è confermato anche nel tuo calendario.",
    pending: "Non hai ancora accettato l'invito di Google Calendar: rispondi “Sì” per confermare l'incontro.",
    what: "Cosa", when: "Quando", with: "Con", notes: "Le tue note", change: "Per cambiare qualcosa, rispondi a questa email.", join: "Entra con Google Meet",
    footer: "Inviato da ubercal, uno strumento open source di fluxkit.",
  },
  es: {
    badge: { confirmed: "reservado", day: "mañana", hour: "en una hora" },
    title: { confirmed: (host) => `Tienes una reunión con ${host}`, day: (host, page) => `Mañana: ${page} con ${host}`, hour: (host, page) => `En una hora: ${page} con ${host}` },
    subject: { confirmed: (host, page, time) => `Reservado: ${page} con ${host}, ${time}`, day: (host, page, time) => `Mañana: ${page} con ${host}, ${time}`, hour: (host, page) => `En una hora: ${page} con ${host}` },
    accept: "Un último paso: acepta la invitación de Google Calendar que te acabamos de enviar (responde “Sí”), para que la reunión quede confirmada también en tu calendario.",
    pending: "Todavía no has aceptado la invitación de Google Calendar: responde “Sí” para confirmar la reunión.",
    what: "Qué", when: "Cuándo", with: "Con", notes: "Tus notas", change: "Para cambiar algo, responde a este correo.", join: "Unirse con Google Meet",
    footer: "Enviado por ubercal, una herramienta de código abierto de fluxkit.",
  },
  fr: {
    badge: { confirmed: "réservé", day: "demain", hour: "dans une heure" },
    title: { confirmed: (host) => `Votre rendez-vous avec ${host} est réservé`, day: (host, page) => `Demain : ${page} avec ${host}`, hour: (host, page) => `Dans une heure : ${page} avec ${host}` },
    subject: { confirmed: (host, page, time) => `Réservé : ${page} avec ${host}, ${time}`, day: (host, page, time) => `Demain : ${page} avec ${host}, ${time}`, hour: (host, page) => `Dans une heure : ${page} avec ${host}` },
    accept: "Dernière étape : acceptez l'invitation Google Agenda que nous venons de vous envoyer (répondez « Oui »), pour que le rendez-vous soit confirmé dans votre agenda aussi.",
    pending: "Vous n'avez pas encore accepté l'invitation Google Agenda : répondez « Oui » pour confirmer le rendez-vous.",
    what: "Quoi", when: "Quand", with: "Avec", notes: "Vos notes", change: "Pour modifier quoi que ce soit, répondez à cet e-mail.", join: "Rejoindre avec Google Meet",
    footer: "Envoyé par ubercal, un outil open source de fluxkit.",
  },
};

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

/** A moment in words, in a time zone and a language: "Monday 2 November, 10:00–10:30 (Europe/Rome)". */
export function when(start, end, timeZone, language = "en") {
  const zone = timeZone || "UTC";
  const locale = LOCALES[language] || LOCALES.en;
  const day = new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: "long", day: "numeric", month: "long" }).format(start);
  const time = (date) => new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(date);
  return `${day}, ${time(start)}–${time(end)} (${zone.replace(/_/g, " ")})`;
}

function layout({ badge, badgeColor = "#19c27a", title, callout, lines, button, footer }) {
  const rows = lines.map(([label, value]) => `<tr><td style="padding:6px 12px 6px 0;color:#7d7887;font-size:13px;font-weight:700;white-space:nowrap;vertical-align:top">${escape(label)}</td><td style="padding:6px 0;color:#121117;font-size:15px">${escape(value).replace(/\n/g, "<br>")}</td></tr>`).join("");
  // The site's look: 2px ink outlines and hard ink shadows. A client that drops box-shadow or transform keeps the rest.
  const note = callout ? `<p style="margin:0 0 18px;padding:12px 14px;border:2px solid #121117;border-radius:12px;background:#ffd23f;color:#121117;font-size:15px;font-weight:700;line-height:1.45;box-shadow:3px 3px 0 #121117">${escape(callout)}</p>` : "";
  const action = button ? `<p style="margin:22px 0 4px"><a href="${escape(button.href)}" style="display:inline-block;padding:12px 18px;border:2px solid #121117;border-radius:12px;background:#3a5bff;color:#ffffff;font-weight:800;text-decoration:none;box-shadow:3px 3px 0 #121117">${escape(button.label)}</a></p>` : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#fffaf0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px" cellspacing="0" cellpadding="0"><tr><td style="padding:0 0 16px 2px;color:#7d7887;font-size:13px;font-weight:700">
<a href="https://fluxkit.dev" style="color:#7d7887;text-decoration:none">fluxkit</a>&nbsp;/&nbsp;
<a href="https://ubercal.fluxkit.dev" style="display:inline-block;padding:3px 10px;border:2px solid #121117;border-radius:8px;background:#ffd23f;color:#121117;font-size:14px;font-weight:900;letter-spacing:-.01em;text-decoration:none;transform:rotate(-2deg);box-shadow:2px 2px 0 #121117">ubercal</a>
</td></tr></table>
<table role="presentation" width="100%" style="max-width:560px;border:2px solid #121117;border-radius:16px;background:#ffffff;box-shadow:6px 6px 0 #121117" cellspacing="0" cellpadding="0"><tr><td style="padding:24px">
<span style="display:inline-block;padding:4px 10px;border:2px solid #121117;border-radius:999px;background:${badgeColor};color:#121117;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;box-shadow:2px 2px 0 #121117">${escape(badge)}</span>
<h1 style="margin:14px 0 16px;color:#121117;font-size:22px;line-height:1.25">${escape(title)}</h1>
${note}<table role="presentation" cellspacing="0" cellpadding="0">${rows}</table>${action}
</td></tr></table>
<p style="margin:22px 0 0;color:#7d7887;font-size:12px">${escape(footer)} <a href="https://ubercal.fluxkit.dev" style="color:#7d7887">ubercal.fluxkit.dev</a></p>
</td></tr></table></body></html>`;
}

function plain({ title, callout, lines, button, footer }) {
  return [title, "", ...(callout ? [callout, ""] : []), ...lines.map(([label, value]) => `${label}: ${value}`), ...(button ? ["", `${button.label}: ${button.href}`] : []), "", `${footer} https://ubercal.fluxkit.dev`].join("\n");
}

const message = (parts) => ({ html: layout(parts), text: plain(parts) });

/**
 * The emails of one booking: "confirmed", "day" and "hour" go to the guest in their
 * language; "owner" (a new booking) and "declined" go to the owner, in English.
 */
export function bookingEmail(kind, { appointment, page, ownerName, ownerEmail }) {
  const host = ownerName || ownerEmail;
  if (kind === "owner" || kind === "declined") {
    const time = when(appointment.start, appointment.end, page.timeZone, "en");
    const declined = kind === "declined";
    return {
      to: ownerEmail, replyTo: appointment.email,
      subject: declined ? `Declined: ${appointment.name}, ${time}` : `New booking: ${appointment.name}, ${time}`,
      ...message({
        badge: declined ? "declined" : "new booking", badgeColor: declined ? "#ff5ca8" : "#19c27a",
        title: declined ? `${appointment.name} declined ${page.name}` : `${appointment.name} booked ${page.name}`,
        callout: declined ? "The time is free again on your booking page." : "",
        button: !declined && appointment.meet ? { href: appointment.meet, label: "Join with Google Meet" } : null,
        footer: "Sent by ubercal, an open-source fluxkit tool.",
        lines: [["When", time], ["Who", `${appointment.name} <${appointment.email}>`], ...(appointment.notes ? [["Notes", appointment.notes]] : [])],
      }),
    };
  }
  const language = LANGUAGES.includes(appointment.language) ? appointment.language : "en";
  const copy = GUEST[language];
  const time = when(appointment.start, appointment.end, appointment.guestZone || page.timeZone, language);
  const waiting = appointment.guestStatus !== "accepted";
  return {
    to: appointment.email, replyTo: ownerEmail,
    subject: copy.subject[kind](host, page.name, time),
    ...message({
      badge: copy.badge[kind], title: copy.title[kind](host, page.name),
      callout: kind === "confirmed" ? copy.accept : waiting ? copy.pending : "",
      button: appointment.meet ? { href: appointment.meet, label: copy.join } : null,
      footer: copy.footer,
      lines: [[copy.what, page.name], [copy.when, time], [copy.with, host], ...(appointment.notes ? [[copy.notes, appointment.notes]] : []), ...(kind === "confirmed" ? [["", copy.change]] : [])],
    }),
  };
}
