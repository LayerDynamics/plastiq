// Framework-agnostic DOM wiring. `attachRecmListeners` binds a target element's
// right-click to "open the menu here" and the standard dismiss gestures to
// "close", returning a disposer. It works on any HTMLElement — an r3f <Canvas>'s
// domElement, a plain <div>, etc. — so hosts don't reimplement this glue.
//
// Dismiss policy mirrors the CAD viewport's: a LEFT/MIDDLE pointer press
// elsewhere closes, but the RIGHT button (button 2) is the menu's own open
// gesture and must NOT close (otherwise the opening click dismisses the menu it
// just opened). Escape and window blur also close.

import type { RecmListenerHandlers, RecmListenerOptions } from "../types.js";

/** Attach open/close listeners to `target`. Returns a disposer that removes them
 *  all — call it on unmount. */
export function attachRecmListeners(
  target: HTMLElement,
  handlers: RecmListenerHandlers,
  options: RecmListenerOptions = {},
): () => void {
  const { preventDefault = true, closeOnBlur = true } = options;

  const onContextMenu = (event: MouseEvent): void => {
    if (preventDefault) event.preventDefault();
    const rect = target.getBoundingClientRect();
    handlers.onOpen({ x: event.clientX - rect.left, y: event.clientY - rect.top }, event);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 2) handlers.onClose?.();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") handlers.onClose?.();
  };

  const onBlur = (): void => handlers.onClose?.();

  const doc = target.ownerDocument;
  const view = doc.defaultView;
  target.addEventListener("contextmenu", onContextMenu);
  target.addEventListener("pointerdown", onPointerDown);
  doc.addEventListener("keydown", onKeyDown);
  if (closeOnBlur) view?.addEventListener("blur", onBlur);

  return () => {
    target.removeEventListener("contextmenu", onContextMenu);
    target.removeEventListener("pointerdown", onPointerDown);
    doc.removeEventListener("keydown", onKeyDown);
    if (closeOnBlur) view?.removeEventListener("blur", onBlur);
  };
}
