// Shared File → string readers for the AI panels (NeRF capture, image attach). FileReader-based;
// both reject (rather than hang) on read error or abort, so callers can surface a clear message.

/** Read a file's contents as text (e.g. a transforms.json). */
export function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("file read failed"));
    r.onabort = () => reject(new Error("file read aborted"));
    r.readAsText(file);
  });
}

/** Read a file as base64 (the data-URL payload, with the `data:<mime>;base64,` prefix stripped). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const comma = s.indexOf(",");
      if (comma < 0) {
        reject(new Error("unexpected FileReader result (not a base64 data URL)"));
        return;
      }
      resolve(s.slice(comma + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("file read failed"));
    r.onabort = () => reject(new Error("file read aborted"));
    r.readAsDataURL(file);
  });
}
