// Bill-of-materials sidebar section (M4): rolls up the LIVE interactive
// assembly (useCadStore.assembly) through the declarative `.assy` bridge
// (assemblyToAssy) and renders the existing, tested BomPanel. Mounted in the
// left sidebar directly under the ASSEMBLY section (App.tsx), and — matching
// AssemblyTree's per-section gating (Explode/Clearance/Mates show only when
// they have something to act on) — hidden for a bare part with no instances.

import { useCadStore } from "../store/store.js";
import { assemblyToAssy } from "../assembly/assy.js";
import { BomPanel } from "../assembly/BomPanel.js";

export function BomSection(): React.JSX.Element | null {
  const assembly = useCadStore((s) => s.assembly);
  if (assembly.instances.length === 0) return null;
  return (
    <div data-testid="bom-section" className="mt-3 border-t border-[#222a36] pt-2">
      <BomPanel doc={assemblyToAssy(assembly)} />
    </div>
  );
}
