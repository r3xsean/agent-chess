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
