// M4 — declarative `.assy` assembly description + auto-BOM (partcad-inspired concept; our own,
// dependency-free schema). A human or the AI agent writes a small JSON document laying out placed
// parts (and nested sub-assemblies); `realizeAssembly` turns it into the interactive AssemblyModel,
// and `deriveBOM` rolls up a bill of materials. Pure + deterministic. See docs/adr/0004.
//
// Honest scope: Plastiq has no multi-part library yet, so `part` is a NAME — instances carry it for
// the BOM/display; binding a name to distinct geometry is a future multi-part-library milestone.

import {
  axisAngleQuat,
  emptyAssembly,
  IDENTITY_POSE,
  quatMul,
  quatRotate,
  type AssemblyModel,
  type ComponentInstance,
  type InstancePose,
  type Quat,
  type Vec3,
} from "./model.js";

/** A rigid placement: a translation and/or an axis-angle (degrees) rotation. */
export interface AssyLocation {
  position?: Vec3;
  axis?: Vec3;
  angle?: number;
}

/** One placed occurrence. `part` names a leaf part OR a key in `subAssemblies` (recursive). */
export interface AssyLink {
  part: string;
  location?: AssyLocation;
  name?: string;
}

export interface AssyNode {
  name?: string;
  links: AssyLink[];
}

/** A declarative assembly document. */
export interface AssyDoc extends AssyNode {
  subAssemblies?: Record<string, AssyNode>;
}

/** One bill-of-materials line: a part and how many times it occurs (rolled up). */
export interface BomEntry {
  part: string;
  count: number;
}

// ── parsing / validation ─────────────────────────────────────────────────────

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

function parseLocation(raw: unknown, where: string): AssyLocation {
  if (typeof raw !== "object" || raw === null) throw new Error(`assy: ${where} location must be an object`);
  const l = raw as Record<string, unknown>;
  const loc: AssyLocation = {};
  if (l.position !== undefined) {
    if (!isVec3(l.position)) throw new Error(`assy: ${where} location.position must be [x,y,z]`);
    loc.position = [...l.position] as Vec3;
  }
  if (l.axis !== undefined) {
    if (!isVec3(l.axis)) throw new Error(`assy: ${where} location.axis must be [x,y,z]`);
    loc.axis = [...l.axis] as Vec3;
  }
  if (l.angle !== undefined) {
    if (typeof l.angle !== "number" || !Number.isFinite(l.angle)) throw new Error(`assy: ${where} location.angle must be a number`);
    loc.angle = l.angle;
  }
  return loc;
}

function parseLink(raw: unknown, i: number): AssyLink {
  if (typeof raw !== "object" || raw === null) throw new Error(`assy: link ${i} must be an object`);
  const l = raw as Record<string, unknown>;
  if (typeof l.part !== "string" || l.part.length === 0) throw new Error(`assy: link ${i} requires a non-empty string \`part\``);
  const link: AssyLink = { part: l.part };
  if (typeof l.name === "string") link.name = l.name;
  if (l.location !== undefined) link.location = parseLocation(l.location, `link ${i}`);
  return link;
}

function parseNode(raw: unknown, where: string): AssyNode {
  if (typeof raw !== "object" || raw === null) throw new Error(`assy: ${where} must be an object`);
  const n = raw as Record<string, unknown>;
  if (!Array.isArray(n.links)) throw new Error(`assy: ${where} requires a \`links\` array`);
  const node: AssyNode = { links: n.links.map(parseLink) };
  if (typeof n.name === "string") node.name = n.name;
  return node;
}

/** Reject sub-assembly reference cycles (a `subAssemblies` entry reaching itself through
 * `links`): a cyclic document can never be realized as written, so it is a validation
 * error, named by its path (e.g. "a -> b -> a"). Depth-first over the reference graph;
 * `done` marks fully-explored keys so shared (diamond) references stay legal.
 * realizeAssembly/deriveBOM keep their own guards as defense-in-depth for hand-built
 * (unparsed) docs. */
function assertAcyclic(subs: Record<string, AssyNode>): void {
  const done = new Set<string>();
  const visit = (key: string, path: string[]): void => {
    if (done.has(key)) return;
    const at = path.indexOf(key);
    if (at >= 0) throw new Error(`assy: sub-assembly cycle: ${[...path.slice(at), key].join(" -> ")}`);
    const next = [...path, key];
    for (const link of subs[key]!.links) if (subs[link.part]) visit(link.part, next);
    done.add(key);
  };
  for (const key of Object.keys(subs)) visit(key, []);
}

/** Validate an untrusted value (e.g. parsed JSON or AI-authored data) into an AssyDoc. Throws with
 * a descriptive message on the first problem — including a sub-assembly reference cycle, which
 * could otherwise never realize as written. */
export function parseAssy(input: unknown): AssyDoc {
  const node = parseNode(input, "document");
  const doc: AssyDoc = { links: node.links };
  if (node.name !== undefined) doc.name = node.name;
  const subs = (input as Record<string, unknown>).subAssemblies;
  if (subs !== undefined) {
    if (typeof subs !== "object" || subs === null) throw new Error("assy: `subAssemblies` must be an object");
    const out: Record<string, AssyNode> = {};
    for (const [key, value] of Object.entries(subs)) out[key] = parseNode(value, `subAssembly "${key}"`);
    assertAcyclic(out);
    doc.subAssemblies = out;
  }
  return doc;
}

// ── pose math ────────────────────────────────────────────────────────────────

function locationToPose(loc?: AssyLocation): InstancePose {
  const position: Vec3 = loc?.position ? [...loc.position] : [0, 0, 0];
  const orientation: Quat =
    loc?.axis && typeof loc.angle === "number" ? axisAngleQuat(loc.axis, (loc.angle * Math.PI) / 180) : [0, 0, 0, 1];
  return { position, orientation };
}

/** Compose a parent placement with a child placement: child expressed in the parent's frame. */
function composePoses(parent: InstancePose, child: InstancePose): InstancePose {
  const r = quatRotate(parent.orientation, child.position);
  return {
    position: [parent.position[0] + r[0], parent.position[1] + r[1], parent.position[2] + r[2]],
    orientation: quatMul(parent.orientation, child.orientation),
  };
}

function poseToLocation(pose: InstancePose): AssyLocation | undefined {
  const [px, py, pz] = pose.position;
  const [qx, qy, qz, qw] = pose.orientation;
  const identityPos = px === 0 && py === 0 && pz === 0;
  const identityRot = qx === 0 && qy === 0 && qz === 0 && qw === 1;
  if (identityPos && identityRot) return undefined;
  const loc: AssyLocation = {};
  if (!identityPos) loc.position = [px, py, pz];
  if (!identityRot) {
    const angle = 2 * Math.acos(Math.min(1, Math.max(-1, qw)));
    const s = Math.sqrt(Math.max(0, 1 - qw * qw));
    loc.axis = s < 1e-9 ? [0, 0, 1] : [qx / s, qy / s, qz / s];
    loc.angle = (angle * 180) / Math.PI;
  }
  return loc;
}

// ── realize / BOM / export ───────────────────────────────────────────────────

/** Flatten a (possibly nested) `.assy` document into the interactive AssemblyModel. Sub-assembly
 * placements compose with their children's. Cycle-guarded; deterministic instance ids. */
export function realizeAssembly(doc: AssyDoc): AssemblyModel {
  const model = emptyAssembly();
  const subs = doc.subAssemblies ?? {};
  let counter = 0;
  const expand = (node: AssyNode, parentPose: InstancePose, seen: ReadonlySet<string>): void => {
    for (const link of node.links) {
      const pose = composePoses(parentPose, locationToPose(link.location));
      const sub = subs[link.part];
      if (sub && !seen.has(link.part)) {
        expand(sub, pose, new Set([...seen, link.part]));
      } else {
        const instance: ComponentInstance = { id: `inst-${counter++}`, name: link.name ?? link.part, part: link.part, pose };
        model.instances.push(instance);
      }
    }
  };
  expand(doc, IDENTITY_POSE, new Set());
  return model;
}

/** Roll up a bill of materials: leaf-part occurrence counts (sub-assemblies expanded), sorted by part. */
export function deriveBOM(doc: AssyDoc): BomEntry[] {
  const counts = new Map<string, number>();
  const subs = doc.subAssemblies ?? {};
  const walk = (node: AssyNode, seen: ReadonlySet<string>): void => {
    for (const link of node.links) {
      const sub = subs[link.part];
      if (sub && !seen.has(link.part)) walk(sub, new Set([...seen, link.part]));
      else counts.set(link.part, (counts.get(link.part) ?? 0) + 1);
    }
  };
  walk(doc, new Set());
  return [...counts.entries()]
    .map(([part, count]) => ({ part, count }))
    .sort((a, b) => a.part.localeCompare(b.part));
}

/** Export an interactively-built AssemblyModel to a flat `.assy` document (round-trips through
 * realizeAssembly). Sub-assembly structure is not recovered — a flat link list is emitted. */
export function assemblyToAssy(model: AssemblyModel): AssyDoc {
  return {
    links: model.instances.map((i) => {
      const part = i.part ?? i.name;
      const link: AssyLink = { part };
      if (i.name !== part) link.name = i.name;
      const loc = poseToLocation(i.pose);
      if (loc) link.location = loc;
      return link;
    }),
  };
}
