// M4 — bill-of-materials panel. Renders the rolled-up BOM derived from a declarative `.assy`
// document (docs/adr/0004). Presentational + pure: it just calls deriveBOM and lists the parts.

import { deriveBOM, type AssyDoc } from "./assy.js";

export function BomPanel({ doc }: { doc: AssyDoc }) {
  const bom = deriveBOM(doc);
  const total = bom.reduce((sum, e) => sum + e.count, 0);
  return (
    <div data-testid="bom-panel" className="space-y-1 text-xs text-[#9ab]">
      <div className="font-medium text-[#bcd]">Bill of Materials</div>
      {bom.length === 0 ? (
        <div data-testid="bom-empty" className="italic text-[#678]">
          No parts
        </div>
      ) : (
        <table className="w-full">
          <tbody>
            {bom.map((e) => (
              <tr key={e.part} data-testid={`bom-row-${e.part}`}>
                <td className="py-0.5">{e.part}</td>
                <td className="py-0.5 text-right tabular-nums text-[#bcd]">×{e.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div data-testid="bom-total" className="border-t border-[#234] pt-1 text-[#678]">
        {total} part{total === 1 ? "" : "s"} total
      </div>
    </div>
  );
}
