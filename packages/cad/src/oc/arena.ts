// OCCT handle lifetime management (SPEC-4 Task 0.5 / R5 / C4).
//
// opencascade.js objects live on the Emscripten WASM heap and must be released
// with `.delete()` — JS GC does NOT free them. Leaking them grows the heap over
// a long editing session. `OcArena` tracks the temporaries created during one
// operation and frees them deterministically (LIFO) when the scope ends; the
// RESULT a caller wants to keep is simply not tracked (or is detached from the
// arena), so it survives.

/** Anything ocjs hands back: it owns WASM memory freed via `delete()`. */
export interface Deletable {
  delete(): void;
}

/** A scope that owns OCCT temporaries and frees them when closed. */
export class OcArena {
  private readonly tracked: Deletable[] = [];

  /** Register `obj` for deletion when the arena closes; returns it for chaining. */
  track<T extends Deletable>(obj: T): T {
    this.tracked.push(obj);
    return obj;
  }

  /** Number of live tracked handles (for leak assertions/tests). */
  get size(): number {
    return this.tracked.length;
  }

  /** Free everything tracked, in reverse creation order. Idempotent. */
  delete(): void {
    for (let i = this.tracked.length - 1; i >= 0; i--) {
      this.tracked[i]!.delete();
    }
    this.tracked.length = 0;
  }
}

/**
 * Run `fn` with a fresh arena and free all tracked temporaries afterwards, even
 * on throw. Anything returned must NOT be tracked (or must be detached) if it
 * should outlive the scope.
 */
export function withArena<T>(fn: (arena: OcArena) => T): T {
  const arena = new OcArena();
  try {
    return fn(arena);
  } finally {
    arena.delete();
  }
}
