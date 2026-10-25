import { useEffect, useRef, useState } from "react";
import { GamePage } from "./pages/GamePage";
import { Lobby } from "./pages/Lobby";
import { PlayerPage } from "./pages/PlayerPage";
import { TournamentPage } from "./pages/TournamentPage";
import { AgentsPage } from "./pages/AgentsPage";
import { ExperimentsPage } from "./pages/ExperimentsPage";
import { NewGameModal, NewTournamentModal, PlayAgentModal } from "./components/NewGame";
import { VideoPage } from "./video/VideoPage";
import { useMeta } from "./api";

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
  const meta = useMeta();
  // Until the server says otherwise, act like the public site: no buttons that would only be refused.
  const local = !!meta && !meta.publicMode;
  const [modal, setModal] = useState<"game" | "play" | "tournament" | null>(null);
  // On a phone the extra nav items (local actions, the public site) fold into a menu.
  const [menu, setMenu] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => setMenu(false), [route]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(false);
      moreBtn.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  const [path, search = ""] = route.split("?");
  const [, section, arg] = path.split("/");
  const id = arg ? decodeURIComponent(arg) : "";
  const open = (m: "game" | "play" | "tournament") => (setMenu(false), setModal(m));
  const extra = local || !!meta?.publicUrl;

  // Video frames render bare, without the site chrome.
  if (section === "video" && id) return <VideoPage key={id} id={id} query={new URLSearchParams(search)} />;

  let page: React.ReactNode;
  if (section === "game" && id) page = <GamePage key={id} id={id} />;
  else if (section === "player" && id) page = <PlayerPage id={id} />;
  else if (section === "tournament" && id) page = <TournamentPage id={id} />;
  else if (section === "agents") page = <AgentsPage model={id} query={new URLSearchParams(search)} />;
  else if (section === "experiments") page = <ExperimentsPage query={new URLSearchParams(search)} />;
  else page = <Lobby local={local} onNewGame={() => setModal("game")} onPlay={() => setModal("play")} onNewTournament={() => setModal("tournament")} />;

  return (
    <div className="app">
      <nav className="sidebar">
        <a className="logo" href="#/" title="Agent Chess">
          <span className="knight">♞</span>
          <span className="logo-text">
            Agent<small>Chess</small>
          </span>
        </a>
        <div className="nav-main">
          <a className={`nav-item ${!section ? "active" : ""}`} href="#/" title="Watch">
            <span className="ico">📺</span> <span className="lbl">Watch</span>
          </a>
          <a className={`nav-item ${section === "agents" ? "active" : ""}`} href="#/agents" title="Agents">
            <span className="ico">🤖</span> <span className="lbl">Agents</span>
          </a>
          <a className={`nav-item ${section === "experiments" ? "active" : ""}`} href="#/experiments" title="Experiments">
            <span className="ico">🔬</span> <span className="lbl">Experiments</span>
          </a>
          {extra && (
            <button
              ref={moreBtn}
              className={`nav-item nav-more ${menu ? "active" : ""}`}
              onClick={() => setMenu(!menu)}
              aria-expanded={menu}
              aria-controls="nav-extra"
              aria-haspopup="true"
              aria-label="More"
              title="More"
            >
              <span className="ico">☰</span> <span className="lbl">More</span>
            </button>
          )}
        </div>
        {extra && (
          <div id="nav-extra" className={`nav-extra ${menu ? "open" : ""}`}>
            {local && (
              <>
                <div className="nav-sep" />
                <button className="nav-item" onClick={() => open("game")} title="New game">
                  <span className="ico">♟️</span> <span className="lbl">New game</span>
                </button>
                <button className="nav-item" onClick={() => open("play")} title="Play an agent">
                  <span className="ico">🧑</span> <span className="lbl">Play an agent</span>
                </button>
                <button className="nav-item" onClick={() => open("tournament")} title="Tournament">
                  <span className="ico">🏆</span> <span className="lbl">Tournament</span>
                </button>
              </>
            )}
            {meta?.publicUrl && (
              <a className="nav-item" href={meta.publicUrl} target="_blank" rel="noreferrer" title={meta.mirror?.synced ? "The public site is in sync" : "Not synced yet"}>
                <span className="ico">🌐</span> <span className="lbl">Public site {meta.mirror?.synced ? "" : "…"}</span>
              </a>
            )}
          </div>
        )}
        {menu && <div className="nav-scrim" onClick={() => setMenu(false)} />}
      </nav>
      <main className="main">{page}</main>
      {modal === "game" && <NewGameModal onClose={() => setModal(null)} />}
      {modal === "play" && <PlayAgentModal onClose={() => setModal(null)} />}
      {modal === "tournament" && <NewTournamentModal onClose={() => setModal(null)} />}
    </div>
  );
}
