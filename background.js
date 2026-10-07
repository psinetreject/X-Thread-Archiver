// Background helper. Holds no capture state (MV3 event pages can be suspended);
// the content script owns the run and asks for the few things only we can do.

const MEDIA_HOSTS = new Set(["pbs.twimg.com", "video.twimg.com"]);
const MAX_ASSET_BYTES = 50 * 1024 * 1024;

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  switch (msg?.type) {
    case "capture":
      return capture(sender.tab, msg);
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
      return save(msg.blob, msg.filename, !!sender.tab?.incognito);
  }
});

// Screenshot one region of the page. `rect` is in CSS pixels relative to the
// document, which Firefox supports (Chrome's API cannot do this).
// captureTab would need the <all_urls> permission; captureVisibleTab only
// needs activeTab, but it captures whichever tab is in front in the window.
async function capture(tab, { rect, format, quality }) {
  const [front] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  if (front?.id !== tab.id) throw new Error("tab-not-in-front");
  const png = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png", rect });
  if (format === "png") return { dataUrl: png };
  return { dataUrl: await reencode(png, "image/webp", quality) };
}

async function reencode(dataUrl, type, quality) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const out = canvas.toDataURL(type, quality);
  // Fall back to the original if the encoder isn't available.
  return out.startsWith(`data:${type}`) ? out : dataUrl;
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
    return { dataUrl: await blobToDataUrl(new Blob([blob], { type: mime })), mime, bytes: blob.size };
  } catch (e) {
    return { error: String(e) };
  }
}

// Video playlists and chunks for video.js.
async function fetchRaw(url, as) {
  const bad = checkHost(url);
  if (bad) return { error: bad };
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return as === "text" ? { text: await res.text() } : { buffer: await res.arrayBuffer() };
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

// A save from a private window stays a private download, so it doesn't land
// in the permanent download history.
async function save(blob, filename, incognito) {
  if (!(blob instanceof Blob)) throw new Error("save: expected a Blob");
  const url = URL.createObjectURL(blob);
  try {
    const id = await browser.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
      incognito,
    });
    return { id };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  }
}
