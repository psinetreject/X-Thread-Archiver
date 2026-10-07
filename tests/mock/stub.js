// Stands in for the WebExtension `browser` API and the add-on's background
// script, so the content scripts can run inside a plain page (page mode).
// Media requests go to X's hosts, which the test routes to tests/fixtures.

window.__captures = [];
window.__store = {};
const listeners = [];
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const toDataUrl = (blob) =>
  new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });

async function background(msg) {
  switch (msg.type) {
    case "caps":
      return { rectCapture: true, blobMessages: true };
    case "capture": {
      // Record what's actually visible at the top of the requested rectangle.
      const el = document.elementFromPoint(msg.rect.x - scrollX + 20, msg.rect.y - scrollY + 8);
      const art = el?.closest("article");
      const link = art && [...art.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector("time"));
      window.__captures.push({
        rect: msg.rect,
        header: !!el?.closest(".hdr"),
        id: link?.getAttribute("href").match(/status\/(\d+)/)?.[1] || null,
      });
      return { dataUrl: PNG };
    }
    case "video-playlists":
      return { 555: "https://video.twimg.com/amplify_video/555/pl/master.m3u8" };
    case "fetch-asset": {
      const res = await fetch(msg.url);
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const blob = await res.blob();
      let size = {};
      if (blob.type.startsWith("image/")) {
        const bmp = await createImageBitmap(blob);
        size = { width: bmp.width, height: bmp.height };
      }
      return { dataUrl: await toDataUrl(blob), mime: blob.type, bytes: blob.size, ...size };
    }
    case "fetch-text":
      return { text: await (await fetch(msg.url)).text() };
    case "fetch-bytes": {
      const d = await toDataUrl(await (await fetch(msg.url)).blob());
      return { base64: d.slice(d.indexOf(",") + 1) };
    }
    case "save":
      window.__saved = { blob: msg.blob, filename: msg.filename };
      (window.__saves ||= []).push(window.__saved);
      return { id: 1 };
    default:
      return null;
  }
}

window.browser = {
  runtime: {
    getManifest: () => ({ name: "Thread Archiver for X", version: "test" }),
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: async (msg) => {
      try {
        return structuredClone(await background(msg));
      } catch (e) {
        return { __error: e.message };
      }
    },
  },
  extension: { inIncognitoContext: false },
  storage: {
    local: {
      get: async (k) => (k in __store ? { [k]: structuredClone(__store[k]) } : {}),
      set: async (o) => Object.assign(__store, structuredClone(o)),
    },
  },
};

// What the popup does: message the content script and wait for its answer.
window.__send = (msg) => new Promise((resolve) => listeners[0](msg, {}, resolve));
