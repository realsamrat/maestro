import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/fonts.css";
import "./styles/globals.css";

// Apply platform class for CSS overrides (e.g. Linux performance fixes)
if (navigator.userAgent.includes("Linux")) {
  document.documentElement.classList.add("platform-linux");
}

// Disable browser native context menu in production — not appropriate in a
// desktop app, and "Reload" in it would destroy all active terminal sessions.
// Left enabled in dev mode so DevTools remain accessible via right-click.
if (!import.meta.env.DEV) {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
