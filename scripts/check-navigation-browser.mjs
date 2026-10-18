// Run in the browser's page context on the built app (e.g. preview_evaluate).
// Uses a read-only game snapshot and synthetic SSE events; never writes to a game.
export async function checkNavigation(gameId = "g6cn235c72") {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const source = await fetch(`/api/games/${gameId}`).then(r => r.json());
  const NativeEventSource = window.EventSource;
  const originalHash = location.hash;
  let stream;
  let fixture = { ...source, phase: "playing", result: null, termination: null, review: undefined,
    clockPause: undefined, pendingIllegal: {}, pendingTries: {}, moves: source.moves.slice(0, 60) };
  const emit = () => stream.onmessage?.(new MessageEvent("message", { data: JSON.stringify(fixture) }));
  const tab = name => [...document.querySelectorAll(".tabs button")].find(b => b.textContent.includes(name));
  const click = title => document.querySelector(`.panel-footer button[title="${title}"]`).click();
  const key = (key, count = 1, target = window) => {
    for (let i = 0; i < count; i++) target.dispatchEvent(new KeyboardEvent("keydown", { key, repeat: i > 0, bubbles: true, cancelable: true }));
  };
  const selected = () => {
    const el = document.querySelector(".thought.on");
    return el?.dataset.try ? `try:${el.dataset.try}` : `ply:${el?.dataset.ply ?? 0}`;
  };
  const positions = ["ply:0"];
  for (const m of fixture.moves) {
    m.illegalAttempts.forEach((_, i) => positions.push(`try:${m.ply - 1}:${i}`));
    positions.push(`ply:${m.ply}`);
  }
  const results = [];
  try {
    location.hash = "#/";
    await wait(100);
    window.EventSource = class extends EventTarget {
      constructor(url) {
        super();
        if (!String(url).endsWith(`/games/${gameId}/stream`)) return new NativeEventSource(url);
        stream = this;
        setTimeout(emit, 0);
      }
      close() {}
    };
    location.hash = `#/game/${gameId}`;
    for (let i = 0; i < 100 && !tab("Thinking"); i++) await wait(50);
    assert(tab("Thinking"), "Game mounted");
    for (const label of ["Thinking", "Moves", "Studio", "Review", "Predict"]) {
      tab(label).click(); await wait(80);
      click("Start"); await wait(50);
      key("ArrowRight", 25); await wait(100);
      tab("Thinking").click(); await wait(80);
      assert(selected() === positions[25], `${label}: burst must preserve all 25 steps, including illegal attempts`);
      key("ArrowLeft", 25); await wait(100);
      assert(selected() === "ply:0", `${label}: reverse burst returns to start`);
      key("ArrowRight", 1000); await wait(100);
      assert(selected() === "ply:60", `${label}: burst clamps at latest`);

      tab(label).click(); await wait(80);
      const durations = [], tasks = [];
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({ type: "longtask" });
      for (let i = 0; i < 40; i++) {
        const start = performance.now();
        key("ArrowLeft");
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        durations.push(performance.now() - start);
      }
      observer.disconnect();
      durations.sort((a, b) => a - b);
      results.push({ tab: label, medianMs: durations[20], p95Ms: durations[38], longTasks: tasks.length });
    }
    tab("Thinking").click(); await wait(80);
    click("Latest"); await wait(80);
    fixture = { ...fixture, moves: source.moves.slice(0, 61) };
    emit(); await wait(100);
    assert(selected() === "ply:61", "Live move advances selection and material cache");
    key("ArrowLeft", 5); await wait(80);
    const pinned = selected();
    fixture = { ...fixture, moves: source.moves.slice(0, 62) };
    emit(); await wait(100);
    assert(selected() === pinned, "Incoming live moves preserve a historical selection");
    const input = document.createElement("textarea");
    document.body.append(input); input.focus(); key("ArrowLeft", 3, input); await wait(60);
    assert(selected() === pinned, "Arrow keys in an editor don't navigate the board");
    input.remove();
    const line = [...document.querySelectorAll(".thought[data-ply] .line-chip")].find(b => b.querySelector(".lm")?.textContent.trim().split(" ").length >= 2);
    assert(line, "Fixture has a playable calculation");
    line.click(); await wait(60);
    key("ArrowRight", 2); await wait(80);
    assert(document.querySelectorAll(".calc-moves span.on").length === 1, "Calculation burst selects one step");
    key("Escape"); await wait(60);
    assert(!document.querySelector(".calc-moves"), "Escape exits the calculation");
    click("Latest"); await wait(60);
    const top = document.querySelector(".board-size").getBoundingClientRect().top;
    key("ArrowLeft", 1000); await wait(100);
    assert(Math.abs(document.querySelector(".board-size").getBoundingClientRect().top - top) < 1, "Feed navigation never scrolls the page away from the board");
    assert(selected() === "ply:0", "Final burst settles at start without queued navigation");
    return { checks: "bursts, illegal attempts, bounds, live SSE, pinned history, text input, calculations, and page scroll passed", results };
  } finally {
    location.hash = "#/";
    await wait(80);
    window.EventSource = NativeEventSource;
    location.hash = originalHash;
  }
}
