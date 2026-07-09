// SPEC-11 N11.3 (11-M3) — pair selected image files to transforms.json frames by FILENAME,
// not by picker order.
//
// The nerf service pairs images[i] ↔ frames[i] positionally, and the panel submits the
// browser's FileList order — so if the OS file picker returns the images in a different order
// than the frames, poses are silently misassigned (a plausibly-shaped but WRONG capture). This
// module is the pure, tested core: it parses transforms.json, enforces the count invariant, and
// reorders the selected images into FRAME order by matching each frame's file_path basename
// (case-insensitive, extension-tolerant). A missing or ambiguous match is a clear error — never
// a silent misassignment. When the transforms file carries no per-frame file paths, positional
// pairing is preserved but flagged (matched:false + a note) so the caller can tell the user.

/** A selected image: its filename (to match a frame's file_path) + the base64 payload
 * submitted to /train. */
export interface NamedImage {
  name: string;
  data: string;
}

export type FramePairing =
  | { ok: true; order: NamedImage[]; matched: boolean; note?: string }
  | { ok: false; error: string };

/** Strip any directory prefix (POSIX or Windows separators) from a path. */
function basename(p: string): string {
  const s = p.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** The lower-cased filename without its extension (extension-tolerant matching key). */
function stem(name: string): string {
  const b = basename(name).toLowerCase();
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(0, dot) : b;
}

function push(map: Map<string, NamedImage[]>, key: string, img: NamedImage): void {
  const arr = map.get(key);
  if (arr) arr.push(img);
  else map.set(key, [img]);
}

/** Pair images to transforms frames by filename. Parses transforms.json, enforces the count
 * invariant, then:
 *   • every frame has a file_path ⇒ reorder images into FRAME order, matching by basename
 *     (case-insensitive) and falling back to the extension-less stem; a missing or ambiguous
 *     match is a clear error (never a silent misassignment).
 *   • no frame has a file_path ⇒ positional pairing preserved, flagged matched:false with a
 *     note the caller surfaces, so the user knows order came from their selection.
 *   • some-but-not-all frames have a file_path ⇒ error (can't pair reliably). */
export function pairImagesToFrames(images: NamedImage[], transformsJson: string): FramePairing {
  let frames: unknown;
  try {
    frames = (JSON.parse(transformsJson) as { frames?: unknown }).frames;
  } catch {
    return { ok: false, error: "transforms.json is not valid JSON." };
  }
  if (!Array.isArray(frames)) {
    return { ok: false, error: "transforms.json has no 'frames' array." };
  }
  if (frames.length !== images.length) {
    return { ok: false, error: `Image count (${images.length}) must match transforms frames (${frames.length}).` };
  }

  const paths = frames.map((f) =>
    f && typeof (f as { file_path?: unknown }).file_path === "string" ? (f as { file_path: string }).file_path : null,
  );
  const named = paths.filter((p): p is string => p !== null);
  if (named.length === 0) {
    // No per-frame filenames — positional pairing is all we can do; tell the user.
    return {
      ok: true,
      order: images,
      matched: false,
      note: "transforms.json has no per-frame file paths — pairing images in selection order.",
    };
  }
  if (named.length !== paths.length) {
    return {
      ok: false,
      error: "Some transforms frames are missing 'file_path' — can't pair images by filename reliably.",
    };
  }

  // Index images by full basename and by extension-less stem (both lower-cased). Collisions are
  // tracked so an ambiguous frame filename fails loudly instead of grabbing an arbitrary image.
  const byBasename = new Map<string, NamedImage[]>();
  const byStem = new Map<string, NamedImage[]>();
  for (const img of images) {
    push(byBasename, basename(img.name).toLowerCase(), img);
    push(byStem, stem(img.name), img);
  }

  const order: NamedImage[] = [];
  const used = new Set<NamedImage>();
  for (const p of paths as string[]) {
    const label = basename(p);
    const exact = byBasename.get(label.toLowerCase()) ?? [];
    let match: NamedImage | undefined;
    if (exact.length === 1) {
      match = exact[0];
    } else if (exact.length === 0) {
      const byStemMatch = byStem.get(stem(p)) ?? [];
      if (byStemMatch.length === 1) match = byStemMatch[0];
      else if (byStemMatch.length === 0) return { ok: false, error: `No selected image matches frame "${label}".` };
      else return { ok: false, error: `Multiple selected images match frame "${label}" — rename to disambiguate.` };
    } else {
      return { ok: false, error: `Multiple selected images match frame "${label}" — rename to disambiguate.` };
    }
    if (used.has(match!)) {
      return {
        ok: false,
        error: `Selected image "${match!.name}" matches more than one frame — check for duplicate filenames.`,
      };
    }
    used.add(match!);
    order.push(match!);
  }
  return { ok: true, order, matched: true };
}
