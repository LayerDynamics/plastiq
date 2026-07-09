// Read the rendered-object registry from a RECM store, plus a lifecycle hook
// (`useRegisterRecmObject`) that publishes a scene object into the store while
// its component is mounted and retracts it on unmount — how an r3f component
// tells the menu "I exist and can be acted on".

import { useEffect } from "react";
import type { RecmRenderedObject } from "../types.js";
import type { RecmStore } from "../store.js";

export interface RecmRenderedObjectsState {
  renderedObjects: RecmRenderedObject[];
  register: (object: RecmRenderedObject) => void;
  unregister: (id: string) => void;
}

export function useRecmRenderedObjects<TContext, TGroup extends string = string>(
  store: RecmStore<TContext, TGroup>,
): RecmRenderedObjectsState {
  const renderedObjects = store((state) => state.renderedObjects);
  const register = store((state) => state.registerRenderedObject);
  const unregister = store((state) => state.unregisterRenderedObject);
  return { renderedObjects, register, unregister };
}

/** Keep `object` registered in the store for the caller's lifetime (id-keyed,
 *  last-write-wins). Re-registers when the object's identity fields change. */
export function useRegisterRecmObject<TContext, TGroup extends string = string>(
  store: RecmStore<TContext, TGroup>,
  object: RecmRenderedObject,
): void {
  const register = store((state) => state.registerRenderedObject);
  const unregister = store((state) => state.unregisterRenderedObject);
  useEffect(() => {
    register(object);
    return () => unregister(object.id);
    // Identity fields only — `value` is opaque to the menu and excluded on purpose.
  }, [register, unregister, object, object.id, object.kind, object.label]);
}
