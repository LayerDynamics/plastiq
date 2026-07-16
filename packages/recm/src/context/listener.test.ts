// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { attachRecmListeners } from "./listener.js";

describe("attachRecmListeners", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    document.body.innerHTML = "";
  });

  function setup(options?: Parameters<typeof attachRecmListeners>[2]) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const onOpen = vi.fn();
    const onClose = vi.fn();
    dispose = attachRecmListeners(target, { onOpen, onClose }, options);
    return { target, onOpen, onClose };
  }

  it("opens on contextmenu at the target-relative position and prevents the native menu", () => {
    const { target, onOpen } = setup();
    const event = new MouseEvent("contextmenu", { clientX: 30, clientY: 40, cancelable: true, bubbles: true });
    target.dispatchEvent(event);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]).toEqual({ x: 30, y: 40 });
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes on a left/middle pointer press but NOT on the right button", () => {
    const { target, onClose } = setup();
    target.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new MouseEvent("pointerdown", { button: 2, bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1); // unchanged — right button is the open gesture
  });

  it("closes on Escape and on window blur, and stops after dispose", () => {
    const { onClose } = setup();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.dispatchEvent(new Event("blur"));
    expect(onClose).toHaveBeenCalledTimes(2);

    dispose?.();
    dispose = null;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(2); // no more calls after removal
  });

  it("respects preventDefault:false and closeOnBlur:false", () => {
    const { target, onClose } = setup({ preventDefault: false, closeOnBlur: false });
    const event = new MouseEvent("contextmenu", { cancelable: true, bubbles: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    window.dispatchEvent(new Event("blur"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
