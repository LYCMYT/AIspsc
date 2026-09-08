/** Make room in the current scroll container without reversing the menu direction. */
export function makeRoomBelow(anchor: HTMLElement, preferredHeight: number): () => void {
  const targetBottom = Math.max(64, window.innerHeight - Math.min(preferredHeight, window.innerHeight * 0.58) - 20);
  const scrollParents: HTMLElement[] = [];
  for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) scrollParents.push(parent);
  }
  const page = document.scrollingElement as HTMLElement;
  const scrollTowardsTarget = () => {
    for (const parent of [...scrollParents, page]) {
      const delta = anchor.getBoundingClientRect().bottom - targetBottom;
      if (delta <= 0) break;
      parent.scrollTop += delta;
    }
  };
  scrollTowardsTarget();
  let spacer: HTMLDivElement | undefined;
  if (window.innerHeight - anchor.getBoundingClientRect().bottom < 120) {
    spacer = document.createElement('div');
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.cssText = `height:${Math.min(preferredHeight, window.innerHeight * 0.58)}px;flex:none;pointer-events:none`;
    (scrollParents[0] ?? document.body).appendChild(spacer);
    scrollTowardsTarget();
  }
  return () => spacer?.remove();
}

export function downwardPosition(anchor: HTMLElement, preferredWidth: number, maxHeight: number) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(preferredWidth, window.innerWidth - 24);
  return {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    top: `${rect.bottom + 8}px`,
    maxHeight: `${Math.max(1, Math.min(maxHeight, window.innerHeight - rect.bottom - 20))}px`,
  };
}
