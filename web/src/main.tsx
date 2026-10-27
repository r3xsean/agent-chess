import { createRoot } from "react-dom/client";
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.cburnett.css";
import "./styles.css";
import { App } from "./App";

// A page left open across a new build asks for parts of the old one, which are gone: load the new build instead
// (once a minute at most, so a part that's really missing can't reload the page over and over).
window.addEventListener("vite:preloadError", (e) => {
  const last = Number(sessionStorage.getItem("reloadedForBuild") ?? 0);
  if (Date.now() - last < 60_000) return;
  e.preventDefault();
  sessionStorage.setItem("reloadedForBuild", String(Date.now()));
  location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);
