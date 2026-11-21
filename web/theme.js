"use strict";
// Laeuft vor dem Stylesheet, damit Theme und Ansicht nicht erst nach dem Laden umspringen.
(function () {
  let theme = "system";
  let layout = "standard";
  try {
    const prefs = JSON.parse(localStorage.getItem("homey-dash") || "{}");
    theme = prefs.theme || theme;
    layout = prefs.layout || layout;
  } catch { /* blockiert */ }
  // ?theme=…&layout=… gilt nur fuer diesen Aufruf (Screenshots, Vorschau), gespeichert wird nichts
  const url = new URLSearchParams(location.search);
  theme = url.get("theme") || theme;
  layout = url.get("layout") || layout;
  if (!["system", "omarchy", "aurora", "klar", "papier", "nacht", "bento"].includes(theme)) theme = "system";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.layout = ["standard", "uebersicht", "raeume", "grundriss"].includes(layout) ? layout : "standard";
})();
