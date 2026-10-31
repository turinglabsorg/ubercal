(() => {
  const parts = location.pathname.split("/").filter(Boolean);
  const token = parts[0] === "book" ? parts[1] : parts[0];
  const root = document.querySelector("[data-book]");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const view = { info: null, duration: 0, month: null, slots: new Map(), day: "", start: "", loading: false, done: null };

  // The page speaks the guest's language: Italian, English, Spanish or French, switched by the flags.
  const WORDS = {
    en: { opening: "Opening the calendar…", none: "No booking page here", looking: "Looking for free times…", empty: "No free times this month. Try the next one.", name: "your name", email: "your email (the invitation goes here)", notes: "anything to share before the meeting (optional)", book: "book it", booking: "booking…", booked: "booked", sent: (email) => `The invitation is on its way to ${email}.`, accept: "One more step: open the Google Calendar invitation and answer “Yes”, so the meeting is confirmed in your calendar too.", meet: "Google Meet link", meetFact: "Google Meet link in the invitation", zone: (zone) => `Times in your time zone: ${zone}`, closed: "This booking page is not taking bookings yet.", previous: "Previous month", next: "Next month", footer: ["Booking with ", ", an open-source ", " tool by ", ""], taken: /took this time/ },
    it: { opening: "Apro il calendario…", none: "Nessuna pagina di prenotazione qui", looking: "Cerco gli orari liberi…", empty: "Nessun orario libero questo mese. Prova il prossimo.", name: "il tuo nome", email: "la tua email (l'invito arriva qui)", notes: "qualcosa da dire prima dell'incontro (facoltativo)", book: "prenota", booking: "prenoto…", booked: "prenotato", sent: (email) => `L'invito sta arrivando a ${email}.`, accept: "Un ultimo passo: apri l'invito di Google Calendar e rispondi “Sì”, così l'incontro è confermato anche nel tuo calendario.", meet: "Link di Google Meet", meetFact: "Link di Google Meet nell'invito", zone: (zone) => `Orari nel tuo fuso: ${zone}`, closed: "Questa pagina non accetta ancora prenotazioni.", previous: "Mese precedente", next: "Mese successivo", footer: ["Prenotazione con ", ", uno strumento open source ", " di ", ""], taken: /took this time/ },
    es: { opening: "Abriendo el calendario…", none: "No hay ninguna página de reservas aquí", looking: "Buscando horas libres…", empty: "No hay horas libres este mes. Prueba el siguiente.", name: "tu nombre", email: "tu correo (la invitación llega aquí)", notes: "algo que contar antes de la reunión (opcional)", book: "reservar", booking: "reservando…", booked: "reservado", sent: (email) => `La invitación está de camino a ${email}.`, accept: "Un último paso: abre la invitación de Google Calendar y responde “Sí”, para que la reunión quede confirmada también en tu calendario.", meet: "Enlace de Google Meet", meetFact: "Enlace de Google Meet en la invitación", zone: (zone) => `Horas en tu zona horaria: ${zone}`, closed: "Esta página todavía no acepta reservas.", previous: "Mes anterior", next: "Mes siguiente", footer: ["Reserva con ", ", una herramienta de código abierto ", " de ", ""], taken: /took this time/ },
    fr: { opening: "Ouverture de l'agenda…", none: "Aucune page de réservation ici", looking: "Recherche des créneaux libres…", empty: "Aucun créneau libre ce mois-ci. Essayez le suivant.", name: "votre nom", email: "votre e-mail (l'invitation arrive ici)", notes: "quelque chose à dire avant le rendez-vous (facultatif)", book: "réserver", booking: "réservation…", booked: "réservé", sent: (email) => `L'invitation est en route vers ${email}.`, accept: "Dernière étape : ouvrez l'invitation Google Agenda et répondez « Oui », pour que le rendez-vous soit confirmé dans votre agenda aussi.", meet: "Lien Google Meet", meetFact: "Lien Google Meet dans l'invitation", zone: (zone) => `Horaires dans votre fuseau : ${zone}`, closed: "Cette page n'accepte pas encore de réservations.", previous: "Mois précédent", next: "Mois suivant", footer: ["Réservation avec ", ", un outil open source ", " de ", ""], taken: /took this time/ },
  };
  const LOCALES = { en: "en-GB", it: "it-IT", es: "es-ES", fr: "fr-FR" };
  // The page opens in the language its owner chose; the browser's only covers the moment before the page is read.
  // The flags switch it for this visit.
  let language = (() => {
    for (const preferred of navigator.languages || [navigator.language || "en"]) { const short = String(preferred).slice(0, 2).toLowerCase(); if (WORDS[short]) return short; }
    return "en";
  })();
  const words = () => WORDS[language];
  const locale = () => LOCALES[language];

  function showLanguage() {
    document.documentElement.lang = language;
    for (const button of document.querySelectorAll("[data-lang]")) button.setAttribute("aria-pressed", String(button.dataset.lang === language));
    const footer = document.querySelector("[data-footer]");
    if (footer) {
      const [before, middle, by, after] = words().footer;
      footer.replaceChildren(before, el("a", { href: "https://github.com/turinglabsorg/ubercal", text: "ubercal" }), middle, el("a", { href: "https://fluxkit.dev", text: "fluxkit" }), by, el("a", { href: "https://meaningtech.io", text: "meaningtech" }), after);
    }
  }
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => {
      language = button.dataset.lang;
      showLanguage();
      render();
    });
  }
  let toastTimer = null;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }
  function toast(text, kind = "") {
    const box = document.querySelector(".toast");
    box.textContent = text;
    box.className = `toast ${kind}`;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 6000);
  }
  async function call(path, options = {}) {
    const response = await fetch(`/book/${token}/${path}`, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const length = (minutes) => minutes < 60 ? `${minutes} min` : minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60}` : `${minutes / 60} h`;
  const timeText = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  const dayText = (date, options) => new Date(date).toLocaleDateString(locale(), options);

  async function loadMonth() {
    const first = new Date(view.month.getFullYear(), view.month.getMonth(), 1);
    const next = new Date(view.month.getFullYear(), view.month.getMonth() + 1, 1);
    const from = new Date(Math.max(first.getTime(), Date.now()));
    view.loading = true;
    render();
    try {
      const { slots } = from < next ? await call(`slots?duration=${view.duration}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(next.toISOString())}`) : { slots: [] };
      view.slots = new Map();
      for (const at of slots) {
        const key = dayKey(new Date(at));
        if (!view.slots.has(key)) view.slots.set(key, []);
        view.slots.get(key).push(at);
      }
      if (!view.slots.has(view.day)) view.day = [...view.slots.keys()][0] || "";
      // Late in a month there may be nothing left: open on the next month the first time.
      const limit = Date.now() + (view.info.daysAhead || 30) * 86400000;
      if (!slots.length && !view.moved && next.getTime() < limit) {
        view.moved = true;
        view.month = next;
        return loadMonth();
      }
      view.moved = true;
    } catch (error) {
      toast(error.message, "bad");
    }
    view.loading = false;
    render();
  }

  function month() {
    const first = new Date(view.month.getFullYear(), view.month.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7));
    const today = dayKey(new Date());
    const names = Array.from({ length: 7 }, (_, index) => dayText(new Date(2026, 10, 2 + index), { weekday: "narrow" }));
    const thisMonth = new Date().getFullYear() === view.month.getFullYear() && new Date().getMonth() === view.month.getMonth();
    const limit = new Date(Date.now() + (view.info.daysAhead || 30) * 86400000);
    return el("div", { class: "picker-month" },
      el("div", { class: "picker-head" },
        el("button", { class: "icon-btn", type: "button", "aria-label": words().previous, disabled: thisMonth, onclick: () => { view.month = new Date(view.month.getFullYear(), view.month.getMonth() - 1, 1); loadMonth(); } }, icon("left")),
        el("h2", { text: dayText(view.month, { month: "long", year: "numeric" }) }),
        el("button", { class: "icon-btn", type: "button", "aria-label": words().next, disabled: new Date(view.month.getFullYear(), view.month.getMonth() + 1, 1) > limit, onclick: () => { view.month = new Date(view.month.getFullYear(), view.month.getMonth() + 1, 1); loadMonth(); } }, icon("right"))),
      el("div", { class: "picker-grid" },
        names.map((name) => el("span", { class: "picker-name", text: name })),
        Array.from({ length: 42 }, (_, index) => {
          const day = new Date(start);
          day.setDate(start.getDate() + index);
          const key = dayKey(day);
          const open = view.slots.has(key) && day.getMonth() === view.month.getMonth();
          return el("button", {
            type: "button", class: `picker-day${open ? " open" : ""}${key === view.day ? " chosen" : ""}${key === today ? " today" : ""}${day.getMonth() === view.month.getMonth() ? "" : " other"}`,
            disabled: !open, "aria-pressed": String(key === view.day), "aria-label": dayText(day, { weekday: "long", day: "numeric", month: "long" }),
            onclick: () => { view.day = key; view.start = ""; render(); },
          }, String(day.getDate()));
        })));
  }

  function times() {
    if (view.loading) return el("p", { class: "empty", text: words().looking });
    if (!view.day) return el("p", { class: "empty", text: words().empty });
    const date = new Date(`${view.day}T12:00:00`);
    return el("div", { class: "picker-times" },
      el("h3", { text: dayText(date, { weekday: "long", day: "numeric", month: "long" }) }),
      el("div", { class: "time-list" }, (view.slots.get(view.day) || []).map((at) => el("button", {
        type: "button", class: `time-slot${at === view.start ? " chosen" : ""}`, "aria-pressed": String(at === view.start), text: timeText(at),
        // The form comes into view; no field takes the keyboard until the guest taps it.
        onclick: () => { view.start = at; render(); document.querySelector("[data-form]")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); },
      }))));
  }

  function form() {
    if (!view.start) return null;
    const end = new Date(new Date(view.start).getTime() + view.duration * 60000).toISOString();
    const node = el("form", { class: "book-form", "data-form": true },
      el("p", { class: "book-when" }, el("b", { text: dayText(view.start, { weekday: "long", day: "numeric", month: "long" }) }), ` · ${timeText(view.start)}–${timeText(end)}`),
      el("label", { class: "sr", for: "book-name", text: "Your name" }),
      el("input", { class: "input", id: "book-name", name: "name", autocomplete: "name", placeholder: words().name, required: true, maxlength: "100" }),
      el("label", { class: "sr", for: "book-email", text: "Your email" }),
      el("input", { class: "input", id: "book-email", name: "email", type: "email", autocomplete: "email", placeholder: words().email, required: true, maxlength: "200" }),
      el("label", { class: "sr", for: "book-notes", text: "Notes" }),
      el("textarea", { class: "input notes", id: "book-notes", name: "notes", placeholder: words().notes, maxlength: "2000", rows: "3" }),
      el("button", { class: "btn primary", type: "submit" }, el("span", { text: words().book })));
    node.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = node.querySelector("button[type=submit]");
      button.disabled = true;
      button.lastChild.textContent = words().booking;
      try {
        view.done = await call("reserve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration: view.duration, start: view.start, name: node.name.value, email: node.email.value, notes: node.notes.value, timeZone: zone, language }) });
        view.done.email = node.email.value;
        render();
      } catch (error) {
        toast(error.message, "bad");
        button.disabled = false;
        button.lastChild.textContent = words().book;
        if (/took this time/.test(error.message)) { view.start = ""; loadMonth(); }
      }
    });
    return node;
  }

  function render() {
    const info = view.info;
    if (!info) return;
    const owner = el("div", { class: "book-owner" },
      info.owner.picture ? el("img", { src: info.owner.picture, alt: "", referrerpolicy: "no-referrer" }) : el("span", { class: "initial", text: (info.owner.name || "?").slice(0, 1).toUpperCase() }),
      el("span", { text: info.owner.name }));
    const about = el("section", { class: "book-about" }, owner,
      el("h1", { text: info.name }),
      info.description ? el("p", { class: "book-description", text: info.description }) : null,
      el("div", { class: "chips", role: "group", "aria-label": "How long" }, info.durations.map((minutes) => el("button", {
        type: "button", class: "chip-toggle", "aria-pressed": String(minutes === view.duration), text: length(minutes),
        onclick: () => { if (view.duration !== minutes) { view.duration = minutes; view.start = ""; loadMonth(); } },
      }))),
      el("ul", { class: "book-facts" },
        info.meet ? el("li", { text: words().meetFact }) : null,
        el("li", { text: words().zone(zone.replace(/_/g, " ")) })));
    if (view.done) {
      root.replaceChildren(about, el("section", { class: "book-done" },
        el("span", { class: "done-badge", text: words().booked }),
        el("h2", { text: `${dayText(view.done.start, { weekday: "long", day: "numeric", month: "long" })}, ${timeText(view.done.start)}–${timeText(view.done.end)}` }),
        el("p", { text: words().sent(view.done.email) }),
        el("p", { class: "accept-note", text: words().accept }),
        view.done.meet ? el("a", { class: "btn", href: view.done.meet, target: "_blank", rel: "noopener", text: words().meet }) : null));
      return;
    }
    if (!info.ready) {
      root.replaceChildren(about, el("section", { class: "book-pick" }, el("p", { class: "empty", text: words().closed })));
      return;
    }
    root.replaceChildren(about, el("section", { class: "book-pick" }, el("div", { class: "pick-grid" }, month(), times()), form()));
  }

  (async () => {
    showLanguage();
    root.replaceChildren(el("p", { class: "empty", text: words().opening }));
    try {
      view.info = await call("info");
    } catch (error) {
      root.replaceChildren(el("section", { class: "book-pick" }, el("h1", { text: words().none }), el("p", { class: "empty", text: error.message })));
      return;
    }
    if (WORDS[view.info.language]) { language = view.info.language; showLanguage(); }
    document.title = `${view.info.name} · ubercal`;
    view.duration = view.info.durations[0];
    view.month = new Date();
    view.month.setDate(1);
    render();
    if (view.info.ready) loadMonth();
  })();
})();
