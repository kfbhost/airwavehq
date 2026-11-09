import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./css/app.css";

// Apply the saved theme before first paint so there's no flash of the wrong theme.
try {
  if (localStorage.getItem("rhs_theme") === "light") {
    document.documentElement.dataset.theme = "light";
  }
} catch {
  /* ignore */
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
