// Background helper. Holds no capture state (it can be suspended at any
// time); the content script owns the run and asks for the few things only
// the background can do. Runs as a background page in Firefox and as a
// service worker in Chrome, which has no DOM (no Image, canvas or blob URLs).

if (typeof importScripts === "function") importScripts("lib/compat.js"); // Chrome; Firefox lists it in the manifest

const MEDIA_HOSTS = new Set(["pbs.twimg.com", "video.twimg.com"]);
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const FIREFOX = typeof browser.runtime.getBrowserInfo === "function";

XTA.onMessage((msg, sender) => {
  const tabId = sender.tab?.id;
  switch (msg?.type) {
    case "caps":
      // Firefox can screenshot any rectangle of the page and pass Blobs in
      // messages; Chrome can only capture the visible screen and pass JSON.
      return { rectCapture: FIREFOX, blobMessages: FIREFOX };
    case "capture":
      return capture(sender.tab, msg.rect);
    case "fetch-asset":
      return fetchAsset(msg.url);
    case "fetch-bytes":
      return fetchRaw(msg.url, "bytes");
    case "fetch-text":
      return fetchRaw(msg.url, "text");
    case "video-playlists":
      return playlistsFor(tabId);
    case "badge":
      setBadge(tabId, msg.text, msg.color);
      return;
    case "save":
      return save(msg, !!sender.tab?.incognito);
  }
});

// Screenshot as PNG. In Firefox, `rect` (CSS pixels relative to the
// document) captures exactly that region; Chrome ignores it and returns the
// visible screen, which the content script crops. captureTab would need the
// <all_urls> permission; captureVisibleTab only needs activeTab, but it
// captures whichever tab is in front in the window.
let lastCapture = 0;

async function capture(tab, rect) {
  const [front] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  if (front?.id !== tab.id) throw new Error("tab-not-in-front");
  if (FIREFOX) return { dataUrl: await browser.tabs.captureVisibleTab(tab.windowId, { format: "png", rect }) };
  // Chrome allows two captures per second.
  for (let attempt = 0; ; attempt++) {
    const wait = lastCapture + 550 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCapture = Date.now();
    try {
      return { dataUrl: await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
    } catch (e) {
      if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(e.message) || attempt >= 5) throw e;
    }
  }
}

function checkHost(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "bad url";
  }
  return MEDIA_HOSTS.has(host) ? null : `host not allowed: ${host}`;
}

async function fetchAsset(url) {
  const bad = checkHost(url);
  if (bad) return { error: bad };
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const blob = await res.blob();
    if (blob.size > MAX_ASSET_BYTES) return { error: `too large (${blob.size} bytes)` };
    // The type ends up inside an HTML attribute, so keep it to a bare MIME type.
    const mime = (blob.type.split(";")[0].replace(/[^\w.+/-]/g, "") || "application/octet-stream").toLowerCase();
    const size = mime.startsWith("image/") ? await imageSize(blob) : {};
    return { dataUrl: await blobToDataUrl(new Blob([blob], { type: mime })), mime, bytes: blob.size, ...size };
  } catch (e) {
    return { error: String(e) };
  }
}

// Pixel size, so the archive can show that an image is the full original.
async function imageSize(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return {};
  }
}

// Video playlists and chunks for video.js. Bytes travel as base64 because
// Chrome messages can't carry binary data.
async function fetchRaw(url, as) {
  const bad = checkHost(url);
  if (bad) return { error: bad };
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    if (as === "text") return { text: await res.text() };
    const dataUrl = await blobToDataUrl(await res.blob());
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  } catch (e) {
    return { error: String(e) };
  }
}

// ---- Video playlists ------------------------------------------------------
// X plays videos with HLS: a small .m3u8 playlist lists the qualities, each
// pointing at the actual video chunks. We only watch for the playlist
// addresses the page itself requests (nothing is blocked or changed), keyed
// by tab and by the video's media ID, so video.js can download them later.
// Kept in session storage because this background page can be suspended.

const PLAYLIST = /^https:\/\/video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/(\d+)\/.*\.m3u8/;

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const m = details.url.match(PLAYLIST);
    if (!m) return;
    const key = `pl:${details.tabId}:${m[1]}`;
    // The master playlist (which lists every quality) sits directly in /pl/;
    // per-quality playlists sit in codec subfolders. Prefer the master.
    const isMaster = /\/pl\/[^/]+\.m3u8$/.test(new URL(details.url).pathname);
    if (isMaster) {
      browser.storage.session.set({ [key]: details.url });
    } else {
      browser.storage.session.get(key).then((r) => r[key] || browser.storage.session.set({ [key]: details.url }));
    }
  },
  { urls: ["https://video.twimg.com/*"] },
);

async function playlistsFor(tabId) {
  const prefix = `pl:${tabId}:`;
  const out = {};
  for (const [k, v] of Object.entries(await browser.storage.session.get(null))) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

browser.tabs.onRemoved.addListener(async (tabId) => {
  const prefix = `pl:${tabId}:`;
  const keys = Object.keys(await browser.storage.session.get(null)).filter((k) => k.startsWith(prefix));
  if (keys.length) await browser.storage.session.remove(keys);
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function setBadge(tabId, text, color) {
  if (tabId == null) return;
  browser.action.setBadgeText({ tabId, text: text || "" });
  if (color) browser.action.setBadgeBackgroundColor({ tabId, color });
}

// Firefox sends the archive itself as a Blob. Chrome can't, so its content
// script sends a blob: URL it created instead (a service worker can't make one).
async function save({ blob, url, filename }, incognito) {
  const own = blob instanceof Blob ? URL.createObjectURL(blob) : null;
  if (!own && !/^blob:/.test(url || "")) throw new Error("save: expected a Blob or blob: URL");
  try {
    const id = await browser.downloads.download({
      url: own || url,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
      // A save from a private window stays a private download, so it doesn't
      // land in the permanent download history. (Firefox-only option.)
      ...(FIREFOX ? { incognito } : {}),
    });
    return { id };
  } finally {
    if (own) setTimeout(() => URL.revokeObjectURL(own), 120_000);
  }
}
