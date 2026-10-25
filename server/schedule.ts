/** Round-robin pairings (circle method) with colors balanced per player (difference ≤ 1). */
export function roundRobin(ids: string[], double: boolean) {
  const list = ids.length % 2 ? [...ids, "BYE"] : [...ids];
  const n = list.length;
  const pairings: { white: string; black: string }[] = [];
  const whites: Record<string, number> = {};
  const blacks: Record<string, number> = {};
  for (let round = 0; round < n - 1; round++) {
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a === "BYE" || b === "BYE") continue;
      // Give White to whoever is owed it most.
      const owe = (p: string) => (blacks[p] ?? 0) - (whites[p] ?? 0);
      const aWhite = owe(a) !== owe(b) ? owe(a) > owe(b) : (round + i) % 2 === 0;
      const [w, bl] = aWhite ? [a, b] : [b, a];
      whites[w] = (whites[w] ?? 0) + 1;
      blacks[bl] = (blacks[bl] ?? 0) + 1;
      pairings.push({ white: w, black: bl });
    }
    list.splice(1, 0, list.pop()!);
  }
  if (double) pairings.push(...pairings.map((p) => ({ white: p.black, black: p.white })));
  return pairings;
}

/**
 * Which colour plays a split experiment's `a` in each pairing (Tournament.setups). A pair of players keeps `a` on
 * the same colour in all its games: in a double round-robin the return game swaps the colours, which hands `a` to the
 * other player, so each model plays every opponent once under `a` and once under `b`. Which colour that is, pair by
 * pair, is chosen so each model plays `a` (and `b`) as White as often as it can as Black: otherwise a model's `a`
 * games could all be its White games, and comparing its setups would measure the colour. A single round-robin
 * balances first how many games each model plays under `a`, then the colours.
 */
export function splitSides(pairings: { white: string; black: string; aSide?: "w" | "b" }[]) {
  const pairOf = (p: { white: string; black: string }) => [p.white, p.black].sort().join("|");
  const keys = [...new Set(pairings.map(pairOf))];
  const ids = [...new Set(pairings.flatMap((p) => [p.white, p.black]))];
  const idx = new Map(ids.map((id, i) => [id, i]));
  // Each pair: its two players, and its games as [white, black] indexes.
  const pairs = keys.map((k) => {
    const games = pairings.filter((p) => pairOf(p) === k).map((p) => [idx.get(p.white)!, idx.get(p.black)!] as const);
    return { k, ends: [games[0][0], games[0][1]], games };
  });
  // Per model: games under a minus under b; a as White minus a as Black; b likewise. Kept up to date flip by flip.
  const n = new Array(ids.length).fill(0);
  const aw = new Array(ids.length).fill(0);
  const bw = new Array(ids.length).fill(0);
  const aWhite = new Array(pairs.length).fill(true);
  const costOf = (i: number) => 4 * Math.abs(n[i]) + Math.abs(aw[i]) + Math.abs(bw[i]);
  /** Add (+1) or take away (−1) a pair's games under its current colour. */
  const tally = (pi: number, sign: number) => {
    for (const [w, b] of pairs[pi].games) {
      const [a, o] = aWhite[pi] ? [w, b] : [b, w];
      n[a] += sign;
      n[o] -= sign;
      aw[a] += sign * (aWhite[pi] ? 1 : -1);
      bw[o] += sign * (aWhite[pi] ? -1 : 1);
    }
  };
  /** Flip a pair's colour; what it did to the total cost (only its two players change). */
  const flip = (pi: number) => {
    const [x, y] = pairs[pi].ends;
    const before = costOf(x) + costOf(y);
    tally(pi, -1);
    aWhite[pi] = !aWhite[pi];
    tally(pi, 1);
    return costOf(x) + costOf(y) - before;
  };
  const total = () => ids.reduce((c, _, i) => c + costOf(i), 0);
  // From a few starting points (the same every time), flip any one or two pairs' colour that makes the balance
  // better until none does (each kept flip lowers the cost, and the sweeps are capped), and keep the best. The cost
  // of a flip is worked out from its two players alone, so even a big tournament takes a moment, not the server.
  let best: boolean[] = [];
  let bestCost = Infinity;
  let seed = 1;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let start = 0; start < 8 && bestCost > 0; start++) {
    n.fill(0), aw.fill(0), bw.fill(0);
    pairs.forEach((_, i) => {
      aWhite[i] = start === 0 ? i % 2 === 0 : rand() < 0.5;
      tally(i, 1);
    });
    for (let sweep = 0, improved = true; improved && sweep < 50; sweep++) {
      improved = false;
      for (let i = 0; i < pairs.length; i++)
        for (let j = i; j < pairs.length; j++) {
          const d = flip(i) + (j !== i ? flip(j) : 0);
          if (d < 0) improved = true;
          else {
            if (j !== i) flip(j);
            flip(i);
          }
        }
    }
    const c = total();
    if (c < bestCost) (bestCost = c), (best = [...aWhite]);
  }
  const side = new Map(pairs.map((p, i) => [p.k, best[i] ? ("w" as const) : ("b" as const)]));
  for (const p of pairings) p.aSide = side.get(pairOf(p));
}
