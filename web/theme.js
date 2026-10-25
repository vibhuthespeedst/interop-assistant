// Applies the reader's saved theme before the page is drawn, so it never flashes the other one.
// Loaded as a plain script in <head>; app.js owns the theme button.
try {
  const theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch { /* storage blocked: follow the system theme */ }
