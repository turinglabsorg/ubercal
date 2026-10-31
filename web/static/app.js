(() => {
  const PALETTE = ["--cal-1", "--cal-2", "--cal-3", "--cal-4", "--cal-5", "--cal-6"];
  const SHOWS = [["full", "full"], ["busy", "busy"], ["hidden", "off"]];
  const PAST = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"], [0, "all of it"]];
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
    render();
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
      const past = el("select", { class: "select", "aria-label": "How far back" }, PAST.map(([days, text]) => el("option", { value: String(days), selected: feed.pastDays === days, text: `back ${text}` })));
      past.addEventListener("change", () => patchFeed(feed, { pastDays: Number(past.value) }));
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
        el("div", { class: "link-foot" }, el("span", { class: "link-meta" }, meta), el("div", { class: "row" }, past, rotate, remove)));
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
      setState(await call("POST", "/feeds", { name: `Share link ${state.feeds.length + 1}`, calendars, others: "busy" }));
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
      toast(`${connected.email} is connected. Add the calendars you want to merge.`, "good");
      await togglePicker(connected);
    }
    if (params.toString()) history.replaceState(null, "", "/app");
    tick();
    setInterval(tick, 1000);
    setInterval(() => { if (!document.hidden) render(); }, 60000);
  })();
})();
