(() => {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const problem = new URLSearchParams(location.search).get("problem");
  const notice = document.querySelector("[data-problem]");
  if (problem && notice) {
    notice.textContent = problem;
    notice.hidden = false;
    history.replaceState(null, "", location.pathname);
  }
  fetch("/auth/session", { credentials: "same-origin" }).then((response) => response.json()).then((session) => {
    if (!session.signedIn) return;
    for (const link of document.querySelectorAll("[data-signin]")) link.href = "/app";
    for (const label of document.querySelectorAll("[data-signin-label]")) label.textContent = "Open ubercal";
  }).catch(() => {});
  const countdown = document.querySelector("[data-countdown]");
  let left = 600;
  const pad = (value) => String(value).padStart(2, "0");
  if (countdown && !still) {
    setInterval(() => {
      left = left <= 0 ? 600 : left - 1;
      countdown.textContent = `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
    }, 1000);
  }
  if (!still) {
    for (const digits of document.querySelectorAll("[data-count]")) {
      const target = Number(digits.dataset.count);
      let value = 0;
      digits.textContent = "00";
      const timer = setInterval(() => {
        value += 1;
        digits.textContent = pad(value);
        if (value >= target) clearInterval(timer);
      }, 900 / target);
    }
  }
})();
