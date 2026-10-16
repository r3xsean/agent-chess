/**
 * Scrolls `el` into view inside the panel that scrolls it, and never the page: on a phone the
 * page scrolls too, and stepping through moves mustn't carry the board off screen.
 */
export function scrollIntoPanel(el: Element | null | undefined, block: "nearest" | "center", smooth: boolean) {
  if (!el) return;
  let box = el.parentElement;
  while (box && box !== document.body && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (!box || box === document.body) return;
  const r = el.getBoundingClientRect();
  const view = box.getBoundingClientRect();
  // Sticky tabs and footer inside the box cover its edges; its scroll-padding says by how much.
  const cs = getComputedStyle(box);
  const padTop = parseFloat(cs.scrollPaddingTop) || 0;
  const padBottom = parseFloat(cs.scrollPaddingBottom) || 0;
  const b = { top: view.top + padTop, bottom: view.bottom - padBottom, height: view.height - padTop - padBottom };
  let delta: number;
  if (block === "center") delta = r.top - b.top - (b.height - r.height) / 2;
  else if (r.top < b.top) delta = r.top - b.top;
  else if (r.bottom > b.bottom) delta = Math.min(r.bottom - b.bottom, r.top - b.top);
  else return;
  box.scrollTo({ top: box.scrollTop + delta, behavior: smooth ? "smooth" : "instant" });
}
