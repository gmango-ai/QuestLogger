// SPIKE ONLY — minimal Y.Text <-> <textarea> two-way binding.
//
// This is the headline of the spike: two people typing in the SAME sticky at the
// same time must BOTH land (character-level merge), not last-write-wins. Y.Text
// gives that; this binds it to a plain textarea with a common-prefix/suffix diff.
// Caret preservation is crude (fine for a spike; the real build would use a
// maintained binding like y-textarea).
export function bindTextarea(ytext, el) {
  let applyingRemote = false;

  const fromY = () => {
    const next = ytext.toString();
    if (el.value === next) return;
    const start = el.selectionStart;
    const before = el.value;
    applyingRemote = true;
    el.value = next;
    applyingRemote = false;
    // best-effort caret: shift by the length delta if the edit was before us.
    const delta = next.length - before.length;
    const caret = start > 0 ? Math.max(0, start + delta) : start;
    try { el.setSelectionRange(caret, caret); } catch { /* not focused */ }
  };
  ytext.observe(fromY);

  const toY = () => {
    if (applyingRemote) return;
    const oldStr = ytext.toString();
    const newStr = el.value;
    if (oldStr === newStr) return;
    let p = 0;
    const max = Math.min(oldStr.length, newStr.length);
    while (p < max && oldStr[p] === newStr[p]) p += 1;
    let s = 0;
    while (s < max - p && oldStr[oldStr.length - 1 - s] === newStr[newStr.length - 1 - s]) s += 1;
    const delLen = oldStr.length - p - s;
    const insStr = newStr.slice(p, newStr.length - s);
    ytext.doc.transact(() => {
      if (delLen > 0) ytext.delete(p, delLen);
      if (insStr) ytext.insert(p, insStr);
    });
  };
  el.addEventListener("input", toY);

  el.value = ytext.toString();
  return () => {
    ytext.unobserve(fromY);
    el.removeEventListener("input", toY);
  };
}
