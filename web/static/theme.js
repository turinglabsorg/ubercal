// The theme the person chose, set before the page paints; without a choice the system decides.
(() => {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem("ubercal.theme");
    if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  } catch {}
  // Safari zooms on a pinch whatever the page says; like an app, the page does not zoom.
  for (const gesture of ["gesturestart", "gesturechange"]) document.addEventListener(gesture, (event) => event.preventDefault(), { passive: false });
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.("[data-theme-toggle]")) return;
    const current = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    root.dataset.theme = current === "dark" ? "light" : "dark";
    try { localStorage.setItem("ubercal.theme", root.dataset.theme); } catch {}
  });
})();
