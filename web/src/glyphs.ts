import type { GlyphId } from "../../shared/looks";

/*
 * The model glyphs (see shared/looks.ts for who gets which): SVG markup on a 24×24 grid, drawn in `fg`
 * with cut-outs in `bg` (the tile behind it), so one drawing serves a tile, a tag and the video.
 */

type Pt = [number, number];
const r2 = (n: number) => +n.toFixed(2);
const pol = (cx: number, cy: number, r: number, deg: number): Pt => [r2(cx + r * Math.cos((deg * Math.PI) / 180)), r2(cy + r * Math.sin((deg * Math.PI) / 180))];
/** A four-point star, pinched toward the centre, haloed in `bg` so lines stop short of it. */
const spark = ([cx, cy]: Pt, R: number, fg: string, bg: string) => {
  const s = R * 0.2;
  return `<path d="M${cx} ${r2(cy - R)}Q${r2(cx + s)} ${r2(cy - s)} ${r2(cx + R)} ${cy}Q${r2(cx + s)} ${r2(cy + s)} ${cx} ${r2(cy + R)}Q${r2(cx - s)} ${r2(cy + s)} ${r2(cx - R)} ${cy}Q${r2(cx - s)} ${r2(cy - s)} ${cx} ${r2(cy - R)}Z" fill="${fg}" stroke="${bg}" stroke-width="1.2" paint-order="stroke" stroke-linejoin="round"/>`;
};
const star = ([x, y]: Pt, r: number, fg: string, bg: string) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fg}" stroke="${bg}" stroke-width="1.2" paint-order="stroke"/>`;
const polyline = (runs: Pt[][], fg: string) =>
  `<path d="${runs.map((run) => "M" + run.map((p) => p.join(" ")).join("L")).join("")}" fill="none" stroke="${fg}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;

export const GLYPHS: Record<GlyphId, (fg: string, bg: string) => string> = {
  // Claude: literary forms
  keys: (fg, bg) =>
    `<rect x="2.5" y="4" width="19" height="16" rx="2.2" fill="${fg}"/><path d="M7.25 12.5V20M12 12.5V20M16.75 4V20" stroke="${bg}" stroke-width="1.3"/><rect x="5.6" y="4" width="3.3" height="9" rx=".6" fill="${bg}"/><rect x="10.35" y="4" width="3.3" height="9" rx=".6" fill="${bg}"/><rect x="2.5" y="4" width="19" height="16" rx="2.2" fill="none" stroke="${fg}" stroke-width="1.2"/>`,
  fox: (fg, bg) =>
    `<path fill="${fg}" d="M3 3.2 8.7 8h6.6L21 3.2l-.5 8.8c0 1.6-.7 3.1-1.9 4.2L12 21.2l-6.6-5C4.2 15.1 3.5 13.6 3.5 12z"/><path fill="${bg}" d="M5 6.1 7.7 8.4 5.3 9.9zM19 6.1 16.3 8.4 18.7 9.9z"/><ellipse cx="9" cy="12.6" rx="1.25" ry=".8" transform="rotate(25 9 12.6)" fill="${bg}"/><ellipse cx="15" cy="12.6" rx="1.25" ry=".8" transform="rotate(-25 15 12.6)" fill="${bg}"/><path fill="${bg}" d="M10.7 17.4h2.6L12 18.9z"/>`,
  quill: (fg, bg) =>
    `<path fill="${fg}" d="M20.8 2.8C12.6 3.2 6.9 8.6 6.2 16.6L3.6 21l.9.9 4.4-2.7c8-1 12.3-7.6 11.9-16.4z"/><path d="M17.8 5.9 6.4 18.4" stroke="${bg}" stroke-width="1.3" stroke-linecap="round"/><path d="M15.6 3.7 14.4 6.2M19.9 8.1 17.4 9.2M10.6 7.4l.8 2.3" stroke="${bg}" stroke-width="1.1" stroke-linecap="round"/>`,
  blossom: (fg, bg) => {
    const ring = (r: number, offset = -90) => [0, 1, 2, 3, 4].map((i) => pol(12, 12.3, r, i * 72 + offset));
    return (
      ring(5.2).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4.15" fill="${fg}"/>`).join("") +
      ring(9.5).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.1" fill="${bg}"/>`).join("") +
      `<circle cx="12" cy="12.3" r="2.3" fill="${bg}"/>` +
      ring(1.15, -54).map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".5" fill="${fg}"/>`).join("")
    );
  },
  // OpenAI: sky and earth
  sun: (fg) =>
    `<circle cx="12" cy="12" r="4.6" fill="${fg}"/>` +
    [0, 1, 2, 3, 4, 5, 6, 7]
      .map((i) => {
        const [x1, y1] = pol(12, 12, 6.8, i * 45), [x2, y2] = pol(12, 12, i % 2 ? 8.9 : 10.2, i * 45);
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${fg}" stroke-width="2.1" stroke-linecap="round"/>`;
      })
      .join(""),
  dipper: (fg, bg) => {
    const handle: Pt[] = [[2, 3.8], [6.4, 6], [10, 9.4]];
    const bowl: Pt[] = [[10, 9.4], [10.8, 17.6], [20, 19.4], [21.6, 10.6]];
    return (
      polyline([handle, [...bowl, bowl[0]]], fg) +
      star(handle[0], 1.5, fg, bg) + star(handle[1], 1.6, fg, bg) + star(bowl[0], 1.7, fg, bg) +
      spark(bowl[1], 3.5, fg, bg) + star(bowl[2], 1.8, fg, bg) + star(bowl[3], 1.7, fg, bg)
    );
  },
  earth: (fg, bg) =>
    `<circle cx="12" cy="12" r="9.2" fill="${fg}"/><path fill="${bg}" d="M7 4.7c1.9-.3 3.4.7 3.2 2.1-.2 1.2-1.6 1.4-1.8 2.6-.2 1.2 1.2 2 2.2 3 1 1 .6 2.6-.4 3.6-.8.8-.6 2.4-1.4 3.6-.6-.3-1.2-.7-1.7-1.2.3-1.6-.1-3.2-.9-4.4-.8-1.2-2.4-1.6-3-3 .2-2.6 1.6-5 3.8-6.3z"/><path fill="${bg}" d="M14.2 7.8c1.6-.6 3.4-.2 4.6.8 1 1 1.8 2.4 2 4-.8 1.4-1.8 2.2-2.2 3.6-.4 1.4-1.6 2.4-2.8 2.2-.6-1.4-.2-2.8-1-4-.8-1.2-2.2-1.8-2-3.4.2-1.2.6-2.4 1.4-3.2z"/><ellipse cx="15.4" cy="4.9" rx="1.4" ry=".8" fill="${bg}"/>`,
  crescent: (fg) => `<path fill="${fg}" d="M19.6 14.6A8.6 8.6 0 1 1 9.4 4.2a6.8 6.8 0 0 0 10.2 10.4z"/>`,
  // Gemini: light and speed
  prism: (fg, bg) =>
    `<path d="M.8 13.6 7 11.2" stroke="${fg}" stroke-width="1.6" stroke-linecap="round"/><path fill="${fg}" d="M10.2 3.2 17.4 17.8H3z"/><path d="M6.4 11.4 13.2 11" stroke="${bg}" stroke-width="1.2" stroke-linecap="round"/><path d="M14.4 10.8 23 7.4M14.6 11.6 23 11.4M14.8 12.4 23 15.4" stroke="${fg}" stroke-width="1.5" stroke-linecap="round"/>`,
  bolt: (fg) => `<path fill="${fg}" stroke="${fg}" stroke-width="1" stroke-linejoin="round" d="M14 1.8 4.8 13.6h6.4L9.6 22.2l9.6-12.6h-6.4z"/>`,
  seed: (fg) =>
    `<path d="M12 9.6V19.6" stroke="${fg}" stroke-width="1.6" stroke-linecap="round"/><ellipse cx="12" cy="20.4" rx="1.3" ry="1.9" fill="${fg}"/>` +
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
      .map((i) => {
        const [x, y] = pol(12, 9.6, 8.4, -170 + i * 20);
        return `<line x1="12" y1="9.6" x2="${x}" y2="${y}" stroke="${fg}" stroke-width="1.15" stroke-linecap="round"/><circle cx="${x}" cy="${y}" r="1.15" fill="${fg}"/>`;
      })
      .join("") +
    `<circle cx="12" cy="9.6" r="1.4" fill="${fg}"/>`,
  // Grok: The Hitchhiker's Guide to the Galaxy
  galaxy: (fg) => {
    const arm = "M12 8.4C16.4 8 19 10.8 18.6 14.4 18.2 18 14.4 20.6 9.6 19.8";
    return `<circle cx="12" cy="12" r="2.8" fill="${fg}"/><path d="${arm}" fill="none" stroke="${fg}" stroke-width="2.2" stroke-linecap="round"/><path d="${arm}" transform="rotate(180 12 12)" fill="none" stroke="${fg}" stroke-width="2.2" stroke-linecap="round"/><circle cx="20.6" cy="5" r="1" fill="${fg}"/><circle cx="3.6" cy="19.2" r=".8" fill="${fg}"/><circle cx="20.4" cy="19.8" r=".7" fill="${fg}"/>`;
  },
  rocket: (fg, bg) =>
    `<path fill="${fg}" d="M12 1.8c3 2.4 4.4 5.8 4.4 9.6v5.2H7.6v-5.2c0-3.8 1.4-7.2 4.4-9.6z"/><circle cx="12" cy="9.4" r="1.7" fill="${bg}"/><path fill="${fg}" d="M7.6 12.2 4.2 15.6v3.2l3.4-2.2zM16.4 12.2l3.4 3.4v3.2l-3.4-2.2z"/><path fill="${fg}" d="M9.8 17.6h4.4l-.6 2.2-1.6 2.6-1.6-2.6z" opacity=".75"/>`,
  fortytwo: (fg) =>
    `<path d="M8.8 3.8 2.6 14H11M8.8 3.8V20.4" fill="none" stroke="${fg}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.6 8C13.6 5.6 15.4 3.8 17.6 3.8S21.6 5.5 21.6 7.8C21.6 10.6 18.8 12.6 13.6 20.2H21.8" fill="none" stroke="${fg}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  // DeepSeek: the deep sea
  fluke: (fg) =>
    `<path fill="${fg}" d="M10.6 19.6C10.8 16 10.4 13.4 8.8 11.8 7 10.1 3.6 9.8 1.8 7 4.6 7.2 8 7.1 10.2 8.6c.9.6 1.5 1.4 1.8 2.2.3-.8.9-1.6 1.8-2.2C16 7.1 19.4 7.2 22.2 7c-1.8 2.8-5.2 3.1-7 4.8-1.6 1.6-2 4.2-1.8 7.8z"/><path d="M1.5 21c1.8-1.4 3.6-1.4 5.4 0s3.6 1.4 5.1 0 3.6-1.4 5.1 0 3.6 1.4 5.4 0" fill="none" stroke="${fg}" stroke-width="1.6" stroke-linecap="round"/>`,
  fish: (fg, bg) =>
    `<path fill="${fg}" d="M21.6 12C19 7.4 13.4 6.4 9 9.1L3.6 5.6 5.1 12l-1.5 6.4L9 14.9c4.4 2.7 10 1.7 12.6-2.9z"/><circle cx="17.4" cy="10.9" r="1.1" fill="${bg}"/><path d="M13.4 8.9c.9 1.9.9 4.3 0 6.2" fill="none" stroke="${bg}" stroke-width="1.1" stroke-linecap="round"/>`,
  // Mistral: the wind
  gale: (fg) =>
    `<path d="M9.8 5.2A2.4 2.4 0 1 1 11.5 9.3H2.2M12.4 18.8a2.4 2.4 0 1 0 1.7-4.1H2.2M17.6 7.8a2.9 2.9 0 1 1 2.1 4.9H2.2" fill="none" stroke="${fg}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`,
  sail: (fg) =>
    `<path d="M11.4 2.6V16.4" stroke="${fg}" stroke-width="1.5" stroke-linecap="round"/><path fill="${fg}" d="M12.6 3.4 20.4 15.4h-7.8zM10.2 6.4 4.4 15.4h5.8z"/><path fill="${fg}" d="M2.6 17.2h18.8l-2.6 3.8H5.2z"/>`,
  pinwheel: (fg, bg) =>
    `<path d="M12 11v11" stroke="${fg}" stroke-width="1.8" stroke-linecap="round"/>` +
    [0, 1, 2, 3].map((k) => `<path fill="${fg}" transform="rotate(${k * 90} 12 10.5)" d="M12 10.5V2.6c3.2 0 5.6 2.3 5.8 5.4z"/>`).join("") +
    `<circle cx="12" cy="10.5" r="1.3" fill="${bg}"/>`,
  // Qwen: One Thousand and One Nights
  lamp: (fg) =>
    `<path fill="${fg}" d="M4.8 15.2c0-2.8 3.2-4.3 7.2-4.3 2.9 0 5 1 6.1 2.2l4.1-2.6c-.4 2.6-1.7 4.6-3.9 5.8-1.3 1.4-3.4 2.1-6.3 2.1-4 0-7.2-1.1-7.2-3.2z"/><path d="M5.2 14c-2.8-.6-3.2-3.4-1.2-4" fill="none" stroke="${fg}" stroke-width="1.6" stroke-linecap="round"/><path fill="${fg}" d="M9.6 11c0-1.5 1.1-2.3 2.4-2.3s2.4.8 2.4 2.3z"/><circle cx="12" cy="7.6" r="1" fill="${fg}"/><rect x="8.6" y="18.6" width="6.8" height="2.1" rx=".8" fill="${fg}"/><path d="M22 8.6c-1.1-1.3.3-2.3-.6-3.8" fill="none" stroke="${fg}" stroke-width="1.2" stroke-linecap="round"/>`,
  carpet: (fg, bg) =>
    `<path fill="${fg}" d="M3.4 8.6c3-1.6 5.8 1.4 8.6 0s5.6-1.6 8.6 0v6.6c-3-1.6-5.8 1.4-8.6 0s-5.6-1.6-8.6 0z"/><path d="M12 9.6 14.2 12 12 14.4 9.8 12z" fill="${bg}"/><path d="M3.4 10.6h2.2M3.4 13.2h2.2M18.4 10.6h2.2M18.4 13.2h2.2" stroke="${bg}" stroke-width="1"/><path d="M3.4 9.2H1.6M3.4 11.2H1.6M3.4 13.2H1.6M3.4 15.2H1.6M20.6 9.2h1.8M20.6 11.2h1.8M20.6 13.2h1.8M20.6 15.2h1.8" stroke="${fg}" stroke-width="1" stroke-linecap="round"/><path d="M6 19.2h5M13.4 19.2h3" stroke="${fg}" stroke-width="1.4" stroke-linecap="round" opacity=".7"/>`,
  key: (fg) =>
    `<circle cx="7" cy="12" r="4" fill="none" stroke="${fg}" stroke-width="2.6"/><path d="M11 12h10.6M17.2 12v3.8M20.6 12v4.4" fill="none" stroke="${fg}" stroke-width="2.4" stroke-linecap="round"/>`,
  // Meta: the Muses
  flame: (fg, bg) =>
    `<path fill="${fg}" d="M12 2.4c1 3.8 5.6 5.6 5.6 11.2 0 3.9-2.6 7.1-5.6 7.1s-5.6-3.2-5.6-7.1c0-2.9 1.8-4.3 2.8-6.4.6 1.6 1.3 2.6 2.3 3 .3-2.6-.4-5.2.5-7.8z"/><path fill="${bg}" d="M12 12.2c.6 1.8 2.6 2.6 2.6 4.8 0 1.6-1.2 2.6-2.6 2.6s-2.6-1-2.6-2.6c0-1.4 1.2-2.2 2.6-4.8z"/>`,
  // Kimi: the moonshot
  lander: (fg, bg) =>
    `<path fill="${fg}" d="M8.6 3.6h6.8l2 3.6-2 3.6H8.6l-2-3.6z"/><circle cx="12" cy="7.2" r="1.5" fill="${bg}"/><rect x="6.6" y="11.6" width="10.8" height="3.6" rx=".6" fill="${fg}"/><path d="M7.6 15 4 20.4M16.4 15 20 20.4M12 15.2v5.2M2.6 20.6h3M18.4 20.6h3M10.6 20.6h2.8" stroke="${fg}" stroke-width="1.6" stroke-linecap="round"/>`,
  // A person at the board
  person: (fg) => `<circle cx="12" cy="8" r="4.2" fill="${fg}"/><path fill="${fg}" d="M3.8 21c0-4.8 3.7-7.4 8.2-7.4s8.2 2.6 8.2 7.4z"/>`,
};
