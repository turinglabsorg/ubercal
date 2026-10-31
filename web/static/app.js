(() => {
  const PALETTE = ["--cal-1", "--cal-2", "--cal-3", "--cal-4", "--cal-5", "--cal-6"];
  const SHOWS = [["full", "full"], ["busy", "busy"], ["hidden", "off"]];
  // A share link's dates are local days in the page; the server keeps instants (until is the start of the day after).
  const localDay = (iso) => { if (!iso) return ""; const day = new Date(iso); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`; };
  const dayInstant = (value, after = 0) => { const [y, m, d] = value.split("-").map(Number); return new Date(y, m - 1, d + after).toISOString(); };
  const $ = (selector) => document.querySelector(selector);
  let state = null;
  const openPickers = new Set();
  const calendarsCache = new Map();
  const reading = new Set();
  let toastTimer = null;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "color") node.style.setProperty("--c", value);
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
    const box = $(".toast");
    box.textContent = text;
    box.className = `toast ${kind}`;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 5000);
  }

  async function call(method, path, body) {
    const response = await fetch(`/api${path}`, {
      method, credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401) {
      location.href = "/auth/google?next=/app";
      throw new Error("signed out");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  function ago(value) {
    if (!value) return "";
    const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 50) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  const events = (count) => `${count} ${count === 1 ? "event" : "events"}`;

  function colorOf(source, index) {
    return source.color || `var(${PALETTE[index % PALETTE.length]})`;
  }

  /** A button that asks for a second click before it does something that cannot be undone. */
  function twoStep(button, label, again, action) {
    let armed = null;
    button.addEventListener("click", async () => {
      if (!armed) {
        button.lastChild.textContent = again;
        button.dataset.armed = "";
        if (button.classList.contains("icon-btn")) toast(`${again[0].toUpperCase()}${again.slice(1)}.`);
        armed = setTimeout(() => { armed = null; delete button.dataset.armed; button.lastChild.textContent = label; }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      button.disabled = true;
      try { await action(); } catch (error) { toast(error.message, "bad"); button.disabled = false; button.lastChild.textContent = label; }
    });
    return button;
  }

  function setState(next) {
    state = next;
    cal.cache.clear();
    render();
    if (currentTab() === "calendar") loadCalendar();
  }

  function renderWho() {
    const who = $("[data-who]");
    who.replaceChildren(
      state.user.picture ? el("img", { src: state.user.picture, alt: "", referrerpolicy: "no-referrer" }) : el("span", { class: "initial", text: (state.user.name || state.user.email).slice(0, 1).toUpperCase() }),
      el("span", { class: "email", text: state.user.email }),
    );
  }

  function renderStrip() {
    $("[data-calendars]").textContent = String(state.sources.length).padStart(2, "0");
    $("[data-links]").textContent = String(state.feeds.length).padStart(2, "0");
    const total = state.sources.reduce((sum, source) => sum + (source.enabled ? source.eventCount : 0), 0);
    $("[data-calendars-meta]").textContent = events(total);
    $("[data-links-meta]").textContent = `of ${state.limits.feeds}`;
    $("[data-last]").textContent = state.sync.lastRunAt ? `last read ${ago(state.sync.lastRunAt)}` : `every ${state.sync.minutes} min`;
  }

  function sourceFrom(source) {
    if (source.kind === "google") {
      const connection = state.connections.find((entry) => entry.id === source.connectionId);
      return `google · ${connection ? connection.email : "account removed"}`;
    }
    return `.ics · ${source.host}`;
  }

  function sourceState(source) {
    if (reading.has(source.id)) return el("p", { class: "cal-state", text: "reading…" });
    if (!source.enabled) return el("p", { class: "cal-state", text: "paused: left out of every link" });
    if (source.status === "error") return el("p", { class: "cal-state error", text: source.error });
    if (source.status === "ok") return el("p", { class: "cal-state ok", text: `${events(source.eventCount)} · read ${ago(source.syncedAt)}` });
    return el("p", { class: "cal-state", text: "waiting for the first read" });
  }

  async function syncSource(source) {
    reading.add(source.id);
    render();
    try { setState(await call("POST", `/sources/${source.id}/sync`)); } catch (error) { toast(error.message, "bad"); }
    finally { reading.delete(source.id); render(); }
  }

  function renderSources() {
    const list = $("[data-sources]");
    if (!state.sources.length) {
      list.replaceChildren(el("p", { class: "empty", text: "No calendars yet. Add one from Google or paste a link below." }));
      return;
    }
    list.replaceChildren(...state.sources.map((source, index) => {
      const remove = el("button", { class: "icon-btn danger", type: "button", title: "remove", "aria-label": `Remove ${source.name}` }, icon("trash"), el("span", { class: "sr", text: "remove" }));
      twoStep(remove, "remove", "click again to remove", async () => setState(await call("DELETE", `/sources/${source.id}`)));
      return el("div", { class: `cal${source.enabled ? "" : " paused"}${reading.has(source.id) ? " reading" : ""}` },
        el("span", { class: "swatch", color: colorOf(source, index) }),
        el("div", {},
          el("p", { class: "cal-name", text: source.name }),
          el("p", { class: "cal-from", text: sourceFrom(source) }),
          sourceState(source)),
        el("div", { class: "cal-tools" },
          el("button", { class: "icon-btn", type: "button", title: "read now", "aria-label": `Read ${source.name} now`, disabled: !source.enabled || reading.has(source.id), onclick: () => syncSource(source) }, icon("sync")),
          el("button", { class: "icon-btn", type: "button", title: source.enabled ? "pause" : "resume", "aria-label": `${source.enabled ? "Pause" : "Resume"} ${source.name}`, onclick: async () => {
            try { setState(await call("PATCH", `/sources/${source.id}`, { enabled: !source.enabled })); } catch (error) { toast(error.message, "bad"); }
          } }, icon(source.enabled ? "pause" : "play")),
          remove));
    }));
  }

  async function togglePicker(connection) {
    if (openPickers.has(connection.id)) openPickers.delete(connection.id);
    else {
      openPickers.add(connection.id);
      await loadCalendars(connection);
    }
    render();
  }

  async function loadCalendars(connection) {
    try {
      calendarsCache.set(connection.id, (await call("GET", `/connections/${connection.id}/calendars`)).calendars);
    } catch (error) {
      calendarsCache.set(connection.id, []);
      toast(error.message, "bad");
    }
  }

  function renderAccounts() {
    const box = $("[data-accounts]");
    if (!state.google.configured) {
      box.replaceChildren(el("p", { class: "empty", text: "Google is not set up on this server yet." }));
      return;
    }
    const accounts = state.connections.map((connection) => {
      const open = openPickers.has(connection.id);
      const disconnect = el("button", { class: "btn small quiet danger", type: "button" }, el("span", { text: "disconnect" }));
      twoStep(disconnect, "disconnect", "click again", async () => {
        openPickers.delete(connection.id);
        setState(await call("DELETE", `/connections/${connection.id}`));
      });
      const calendars = calendarsCache.get(connection.id) || [];
      return el("div", { class: "account" },
        el("div", { class: "account-head" },
          el("span", { class: connection.status === "revoked" ? "revoked" : "", text: connection.status === "revoked" ? `${connection.email}: access taken back` : connection.email }),
          el("div", { class: "row" },
            connection.status === "revoked"
              ? el("a", { class: "btn small", href: "/auth/google/calendar" }, el("span", { text: "reconnect" }))
              : el("button", { class: "btn small", type: "button", "aria-expanded": String(open), onclick: () => togglePicker(connection) }, el("span", { text: "calendars" }), icon("down")),
            disconnect)),
        open ? el("div", { class: "picker" }, calendars.length ? calendars.map((calendar) => el("div", { class: "pick" },
          el("span", { class: "swatch", color: calendar.color || "var(--cal-1)" }),
          el("span", { text: calendar.primary ? `${calendar.name} (main)` : calendar.name }),
          calendar.sourceId
            ? el("button", { class: "btn small quiet", type: "button", disabled: true }, el("span", { text: "added" }))
            : el("button", { class: "btn small", type: "button", onclick: async (event) => {
              event.currentTarget.disabled = true;
              try {
                const result = await call("POST", "/sources", { kind: "google", connectionId: connection.id, calendarId: calendar.id });
                await loadCalendars(connection);
                setState(result.state);
                toast(`${result.source.name} is in. Every link that shows it is updated.`, "good");
              } catch (error) { toast(error.message, "bad"); render(); }
            } }, icon("plus"), el("span", { text: "add" })))) : el("p", { class: "empty pick", text: "Reading the calendars of this account…" })) : null);
    });
    const mark = icon("g");
    mark.setAttribute("class", "google-g");
    const connect = el("a", { class: "btn", href: state.connections.length ? "/auth/google/calendar" : "/auth/google/calendar?hint=self" },
      mark, el("span", { text: state.connections.length ? "connect another Google account" : "connect Google Calendar" }));
    box.replaceChildren(...accounts, connect);
  }

  function showSwitch(current, color, onPick, label) {
    return el("div", { class: "switch", role: "group", "aria-label": label },
      SHOWS.map(([show, text]) => el("button", {
        type: "button", "data-show": show, "aria-pressed": String(current === show), color: show === "full" ? color : undefined,
        onclick: () => { if (current !== show) onPick(show); },
      }, text)));
  }

  async function patchFeed(feed, body) {
    try { setState(await call("PATCH", `/feeds/${feed.id}`, body)); } catch (error) { toast(error.message, "bad"); render(); }
  }

  async function copy(button, text) {
    try {
      await navigator.clipboard.writeText(text);
      button.dataset.state = "copied";
      button.textContent = "copied";
    } catch {
      button.dataset.state = "failed";
      button.textContent = "copy failed";
    }
    setTimeout(() => { delete button.dataset.state; button.textContent = "copy"; }, 2000);
  }

  function renderFeeds() {
    const box = $("[data-feeds]");
    $("[data-new-link]").disabled = state.feeds.length >= state.limits.feeds;
    if (!state.feeds.length) {
      box.replaceChildren(el("p", { class: "empty", text: "No share links. Make one with “new link”." }));
      return;
    }
    box.replaceChildren(...state.feeds.map((feed) => {
      const name = el("input", { class: "link-name", value: feed.name, maxlength: "80", "aria-label": "Link name" });
      name.addEventListener("change", () => patchFeed(feed, { name: name.value }));
      name.addEventListener("keydown", (event) => { if (event.key === "Enter") name.blur(); });
      const copyButton = el("button", { class: "btn small", type: "button", onclick: () => copy(copyButton, feed.url) }, "copy");
      const rotate = el("button", { class: "btn small quiet", type: "button" }, el("span", { text: "new address" }));
      twoStep(rotate, "new address", "old one stops: click again", async () => {
        setState(await call("POST", `/feeds/${feed.id}/rotate`));
        toast("New address made. Calendar apps on the old one stop updating: give them the new one.", "good");
      });
      const remove = el("button", { class: "btn small quiet danger", type: "button" }, el("span", { text: "delete" }));
      twoStep(remove, "delete", "click again to delete", async () => setState(await call("DELETE", `/feeds/${feed.id}`)));
      const fromInput = el("input", { class: "select date", type: "date", value: localDay(feed.from), "aria-label": `${feed.name} shows events from` });
      const untilInput = el("input", { class: "select date", type: "date", value: feed.until ? localDay(new Date(new Date(feed.until).getTime() - 1)) : "", "aria-label": `${feed.name} shows events until` });
      const saveWindow = () => patchFeed(feed, { from: fromInput.value ? dayInstant(fromInput.value) : null, until: untilInput.value ? dayInstant(untilInput.value, 1) : null });
      fromInput.addEventListener("change", saveWindow);
      untilInput.addEventListener("change", saveWindow);
      const dates = el("div", { class: "window" },
        el("label", {}, el("span", { text: "from" }), fromInput, feed.from ? null : el("em", { text: "always" })),
        el("label", {}, el("span", { text: "until" }), untilInput, feed.until ? null : el("em", { text: "forever" })));
      const rows = state.sources.map((source, index) => {
        const current = feed.calendars[source.id] || feed.others;
        return el("div", { class: "show-row" },
          el("span", { class: "swatch", color: colorOf(source, index) }),
          el("span", { text: source.enabled ? source.name : `${source.name} (paused)` }),
          showSwitch(current, colorOf(source, index), (show) => patchFeed(feed, { calendars: { ...feed.calendars, [source.id]: show } }), `How ${feed.name} shows ${source.name}`));
      });
      const meta = [el("b", { text: String(feed.count) }), ` ${feed.count === 1 ? "event" : "events"} · updated ${ago(feed.builtAt) || "soon"} · `, feed.fetchedAt ? `read by a calendar app ${ago(feed.fetchedAt)}` : "not in a calendar app yet"];
      return el("article", { class: "link" },
        el("div", { class: "link-head" }, name),
        el("div", { class: "url" }, el("code", { text: feed.url.replace(/^https?:\/\//, "") }), copyButton, el("a", { class: "btn small", href: feed.webcal, text: "subscribe" })),
        el("div", { class: "shows" },
          rows,
          el("div", { class: "show-row others" },
            el("span", { class: "swatch later" }),
            el("span", { text: "calendars you add later" }),
            showSwitch(feed.others, "var(--ink-2)", (show) => patchFeed(feed, { others: show }), `How ${feed.name} shows calendars added later`))),
        feed.error ? el("p", { class: "link-error", text: feed.error }) : null,
        dates,
        el("div", { class: "link-foot" }, el("span", { class: "link-meta" }, meta), el("div", { class: "row" }, rotate, remove)));
    }));
  }

  function render() {
    if (!state) return;
    renderWho();
    renderStrip();
    renderSources();
    renderAccounts();
    renderFeeds();
  }

  function tick() {
    const target = state?.sync?.nextRunAt ? new Date(state.sync.nextRunAt).getTime() : 0;
    const node = $("[data-next]");
    if (!target) { node.textContent = "--:--"; return; }
    const left = Math.max(0, Math.round((target - Date.now()) / 1000));
    node.textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
    if (left === 0 && !tick.waiting) {
      tick.waiting = true;
      setTimeout(async () => {
        try { setState(await call("GET", "/me")); } catch {}
        tick.waiting = false;
      }, 20000);
    }
  }


  /* ---------- tabs ---------- */

  const TABS = ["accounts", "calendar", "share"];
  function currentTab() {
    const asked = location.hash.slice(1);
    if (TABS.includes(asked)) return asked;
    return state?.sources.length ? "calendar" : "accounts";
  }

  function showTab() {
    const tab = currentTab();
    for (const button of document.querySelectorAll("[data-tab]")) {
      const on = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== tab;
    if (tab === "calendar") loadCalendar();
  }

  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => {
      if (location.hash.slice(1) !== button.dataset.tab) history.replaceState(null, "", `#${button.dataset.tab}`);
      showTab();
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const index = (TABS.indexOf(button.dataset.tab) + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
      document.querySelector(`[data-tab="${TABS[index]}"]`).click();
      document.querySelector(`[data-tab="${TABS[index]}"]`).focus();
    });
  }
  window.addEventListener("hashchange", showTab);

  /* ---------- the calendar view ---------- */

  const HOUR = 46;
  const cal = { view: matchMedia("(max-width: 760px)").matches ? "agenda" : "week", anchor: new Date(), as: "", cache: new Map(), data: null, error: "" };
  const dayStart = (date) => { const copy = new Date(date); copy.setHours(0, 0, 0, 0); return copy; };
  const addDays = (date, days) => { const copy = new Date(date); copy.setDate(copy.getDate() + days); return copy; };
  const weekStart = (date) => addDays(dayStart(date), -((dayStart(date).getDay() + 6) % 7));
  const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const fromKey = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };
  const timeText = (date) => date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  function calRange() {
    if (cal.view === "week") { const start = weekStart(cal.anchor); return [start, addDays(start, 7)]; }
    if (cal.view === "month") { const start = weekStart(new Date(cal.anchor.getFullYear(), cal.anchor.getMonth(), 1)); return [start, addDays(start, 42)]; }
    const start = dayStart(cal.anchor);
    return [start, addDays(start, 14)];
  }

  function calTitle([start, end]) {
    if (cal.view === "month") return cal.anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const last = addDays(end, -1);
    const sameMonth = start.getMonth() === last.getMonth();
    return `${start.toLocaleDateString(undefined, { day: "numeric", ...(sameMonth ? {} : { month: "short" }) })} – ${last.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  }

  /** Each occurrence as local days and times, with the color and look of its calendar. */
  function placed(entry) {
    const index = state.sources.findIndex((source) => source.id === entry.source);
    const source = state.sources[index];
    const start = entry.allDay ? fromKey(entry.start.date) : new Date(entry.start.at);
    const end = entry.allDay ? fromKey(entry.end.date) : new Date(entry.end.at);
    return { ...entry, startDate: start, endDate: end > start ? end : new Date(start.getTime() + (entry.allDay ? 86400000 : 0)), color: source ? colorOf(source, index) : "var(--ink-3)", calendar: source?.name || "" };
  }

  function chip(item, { compact = false } = {}) {
    const busy = item.show === "busy";
    const label = busy ? "Busy" : item.title || "(No title)";
    const time = item.allDay ? "" : timeText(item.startDate);
    const node = el("button", { type: "button", class: `chip${busy ? " busy" : ""}${item.free ? " free" : ""}`, color: item.color, title: `${label}${time ? ` · ${time}` : ""}${item.calendar ? ` · ${item.calendar}` : ""}` },
      compact && time ? el("span", { class: "chip-time", text: time }) : null,
      el("span", { class: "chip-title", text: label }));
    node.addEventListener("click", () => toast(`${label} · ${item.allDay ? "all day" : `${timeText(item.startDate)}–${timeText(item.endDate)}`}${item.calendar ? ` · ${item.calendar}` : ""}${!busy && item.location ? ` · ${item.location}` : ""}`));
    return node;
  }

  /** Side-by-side columns for events that overlap within a day. */
  function columns(items) {
    const sorted = [...items].sort((a, b) => a.top - b.top || b.height - a.height);
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
      const lanes = [];
      for (const item of cluster) {
        let lane = lanes.findIndex((end) => end <= item.top);
        if (lane < 0) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = item.top + item.height;
        item.lane = lane;
      }
      for (const item of cluster) item.lanes = lanes.length;
      cluster = [];
    };
    for (const item of sorted) {
      if (item.top >= clusterEnd && cluster.length) { flush(); clusterEnd = -1; }
      cluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.top + item.height);
    }
    flush();
    return sorted;
  }

  function renderWeek([start], items) {
    const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    const today = dayKey(new Date());
    const allDay = items.filter((item) => item.allDay || item.endDate - item.startDate >= 86400000);
    const timed = items.filter((item) => !allDay.includes(item));
    const head = el("div", { class: "week-head" }, el("div", { class: "gutter" }),
      days.map((day) => el("div", { class: `day-head${dayKey(day) === today ? " today" : ""}` },
        el("span", { text: day.toLocaleDateString(undefined, { weekday: "short" }) }), el("b", { text: String(day.getDate()) }))));
    const allDayRow = el("div", { class: "week-allday" }, el("div", { class: "gutter", text: "all day" }),
      days.map((day) => el("div", { class: "allday-cell" }, allDay.filter((item) => item.startDate < addDays(day, 1) && item.endDate > day).map((item) => chip(item)))));
    const grid = el("div", { class: "week-grid" });
    grid.style.setProperty("--hour", `${HOUR}px`);
    grid.append(el("div", { class: "hours" }, Array.from({ length: 24 }, (_, hour) => el("span", { text: hour ? `${String(hour).padStart(2, "0")}:00` : "" }))));
    for (const day of days) {
      const column = el("div", { class: `day-col${dayKey(day) === today ? " today" : ""}` });
      const next = addDays(day, 1);
      const inDay = timed.filter((item) => item.startDate < next && item.endDate > day).map((item) => {
        const from = Math.max(item.startDate - day, 0) / 60000;
        const to = Math.min(item.endDate - day, 86400000) / 60000;
        return { item, top: from / 60 * HOUR, height: Math.max((to - from) / 60 * HOUR, 22) };
      });
      for (const block of columns(inDay)) {
        const node = chip(block.item, { compact: true });
        node.classList.add("block");
        if (block.height < 40) node.classList.add("short");
        node.style.top = `${block.top}px`;
        node.style.height = `${block.height - 2}px`;
        node.style.left = `calc(${(block.lane / block.lanes) * 100}% + 2px)`;
        node.style.width = `calc(${100 / block.lanes}% - 4px)`;
        column.append(node);
      }
      if (dayKey(day) === today) {
        const now = new Date();
        const line = el("div", { class: "now-line" });
        line.style.top = `${(now.getHours() * 60 + now.getMinutes()) / 60 * HOUR}px`;
        column.append(line);
      }
      grid.append(column);
    }
    const scroller = el("div", { class: "week-scroll" }, grid);
    requestAnimationFrame(() => { scroller.scrollTop = 7.5 * HOUR; });
    return el("div", { class: "week" }, head, allDayRow, scroller);
  }

  function renderMonth([start], items) {
    const month = cal.anchor.getMonth();
    const today = dayKey(new Date());
    const names = Array.from({ length: 7 }, (_, index) => addDays(start, index).toLocaleDateString(undefined, { weekday: "short" }));
    return el("div", { class: "month" },
      names.map((name) => el("div", { class: "month-name", text: name })),
      Array.from({ length: 42 }, (_, index) => {
        const day = addDays(start, index);
        const inDay = items.filter((item) => item.startDate < addDays(day, 1) && item.endDate > day);
        return el("div", { class: `month-cell${day.getMonth() === month ? "" : " other"}${dayKey(day) === today ? " today" : ""}` },
          el("span", { class: "month-day", text: String(day.getDate()) }),
          inDay.slice(0, 3).map((item) => chip(item, { compact: true })),
          inDay.length > 3 ? el("span", { class: "more", text: `+${inDay.length - 3} more` }) : null);
      }));
  }

  function renderAgenda([start], items) {
    const days = Array.from({ length: 14 }, (_, index) => addDays(start, index));
    const today = dayKey(new Date());
    const rows = days.map((day) => {
      const inDay = items.filter((item) => item.startDate < addDays(day, 1) && item.endDate > day);
      if (!inDay.length) return null;
      return el("div", { class: `agenda-day${dayKey(day) === today ? " today" : ""}` },
        el("div", { class: "agenda-date" }, el("b", { text: String(day.getDate()) }), el("span", { text: day.toLocaleDateString(undefined, { weekday: "short", month: "short" }) })),
        el("div", { class: "agenda-items" }, inDay.map((item) => el("div", { class: "agenda-item" },
          el("span", { class: "agenda-time", text: item.allDay || item.endDate - item.startDate >= 86400000 ? "all day" : `${timeText(item.startDate)}–${timeText(item.endDate)}` }),
          chip(item)))));
    }).filter(Boolean);
    return rows.length ? el("div", { class: "agenda" }, rows) : el("p", { class: "empty", text: "Nothing in these two weeks." });
  }

  function renderCalendar() {
    const range = calRange();
    $("[data-cal-title]").textContent = calTitle(range);
    for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === cal.view));
    const select = $("[data-cal-as]");
    select.replaceChildren(el("option", { value: "", text: "everything (only you)" }), ...state.feeds.map((feed) => el("option", { value: feed.id, text: `as “${feed.name}”` })));
    select.value = state.feeds.some((feed) => feed.id === cal.as) ? cal.as : "";
    const body = $("[data-cal-body]");
    if (!state.sources.length) {
      body.replaceChildren(el("div", { class: "cal-empty" }, el("p", { text: "Your merged calendar shows up here once it has calendars in it." }), el("a", { class: "btn primary", href: "#accounts", text: "add calendars" })));
      return;
    }
    if (cal.error) { body.replaceChildren(el("p", { class: "link-error", text: cal.error })); return; }
    if (!cal.data) { body.replaceChildren(el("p", { class: "empty", text: "Reading your calendar…" })); return; }
    const items = cal.data.map(placed);
    body.replaceChildren(cal.view === "week" ? renderWeek(range, items) : cal.view === "month" ? renderMonth(range, items) : renderAgenda(range, items));
  }

  async function loadCalendar() {
    if (!state) return;
    const [from, to] = calRange();
    const key = `${cal.as}|${from.toISOString()}|${to.toISOString()}`;
    cal.error = "";
    if (!cal.cache.has(key)) {
      cal.data = null;
      cal.cache.set(key, call("GET", `/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}${cal.as ? `&link=${cal.as}` : ""}`).then((data) => data.occurrences));
    }
    renderCalendar();
    try {
      const data = await cal.cache.get(key);
      if (key !== `${cal.as}|${calRange()[0].toISOString()}|${calRange()[1].toISOString()}`) return;
      cal.data = data;
    } catch (error) {
      cal.cache.delete(key);
      cal.error = error.message;
    }
    renderCalendar();
  }

  const step = (direction) => {
    if (cal.view === "month") cal.anchor = new Date(cal.anchor.getFullYear(), cal.anchor.getMonth() + direction, 1);
    else cal.anchor = addDays(cal.anchor, (cal.view === "week" ? 7 : 14) * direction);
    loadCalendar();
  };
  $("[data-cal-prev]").addEventListener("click", () => step(-1));
  $("[data-cal-next]").addEventListener("click", () => step(1));
  $("[data-cal-today]").addEventListener("click", () => { cal.anchor = new Date(); loadCalendar(); });
  for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => { cal.view = button.dataset.view; loadCalendar(); });
  $("[data-cal-as]").addEventListener("change", (event) => { cal.as = event.target.value; loadCalendar(); });

  $("[data-add-link]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.lastChild.textContent = "reading…";
    try {
      const result = await call("POST", "/sources", { kind: "link", url: form.url.value, name: form.name.value || undefined });
      form.reset();
      setState(result.state);
      toast(`${result.source.name} is in: ${events(result.source.eventCount)}.`, "good");
    } catch (error) {
      toast(error.message, "bad");
    } finally {
      button.disabled = false;
      button.lastChild.textContent = "add";
    }
  });

  $("[data-new-link]").addEventListener("click", async () => {
    const calendars = Object.fromEntries(state.sources.map((source) => [source.id, "busy"]));
    try {
      setState(await call("POST", "/feeds", { name: `Share link ${state.feeds.length + 1}`, calendars, others: "busy", from: dayInstant(localDay(new Date().toISOString())), until: null }));
      toast("New link: every calendar starts as busy time. Switch any of them to full or off.", "good");
    } catch (error) { toast(error.message, "bad"); }
  });

  twoStep($("[data-delete-account]"), "delete account", "click again: everything goes", async () => {
    await call("DELETE", "/account");
    location.href = "/";
  });
  $("[data-delete-account]").replaceChildren(document.createTextNode("delete account"));

  (async () => {
    const params = new URLSearchParams(location.search);
    try {
      setState(await call("GET", "/me"));
    } catch (error) {
      if (error.message !== "signed out") toast(error.message, "bad");
      return;
    }
    if (params.get("problem")) toast(params.get("problem"), "bad");
    const connected = state.connections.find((connection) => connection.id === params.get("connected"));
    if (connected) {
      history.replaceState(null, "", "/app#accounts");
      toast(`${connected.email} is connected. Add the calendars you want to merge.`, "good");
      await togglePicker(connected);
    } else if (params.toString()) history.replaceState(null, "", `/app${location.hash}`);
    showTab();
    tick();
    setInterval(tick, 1000);
    setInterval(() => { if (!document.hidden) render(); }, 60000);
  })();
})();
