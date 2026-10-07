// Leading "/" matters: Firefox resolves these against the popup's own URL.
const CONTENT_SCRIPTS = [
  "/content/selectors.js",
  "/content/extract.js",
  "/content/capture.js",
  "/content/mp4.js",
  "/content/video.js",
  "/content/diff.js",
  "/content/render.js",
  "/content/main.js",
];
// x.com is needed too: Firefox only shows an add-on the page's video requests
// when it also has access to the page itself.
const ORIGINS = ["https://x.com/*", "https://twitter.com/*", "https://pbs.twimg.com/*", "https://video.twimg.com/*"];
const STATUS_URL = /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?([?#].*)?$/;
const OPTIONS_KEY = "xta-options";

const $ = (id) => document.getElementById(id);
let tab = null;
let warning = "";
let logText = null;

function show(which) {
  $("form").hidden = which !== "form";
  $("running").hidden = which !== "running";
}

function msg(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = kind;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function readOptions() {
  return {
    maxPosts: $("maxPosts").value,
    expand: $("expand").checked,
    followBranches: $("followBranches").checked,
    fullText: $("fullText").checked,
    fullSize: $("fullSize").checked,
    video: $("video").value,
    format: document.querySelector('input[name="format"]:checked').value,
  };
}

function loadOptions() {
  try {
    const o = JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}");
    if (o.maxPosts) $("maxPosts").value = o.maxPosts;
    for (const id of ["expand", "followBranches", "fullText", "fullSize"]) {
      if (typeof o[id] === "boolean") $(id).checked = o[id];
    }
    if ([...$("video").options].some((opt) => opt.value === o.video)) $("video").value = o.video;
    const radio = document.querySelector(`input[name="format"][value="${o.format}"]`);
    if (radio) radio.checked = true;
  } catch {}
}

function saveOptions(o) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
  } catch {}
}

async function status() {
  try {
    return await browser.tabs.sendMessage(tab.id, { type: "status" });
  } catch {
    return null; // content script not injected yet
  }
}

async function refresh() {
  const s = await status();
  if (s?.running) {
    show("running");
    msg(warning, warning && "err");
    $("phase").textContent = s.phase;
    $("count").textContent = `${s.posts} posts captured`;
    return;
  }
  show("form");
  if (s?.error) msg(`Error: ${s.error}`, "err");
  else if (s?.result) {
    const r = s.result;
    const compared = r.comparedWith ? ` It has a Changes tab comparing with your capture from ${r.comparedWith.slice(0, 10)}.` : "";
    const ended = r.endReason ? ` Ended: ${r.endReason}.` : "";
    const priv = r.private ? " Private window: not added to the comparison history." : "";
    msg(`Saved ${r.posts} posts (${mb(r.bytes)})${r.partial ? ", incomplete" : ""} to Downloads/${r.filename}.${ended}${compared}${priv}`, "ok");
  }
  // Fetch the log ahead of time so the copy happens right inside the click.
  if ((s?.error || s?.result) && logText === null) {
    logText = (await browser.tabs.sendMessage(tab.id, { type: "log" }).catch(() => null)) || "";
  }
  $("copyLog").hidden = !logText;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const options = readOptions();
  saveOptions(options);
  // Has to be the first await so Firefox still treats it as a user action.
  // Resolves at once without a prompt if access was granted at install.
  const granted = await browser.permissions.request({ origins: ORIGINS }).catch(() => false);
  try {
    if (!(await status())) {
      const results = await browser.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS });
      // Firefox reports script errors in the results instead of rejecting.
      const failed = results.find((r) => r.error);
      if (failed) throw new Error(`content script failed: ${failed.error.message || failed.error}`);
    }
    await browser.tabs.sendMessage(tab.id, { type: "start", options });
  } catch (err) {
    msg(`Couldn't start: ${err.message}`, "err");
    return;
  }
  warning = granted ? "" : "Site access wasn't granted, so images and videos may not be saved.";
  logText = null;
  refresh();
});

$("copyLog").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(logText);
    $("copyLog").textContent = "Copied. Paste it into your message";
  } catch (e) {
    $("copyLog").textContent = `Couldn't copy: ${e.message}`;
  }
});

$("compare").addEventListener("click", (e) => {
  e.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL("compare/compare.html") });
  window.close();
});

$("stop").addEventListener("click", () => {
  browser.tabs.sendMessage(tab.id, { type: "cancel" }).catch(() => {});
  $("phase").textContent = "Stopping…";
});

(async () => {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  loadOptions();
  if (!tab?.url || !STATUS_URL.test(tab.url)) {
    show("none");
    msg("Open a single post on x.com (a link with /status/ in it), then click this button again.");
    return;
  }
  await refresh();
  setInterval(refresh, 600);
})();
