// Test server: a mock X conversation page plus stand-ins for X's image and
// video servers, all answering from tests/fixtures.
//
// Two modes:
// - Page mode (http://127.0.0.1): the mock page also loads the add-on's
//   content scripts with a stand-in `browser` API (mock/stub.js). Used for
//   Firefox, where Playwright can't load add-ons.
// - Extension mode (https): Chromium is pointed at this server for x.com,
//   pbs.twimg.com and video.twimg.com, and the real add-on injects itself.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const FIX = path.join(__dirname, "fixtures");
const OUT = path.join(__dirname, ".output");

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".m4s": "video/iso.segment",
  ".m3u8": "application/vnd.apple.mpegurl",
};

// The content scripts, in the order the popup injects them.
function contentScripts() {
  const popup = fs.readFileSync(path.join(EXT, "popup/popup.js"), "utf8");
  return [...popup.match(/CONTENT_SCRIPTS = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// File for a request to X's media servers, or null.
function mediaFile(host, pathname) {
  if (host === "pbs.twimg.com") {
    if (pathname.startsWith("/media/")) return path.join(FIX, "photo.jpg");
    if (/^\/(amplify_video_thumb|ext_tw_video_thumb|profile_images|card_img)\//.test(pathname)) return path.join(FIX, "thumb.jpg");
  }
  if (host === "video.twimg.com") {
    if (pathname.startsWith("/tweet_video/")) return path.join(FIX, "gif.mp4");
    const m = pathname.match(/^\/amplify_video\/\d+\/pl\/(.+)$/);
    if (m && !m[1].includes("..")) return path.join(FIX, "hls", m[1]);
  }
  return null;
}

function shell(pageMode) {
  const scripts = pageMode
    ? ["/mock/stub.js", "/mock/mock.js", ...contentScripts().map((s) => `/ext${s}`)]
    : ["/mock/mock.js"];
  return fs
    .readFileSync(path.join(__dirname, "mock/mock.html"), "utf8")
    .replace("<!-- scripts -->", scripts.map((s) => `<script src="${s}"></script>`).join("\n"));
}

function handler(req, res) {
  const host = (req.headers.host || "").split(":")[0];
  const { pathname } = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  let file = mediaFile(host, pathname);
  if (!file && (host === "pbs.twimg.com" || host === "video.twimg.com")) file = "missing";
  if (!file && pathname.startsWith("/ext/")) file = path.join(EXT, pathname.slice(5));
  if (!file && pathname.startsWith("/mock/")) file = path.join(__dirname, pathname);
  if (!file && pathname.startsWith("/fixtures/")) file = path.join(__dirname, pathname);
  if (!file) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(shell(host !== "x.com" && host !== "twitter.com"));
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

// A throwaway self-signed certificate (Chromium runs with
// --ignore-certificate-errors, so the name doesn't matter).
function certificate() {
  fs.mkdirSync(OUT, { recursive: true });
  const key = path.join(OUT, "key.pem");
  const cert = path.join(OUT, "cert.pem");
  if (!fs.existsSync(cert)) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=x.com", "-keyout", key, "-out", cert], {
      stdio: "ignore",
    });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function start({ secure = false } = {}) {
  const server = secure ? https.createServer(certificate(), handler) : http.createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }),
    ),
  );
}

module.exports = { start, mediaFile, contentScripts, TYPES, FIX, EXT, OUT };
