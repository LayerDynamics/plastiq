// Normalizing OCCT/WASM throws into readable messages.
//
// OCCT raises C++ `Standard_Failure` exceptions (a tight fillet radius, a
// revolve profile crossing its axis, a sweep spine the kernel can't resolve —
// all reachable in normal editing). The module is linked with `-fexceptions`,
// so an exception that unwinds out of an UNBOUND OCCT call reaches JS as the
// raw C++ exception POINTER: a plain JavaScript `number`, not an `Error`.
//
// That is why callers doing `(err as Error).message` render "rebuild failed:
// undefined" (the pointer has no `.message`) or "rebuild failed: 5286968" (the
// pointer stringified). Neither tells the user anything.
//
// LIMITATION — reading OCCT's own message text is still not possible, and the
// expected fix was TRIED AND DISPROVEN (2026-07-18):
//
//   `Standard_Failure` is now BOUND (it is listed in `occt.build.yml` and the
//   rebuilt wasm exposes it as a constructible class). That was predicted to let
//   this module call `GetMessageString()` on the caught value. Measured: it does
//   NOT. An OCCT throw still unwinds to JS as a raw C++ exception POINTER (a
//   plain number) — it is not an embind-wrapped Standard_Failure,
//   `instanceof oc.Standard_Failure` is false, and the module exports no
//   `___cxa_begin_catch` to adjust the pointer with. Binding a class makes it
//   CONSTRUCTIBLE; it does not change how a C++ throw crosses into JS.
//   Pinned by `oc/bindings.test.ts` so this is not attempted a third time.
//
// The one remaining route is Emscripten's `getExceptionMessage` helper, which
// needs `-sEXPORT_EXCEPTION_HANDLING_HELPERS`; `occt.build.yml` documents that
// overriding `emccFlags` REPLACES the builder's known-good defaults and yields
// an unlinkable wasm, so that is a build-system change, not a symbol addition.
// Until then this reports the failure HONESTLY — naming it as a kernel-level
// rejection — instead of leaking a pointer or `undefined`.

/**
 * A human-readable description of any value thrown by a kernel call.
 *
 * Handles the three shapes that actually occur:
 *  - `Error` — everything the kernel throws itself (already has a message).
 *  - `number` — a C++ `Standard_Failure` pointer unwound out of OCCT.
 *  - anything else — stringified defensively.
 *
 * Never throws, so it is safe on an error path.
 */
export function describeOcctError(err: unknown): string {
  if (err instanceof Error && typeof err.message === "string" && err.message.length > 0) {
    return err.message;
  }
  if (typeof err === "number") {
    // A raw Standard_Failure pointer. The numeric value is meaningless to a user
    // (and unstable across runs), so it is deliberately NOT shown.
    return "the geometry kernel rejected this operation (OCCT Standard_Failure) — the parameters are likely outside what the local geometry can absorb";
  }
  if (typeof err === "string" && err.length > 0) return err;
  if (err && typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  return "unknown geometry kernel failure";
}

/** True when `err` is a raw OCCT `Standard_Failure` rather than a kernel Error. */
export function isRawOcctFailure(err: unknown): boolean {
  return typeof err === "number";
}
