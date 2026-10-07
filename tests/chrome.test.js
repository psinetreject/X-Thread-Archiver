// End-to-end capture test in Chromium with the real add-on loaded.
// Chromium is pointed at the test server for x.com, pbs.twimg.com and
// video.twimg.com, so everything runs as it would on X: the popup's
// injection, the background service worker, screenshots, video requests
// seen by webRequest, and the download.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");
const { start, contentScripts, EXT, OUT } = require("./server");
const { archiveData, checkFullConversation } = require("./lib");

// A copy of the add-on with <all_urls> added: it stands in for the toolbar
// click (which grants activeTab for screenshots) since a test can't click it.
function testCopy() {
  const dir = path.join(OUT, "chrome-ext");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(EXT, dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions.push("<all_urls>");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

(async () => {
  const server = await start({ secure: true });
  const ext = testCopy();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xta-chrome-"));
  const map = ["x.com", "twitter.com", "pbs.twimg.com", "video.twimg.com"].map((h) => `MAP ${h} 127.0.0.1:${server.port}`).join(", ");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: null,
    acceptDownloads: true,
    downloadsPath: path.join(OUT, "downloads"),
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      `--host-resolver-rules=${map}`,
      "--ignore-certificate-errors",
      "--window-size=1200,1000",
      "--force-device-scale-factor=2", // so screenshots are 2x and the crop math is exercised
    ],
  });
  const step = (m) => process.env.DEBUG && console.log(`  [${new Date().toISOString().slice(11, 19)}] ${m}`);
  try {
    step("launched");
    const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    step(`service worker: ${sw.url()}`);
    const page = context.pages()[0] || (await context.newPage());
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.goto("https://x.com/alice/status/100");
    await page.waitForSelector("article");
    step("mock page loaded");

    // What the popup does when you click "Archive this conversation".
    await sw.evaluate(
      async ({ files, options }) => {
        const [tab] = await chrome.tabs.query({ url: "https://x.com/*" });
        globalThis.__tab = tab.id;
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
        const failed = results.find((r) => r.error);
        if (failed) throw new Error(`injection failed: ${failed.error.message || failed.error}`);
        await XTA.sendToTab(tab.id, { type: "start", options });
      },
      { files: contentScripts(), options: { maxPosts: 1000, video: "720", format: "webp" } },
    );

    const t0 = Date.now();
    let st;
    for (;;) {
      st = await sw.evaluate(() => XTA.sendToTab(globalThis.__tab, { type: "status" }));
      if (!st.running) break;
      step(`${st.phase} (${st.posts} posts)`);
      if (Date.now() - t0 > 300000) throw new Error(`timed out: ${st.phase}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (st.error) {
      const log = await sw.evaluate(() => XTA.sendToTab(globalThis.__tab, { type: "log" }));
      throw new Error(`capture failed: ${st.error}\n${(log || "").slice(-3000)}`);
    }
    console.log(`  capture: ${Math.round((Date.now() - t0) / 1000)}s, ${st.result.posts} posts, ended: ${st.result.endReason}`);

    // The archive was saved through chrome.downloads.
    let item;
    for (let i = 0; i < 40; i++) {
      [item] = await sw.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }));
      if (item?.state === "complete") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(item?.state, "complete", `download finished: ${JSON.stringify(item)}`);
    assert.ok(/x-archives[\\/]alice-100-/.test(st.result.filename), `filename: ${st.result.filename}`);
    const html = fs.readFileSync(item.filename, "utf8");
    const data = archiveData(html);
    checkFullConversation(data, html);
    assert.ok(page.url().endsWith("/alice/status/100"), "back on the starting page");

    // Screenshots: real crops at the screen's 2x density, and the reply
    // taller than the window stitched from several captures.
    const shots = await (await context.newPage()).evaluate(async (archive) => {
      document.documentElement.innerHTML = archive;
      const out = [];
      for (const img of document.querySelectorAll(".shot img")) {
        img.loading = "eager"; // lazy images below the fold would never load here
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        // Share of the image that isn't plain white, per quarter of its height.
        const quarters = [0, 1, 2, 3].map((q) => {
          const d = g.getImageData(0, Math.floor((q * c.height) / 4), c.width, Math.floor(c.height / 4)).data;
          let ink = 0;
          for (let i = 0; i < d.length; i += 16) if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink++;
          return ink / (d.length / 16);
        });
        out.push({ id: img.closest(".shot").id.slice(2), css: [+img.getAttribute("width"), +img.getAttribute("height")], px: [img.naturalWidth, img.naturalHeight], quarters });
      }
      return out;
    }, html);
    for (const s of shots) {
      const sx = s.px[0] / s.css[0];
      const sy = s.px[1] / s.css[1];
      assert.ok(Math.abs(sx - 2) < 0.05 && Math.abs(sy - 2) < 0.05, `screenshot of ${s.id} at 2x: ${JSON.stringify(s)}`);
      assert.ok(s.quarters.some((q) => q > 0.01), `screenshot of ${s.id} isn't blank`);
    }
    const tall = shots.find((s) => s.id === "107");
    assert.ok(tall.css[1] > 1000, "the tall reply is taller than the window");
    assert.ok(tall.quarters.every((q) => q > 0.3), `tall reply stitched with no gaps: ${JSON.stringify(tall.quarters)}`);

    console.log(`  ${shots.length} screenshots checked`);
    console.log("CHROME TESTS PASSED");
  } finally {
    await context.close();
    await server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
