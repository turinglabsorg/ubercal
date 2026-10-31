(() => {
  const parts = location.pathname.split("/").filter(Boolean);
  const token = parts[0] === "book" ? parts[1] : parts[0];
  const root = document.querySelector("[data-book]");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const view = { info: null, duration: 0, month: null, slots: new Map(), day: "", start: "", loading: false, done: null };
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
  const timeText = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

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
    const names = Array.from({ length: 7 }, (_, index) => new Date(2026, 10, 2 + index).toLocaleDateString(undefined, { weekday: "narrow" }));
    const thisMonth = new Date().getFullYear() === view.month.getFullYear() && new Date().getMonth() === view.month.getMonth();
    const limit = new Date(Date.now() + (view.info.daysAhead || 30) * 86400000);
    return el("div", { class: "picker-month" },
      el("div", { class: "picker-head" },
        el("button", { class: "icon-btn", type: "button", "aria-label": "Previous month", disabled: thisMonth, onclick: () => { view.month = new Date(view.month.getFullYear(), view.month.getMonth() - 1, 1); loadMonth(); } }, icon("left")),
        el("h2", { text: view.month.toLocaleDateString(undefined, { month: "long", year: "numeric" }) }),
        el("button", { class: "icon-btn", type: "button", "aria-label": "Next month", disabled: new Date(view.month.getFullYear(), view.month.getMonth() + 1, 1) > limit, onclick: () => { view.month = new Date(view.month.getFullYear(), view.month.getMonth() + 1, 1); loadMonth(); } }, icon("right"))),
      el("div", { class: "picker-grid" },
        names.map((name) => el("span", { class: "picker-name", text: name })),
        Array.from({ length: 42 }, (_, index) => {
          const day = new Date(start);
          day.setDate(start.getDate() + index);
          const key = dayKey(day);
          const open = view.slots.has(key) && day.getMonth() === view.month.getMonth();
          return el("button", {
            type: "button", class: `picker-day${open ? " open" : ""}${key === view.day ? " chosen" : ""}${key === today ? " today" : ""}${day.getMonth() === view.month.getMonth() ? "" : " other"}`,
            disabled: !open, "aria-pressed": String(key === view.day), "aria-label": day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
            onclick: () => { view.day = key; view.start = ""; render(); },
          }, String(day.getDate()));
        })));
  }

  function times() {
    if (view.loading) return el("p", { class: "empty", text: "Looking for free times…" });
    if (!view.day) return el("p", { class: "empty", text: "No free times this month. Try the next one." });
    const date = new Date(`${view.day}T12:00:00`);
    return el("div", { class: "picker-times" },
      el("h3", { text: date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) }),
      el("div", { class: "time-list" }, (view.slots.get(view.day) || []).map((at) => el("button", {
        type: "button", class: `time-slot${at === view.start ? " chosen" : ""}`, "aria-pressed": String(at === view.start), text: timeText(at),
        onclick: () => { view.start = at; render(); document.querySelector("[data-form] input")?.focus(); },
      }))));
  }

  function form() {
    if (!view.start) return null;
    const end = new Date(new Date(view.start).getTime() + view.duration * 60000).toISOString();
    const node = el("form", { class: "book-form", "data-form": true },
      el("p", { class: "book-when" }, el("b", { text: new Date(view.start).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) }), ` · ${timeText(view.start)}–${timeText(end)}`),
      el("label", { class: "sr", for: "book-name", text: "Your name" }),
      el("input", { class: "input", id: "book-name", name: "name", autocomplete: "name", placeholder: "your name", required: true, maxlength: "100" }),
      el("label", { class: "sr", for: "book-email", text: "Your email" }),
      el("input", { class: "input", id: "book-email", name: "email", type: "email", autocomplete: "email", placeholder: "your email (the invitation goes here)", required: true, maxlength: "200" }),
      el("label", { class: "sr", for: "book-notes", text: "Notes" }),
      el("textarea", { class: "input notes", id: "book-notes", name: "notes", placeholder: "anything to share before the meeting (optional)", maxlength: "2000", rows: "3" }),
      el("button", { class: "btn primary", type: "submit" }, el("span", { text: "book it" })));
    node.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = node.querySelector("button[type=submit]");
      button.disabled = true;
      button.lastChild.textContent = "booking…";
      try {
        view.done = await call("reserve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration: view.duration, start: view.start, name: node.name.value, email: node.email.value, notes: node.notes.value, timeZone: zone }) });
        view.done.email = node.email.value;
        render();
      } catch (error) {
        toast(error.message, "bad");
        button.disabled = false;
        button.lastChild.textContent = "book it";
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
        info.meet ? el("li", { text: "Google Meet link in the invitation" }) : null,
        el("li", { text: `Times in your time zone: ${zone.replace(/_/g, " ")}` })));
    if (view.done) {
      root.replaceChildren(about, el("section", { class: "book-done" },
        el("span", { class: "done-badge", text: "booked" }),
        el("h2", { text: `${new Date(view.done.start).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}, ${timeText(view.done.start)}–${timeText(view.done.end)}` }),
        el("p", { text: `The invitation is on its way to ${view.done.email}. Accept it to put the meeting in your calendar.` }),
        view.done.meet ? el("a", { class: "btn", href: view.done.meet, target: "_blank", rel: "noopener", text: "Google Meet link" }) : null));
      return;
    }
    if (!info.ready) {
      root.replaceChildren(about, el("section", { class: "book-pick" }, el("p", { class: "empty", text: "This booking page is not taking bookings yet." })));
      return;
    }
    root.replaceChildren(about, el("section", { class: "book-pick" }, el("div", { class: "pick-grid" }, month(), times()), form()));
  }

  (async () => {
    try {
      view.info = await call("info");
    } catch (error) {
      root.replaceChildren(el("section", { class: "book-pick" }, el("h1", { text: "No booking page here" }), el("p", { class: "empty", text: error.message })));
      return;
    }
    document.title = `${view.info.name} · ubercal`;
    view.duration = view.info.durations[0];
    view.month = new Date();
    view.month.setDate(1);
    render();
    if (view.info.ready) loadMonth();
  })();
})();
