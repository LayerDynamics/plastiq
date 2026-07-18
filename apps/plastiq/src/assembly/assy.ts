// M4 — declarative `.assy` assembly description + auto-BOM (partcad-inspired concept; our own,
// dependency-free schema). A human or the AI agent writes a small JSON document laying out placed
// parts (and nested sub-assemblies); `realizeAssembly` turns it into the interactive AssemblyModel,
// and `deriveBOM` rolls up a bill of materials. Pure + deterministic. See docs/adr/0004.
//
// §2.11.3: the document also carries the CONSTRAINT graph, not just placements — per-link `fixed`
// (the ground flag), `mates`, and `joints`, so an export→import round-trip preserves the whole
// assembly instead of silently destroying its mates/joints and leaving nothing grounded (which made
// every imported assembly free-fall at Simulate). Mates/joints reference instances by their index
// in the FLATTENED instance list, in document (depth-first) order — for a flat document, simply the
// link index. If no link declares `fixed`, realizeAssembly grounds the FIRST instance, matching the
// editor's addInstance convention (the first instance anchors as the assembly's ground).
//
// Honest scope: Plastiq has no multi-part library yet, so `part` is a NAME — instances carry it for
// the BOM/display; binding a name to distinct geometry is a future multi-part-library milestone.

import type { JointKind } from "@plastiq/cad";
import {
  axisAngleQuat,
  emptyAssembly,
  IDENTITY_POSE,
  quatMul,
  quatRotate,
  type AssemblyJoint,
  type AssemblyMate,
  type AssemblyMateRef,
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

/** One placed occurrence. `part` names a leaf part OR a key in `subAssemblies` (recursive).
 * `fixed` grounds the instance(s) this link expands to (a fixed sub-assembly link anchors
 * every instance under it). */
export interface AssyLink {
  part: string;
  location?: AssyLocation;
  name?: string;
  fixed?: boolean;
}

export interface AssyNode {
  name?: string;
  links: AssyLink[];
}

/** A mate endpoint: a flattened-instance index + optional local point/direction (from a pick). */
export interface AssyMateRef {
  instance: number;
  point?: Vec3;
  dir?: Vec3;
}

/** One assembly mate. `value` is required for the valued kinds (distance: metres, angle: radians). */
export interface AssyMate {
  kind: AssemblyMate["kind"];
  a: AssyMateRef;
  b: AssyMateRef;
  value?: number;
}

/** One articulated joint: parent/child flattened-instance indexes + a world frame. */
export interface AssyJoint {
  kind: JointKind;
  parent: number;
  child: number;
  origin: Vec3;
  axis: Vec3;
  limits?: { lower?: number; upper?: number };
}

/** A declarative assembly document. */
export interface AssyDoc extends AssyNode {
  subAssemblies?: Record<string, AssyNode>;
  mates?: AssyMate[];
  joints?: AssyJoint[];
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
  if (l.fixed !== undefined) {
    if (typeof l.fixed !== "boolean") throw new Error(`assy: link ${i} \`fixed\` must be a boolean`);
    link.fixed = l.fixed;
  }
  return link;
}

const MATE_KINDS: ReadonlySet<string> = new Set([
  "coincident",
  "distance",
  "parallel",
  "perpendicular",
  "angle",
  "concentric",
]);
const JOINT_KINDS: ReadonlySet<string> = new Set([
  "revolute",
  "prismatic",
  "cylindrical",
  "fixed",
  "ball",
  "planar",
]);

function parseInstanceIndex(raw: unknown, where: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`assy: ${where} must be a non-negative integer instance index`);
  }
  return raw;
}

function parseMateRef(raw: unknown, where: string): AssyMateRef {
  if (typeof raw !== "object" || raw === null) throw new Error(`assy: ${where} must be an object`);
  const r = raw as Record<string, unknown>;
  const ref: AssyMateRef = { instance: parseInstanceIndex(r.instance, `${where}.instance`) };
  if (r.point !== undefined) {
    if (!isVec3(r.point)) throw new Error(`assy: ${where}.point must be [x,y,z]`);
    ref.point = [...r.point] as Vec3;
  }
  if (r.dir !== undefined) {
    if (!isVec3(r.dir)) throw new Error(`assy: ${where}.dir must be [x,y,z]`);
    ref.dir = [...r.dir] as Vec3;
  }
  return ref;
}

function parseMate(raw: unknown, i: number): AssyMate {
  if (typeof raw !== "object" || raw === null) throw new Error(`assy: mate ${i} must be an object`);
  const m = raw as Record<string, unknown>;
  if (typeof m.kind !== "string" || !MATE_KINDS.has(m.kind)) {
    throw new Error(`assy: mate ${i} kind must be one of ${[...MATE_KINDS].join("/")}`);
  }
  const kind = m.kind as AssyMate["kind"];
  const mate: AssyMate = {
    kind,
    a: parseMateRef(m.a, `mate ${i} \`a\``),
    b: parseMateRef(m.b, `mate ${i} \`b\``),
  };
  if (kind === "distance" || kind === "angle") {
    if (typeof m.value !== "number" || !Number.isFinite(m.value)) {
      throw new Error(`assy: mate ${i} (${kind}) requires a finite numeric \`value\``);
    }
    mate.value = m.value;
  }
  return mate;
}

function parseJoint(raw: unknown, i: number): AssyJoint {
  if (typeof raw !== "object" || raw === null) throw new Error(`assy: joint ${i} must be an object`);
  const j = raw as Record<string, unknown>;
  if (typeof j.kind !== "string" || !JOINT_KINDS.has(j.kind)) {
    throw new Error(`assy: joint ${i} kind must be one of ${[...JOINT_KINDS].join("/")}`);
  }
  if (!isVec3(j.origin)) throw new Error(`assy: joint ${i} requires an \`origin\` [x,y,z]`);
  if (!isVec3(j.axis)) throw new Error(`assy: joint ${i} requires an \`axis\` [x,y,z]`);
  if (Math.hypot(j.axis[0], j.axis[1], j.axis[2]) === 0) {
    throw new Error(`assy: joint ${i} \`axis\` must be non-zero`);
  }
  const joint: AssyJoint = {
    kind: j.kind as JointKind,
    parent: parseInstanceIndex(j.parent, `joint ${i} \`parent\``),
    child: parseInstanceIndex(j.child, `joint ${i} \`child\``),
    origin: [...j.origin] as Vec3,
    axis: [...j.axis] as Vec3,
  };
  if (j.limits !== undefined) {
    if (typeof j.limits !== "object" || j.limits === null) throw new Error(`assy: joint ${i} \`limits\` must be an object`);
    const l = j.limits as Record<string, unknown>;
    const limits: { lower?: number; upper?: number } = {};
    if (l.lower !== undefined) {
      if (typeof l.lower !== "number" || !Number.isFinite(l.lower)) throw new Error(`assy: joint ${i} limits.lower must be a number`);
      limits.lower = l.lower;
    }
    if (l.upper !== undefined) {
      if (typeof l.upper !== "number" || !Number.isFinite(l.upper)) throw new Error(`assy: joint ${i} limits.upper must be a number`);
      limits.upper = l.upper;
    }
    joint.limits = limits;
  }
  return joint;
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
  const mates = (input as Record<string, unknown>).mates;
  if (mates !== undefined) {
    if (!Array.isArray(mates)) throw new Error("assy: `mates` must be an array");
    doc.mates = mates.map(parseMate);
  }
  const joints = (input as Record<string, unknown>).joints;
  if (joints !== undefined) {
    if (!Array.isArray(joints)) throw new Error("assy: `joints` must be an array");
    doc.joints = joints.map(parseJoint);
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
 * placements compose with their children's. Cycle-guarded; deterministic instance ids. A link's
 * `fixed` grounds every instance it expands to; the document's mates/joints (flattened-instance
 * indexes) realize into the model's id-based mates/joints. If NO link declares `fixed`, the FIRST
 * instance is grounded — matching the editor's addInstance convention — so an imported assembly
 * simulates anchored instead of free-falling wholesale (§2.11.3). */
export function realizeAssembly(doc: AssyDoc): AssemblyModel {
  const model = emptyAssembly();
  const subs = doc.subAssemblies ?? {};
  let counter = 0;
  const expand = (
    node: AssyNode,
    parentPose: InstancePose,
    seen: ReadonlySet<string>,
    inheritedFixed: boolean,
  ): void => {
    for (const link of node.links) {
      const pose = composePoses(parentPose, locationToPose(link.location));
      const fixed = inheritedFixed || link.fixed === true;
      const sub = subs[link.part];
      if (sub && !seen.has(link.part)) {
        expand(sub, pose, new Set([...seen, link.part]), fixed);
      } else {
        const instance: ComponentInstance = { id: `inst-${counter++}`, name: link.name ?? link.part, part: link.part, pose };
        if (fixed) instance.fixed = true;
        model.instances.push(instance);
      }
    }
  };
  expand(doc, IDENTITY_POSE, new Set(), false);

  // Realize the constraint graph: flattened-instance indexes → the minted ids.
  // Bounds are validated HERE (not at parse) because only the expanded document
  // knows the final instance count. Defense-in-depth (valued-mate value, kind
  // checks) also guards hand-built docs that bypass parseAssy.
  const idOf = (index: number, where: string): string => {
    const inst = model.instances[index];
    if (!inst) {
      throw new Error(`assy: ${where} references instance ${index} but the document realizes only ${model.instances.length} instance(s)`);
    }
    return inst.id;
  };
  const realizeRef = (r: AssyMateRef, where: string): AssemblyMateRef => {
    const ref: AssemblyMateRef = { instance: idOf(r.instance, where) };
    if (r.point) ref.point = [...r.point] as Vec3;
    if (r.dir) ref.dir = [...r.dir] as Vec3;
    return ref;
  };
  (doc.mates ?? []).forEach((m, n) => {
    const where = `mate ${n}`;
    const a = realizeRef(m.a, where);
    const b = realizeRef(m.b, where);
    const id = `mate-${n}`;
    if (m.kind === "distance" || m.kind === "angle") {
      if (typeof m.value !== "number" || !Number.isFinite(m.value)) {
        throw new Error(`assy: ${where} (${m.kind}) requires a finite numeric \`value\``);
      }
      model.mates.push({ id, kind: m.kind, a, b, value: m.value });
    } else {
      model.mates.push({ id, kind: m.kind, a, b });
    }
  });
  (doc.joints ?? []).forEach((j, n) => {
    const where = `joint ${n}`;
    const joint: AssemblyJoint = {
      id: `joint-${n}`,
      kind: j.kind,
      parent: idOf(j.parent, `${where} \`parent\``),
      child: idOf(j.child, `${where} \`child\``),
      origin: [...j.origin] as Vec3,
      axis: [...j.axis] as Vec3,
    };
    if (j.limits) joint.limits = { ...j.limits };
    model.joints.push(joint);
  });

  // Ground fallback: an assembly with nothing fixed free-falls wholesale at
  // Simulate. addInstance anchors the first instance; imports do the same.
  if (model.instances.length > 0 && !model.instances.some((i) => i.fixed)) {
    model.instances[0]!.fixed = true;
  }
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
 * realizeAssembly). Sub-assembly structure is not recovered — a flat link list is emitted — but the
 * CONSTRAINT graph is complete (§2.11.3): per-link `fixed` flags plus `mates`/`joints` with instance
 * ids mapped to link indexes. A mate/joint referencing an instance the model does not contain is a
 * store bug; it throws (named by mate/joint id) rather than silently emitting a broken document. */
export function assemblyToAssy(model: AssemblyModel): AssyDoc {
  const indexById = new Map(model.instances.map((inst, i) => [inst.id, i]));
  const indexOf = (id: string, where: string): number => {
    const i = indexById.get(id);
    if (i === undefined) throw new Error(`assy: ${where} references unknown instance "${id}"`);
    return i;
  };
  const toAssyRef = (r: AssemblyMateRef, where: string): AssyMateRef => {
    const ref: AssyMateRef = { instance: indexOf(r.instance, where) };
    if (r.point) ref.point = [...r.point] as Vec3;
    if (r.dir) ref.dir = [...r.dir] as Vec3;
    return ref;
  };
  const doc: AssyDoc = {
    links: model.instances.map((i) => {
      const part = i.part ?? i.name;
      const link: AssyLink = { part };
      if (i.name !== part) link.name = i.name;
      if (i.fixed) link.fixed = true;
      const loc = poseToLocation(i.pose);
      if (loc) link.location = loc;
      return link;
    }),
  };
  if (model.mates.length > 0) {
    doc.mates = model.mates.map((m) => {
      const where = `mate "${m.id}"`;
      const mate: AssyMate = { kind: m.kind, a: toAssyRef(m.a, where), b: toAssyRef(m.b, where) };
      if (m.kind === "distance" || m.kind === "angle") mate.value = m.value;
      return mate;
    });
  }
  if (model.joints.length > 0) {
    doc.joints = model.joints.map((j) => {
      const where = `joint "${j.id}"`;
      const joint: AssyJoint = {
        kind: j.kind,
        parent: indexOf(j.parent, `${where} parent`),
        child: indexOf(j.child, `${where} child`),
        origin: [...j.origin] as Vec3,
        axis: [...j.axis] as Vec3,
      };
      if (j.limits) joint.limits = { ...j.limits };
      return joint;
    });
  }
  return doc;
}
