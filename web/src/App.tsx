import { useEffect, useState } from "react";
import { GamePage } from "./pages/GamePage";
import { Lobby } from "./pages/Lobby";
import { PlayerPage } from "./pages/PlayerPage";
import { TournamentPage } from "./pages/TournamentPage";
import { MemoryPage } from "./pages/MemoryPage";
import { PersonalitiesPage } from "./pages/PersonalitiesPage";
import { NewGameModal, NewTournamentModal } from "./components/NewGame";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

export function App() {
  const route = useHash();
  const [modal, setModal] = useState<"game" | "tournament" | null>(null);
  const [, section, arg] = route.split("/");
  const id = arg ? decodeURIComponent(arg) : "";

  let page: React.ReactNode;
  if (section === "game" && id) page = <GamePage key={id} id={id} />;
  else if (section === "player" && id) page = <PlayerPage id={id} />;
  else if (section === "tournament" && id) page = <TournamentPage id={id} />;
  else if (section === "memory") page = <MemoryPage />;
  else if (section === "personalities") page = <PersonalitiesPage />;
  else page = <Lobby onNewGame={() => setModal("game")} onNewTournament={() => setModal("tournament")} />;

  return (
    <div className="app">
      <nav className="sidebar">
        <a className="logo" href="#/">
          <span className="knight">♞</span>
          <span>
            Agent<small>Chess</small>
          </span>
        </a>
        <a className={`nav-item ${!section ? "active" : ""}`} href="#/">
          <span className="ico">📺</span> Watch
        </a>
        <a className={`nav-item ${section === "memory" ? "active" : ""}`} href="#/memory">
          <span className="ico">🧠</span> Memory
        </a>
        <a className={`nav-item ${section === "personalities" ? "active" : ""}`} href="#/personalities">
          <span className="ico">🎭</span> Personalities
        </a>
        <button className="nav-item" style={{ background: "none", border: "none", textAlign: "left" }} onClick={() => setModal("game")}>
          <span className="ico">♟</span> New game
        </button>
        <button className="nav-item" style={{ background: "none", border: "none", textAlign: "left" }} onClick={() => setModal("tournament")}>
          <span className="ico">🏆</span> Tournament
        </button>
      </nav>
      <main className="main">{page}</main>
      {modal === "game" && <NewGameModal onClose={() => setModal(null)} />}
      {modal === "tournament" && <NewTournamentModal onClose={() => setModal(null)} />}
    </div>
  );
}
