// End-to-end capture tests in Firefox, in page mode: the add-on's content
// scripts run inside the mock X page with a stand-in `browser` API
// (mock/stub.js), because Playwright can't load add-ons into Firefox.

const assert = require("assert");
const { firefox } = require("playwright");
const { start } = require("./server");
const { archiveData, postIds, routeMedia, checkFullConversation } = require("./lib");

async function capture(page, options) {
  await page.evaluate((o) => __send({ type: "start", options: o }), options);
  const t0 = Date.now();
  let st;
  for (;;) {
    st = await page.evaluate(() => __send({ type: "status" }));
    if (!st.running) break;
    if (Date.now() - t0 > 240000) throw new Error(`timed out: ${st.phase}`);
    await page.waitForTimeout(500);
  }
  if (st.error) throw new Error(`capture failed: ${st.error}`);
  const out = await page.evaluate(async () => ({
    html: await __saved.blob.text(),
    path: location.pathname,
    captures: __captures.splice(0),
  }));
  return { st, ...out, data: archiveData(out.html), secs: Math.round((Date.now() - t0) / 1000) };
}

(async () => {
  const server = await start();
  const browser = await firefox.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await routeMedia(page);
    await page.goto(`http://127.0.0.1:${server.port}/alice/status/100`);
    await page.waitForSelector("article");

    // 1. The full conversation with default options.
    const r1 = await capture(page, { maxPosts: 1000, video: "720", format: "webp" });
    console.log(`  run 1: ${r1.secs}s, ${r1.st.result.posts} posts, ended: ${r1.data.walk.endReason}`);
    const { ids } = checkFullConversation(r1.data, r1.html);
    assert.equal(r1.captures.filter((c) => c.header).length, 0, "the sticky header never covers a screenshot");
    const shown = new Set(r1.captures.map((c) => c.id));
    for (const id of ids) assert.ok(shown.has(id), `screenshot of ${id} shows that post`);
    assert.equal(r1.path, "/alice/status/100", "back on the starting page");

    // 2. After the conversation changed, with branches and long posts off.
    await page.evaluate(() => {
      __mutate();
      __goto("/alice/status/100");
    });
    await page.waitForTimeout(800);
    const r2 = await capture(page, { video: "none", followBranches: false, fullText: false });
    console.log(`  run 2: ${r2.secs}s, ${r2.st.result.posts} posts`);
    assert.ok(r2.st.result.comparedWith, "compared with run 1");
    const changes = r2.html.slice(r2.html.indexOf('<section class="panel changes"'), r2.html.indexOf("</section></main>"));
    const section = (h) => changes.slice(changes.indexOf(h), changes.indexOf("<h2>", changes.indexOf(h) + 4) >>> 0);
    assert.ok(/First reply with some words in it \(edited\)/.test(section("<h2>Possibly edited")), "edit detected");
    const gone = section("<h2>Gone");
    assert.ok(/A reply that will be deleted/.test(gone) && !/Branch reply one/.test(gone), "only the real deletion is gone");
    assert.ok(/Branch reply one/.test(section("<h2>Not checked")), "posts in unopened branches are 'not checked'");
    assert.ok(/10 → 99/.test(changes), "like count change");
    assert.equal(r2.data.items.find((i) => i.kind === "branch").status, "not opened");

    // 3. A playing video first, with nothing above it.
    await page.evaluate(() => __goto("/zed/status/300"));
    await page.waitForTimeout(800);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll("video")].some((v) => !v.paused)), "video is playing");
    const r3 = await capture(page, { video: "none" });
    console.log(`  run 3: ${r3.secs}s, ended: ${r3.data.walk.endReason}`);
    assert.deepEqual(postIds(r3.data.items), ["300", "301", "302", "303", "304", "305"], "everything under a video post");
    assert.ok(/^reached the end of the replies/.test(r3.data.walk.endReason));
    assert.ok(r3.html.includes("Capture log (ended: reached the end of the replies"), "log in the archive");

    // 4. The same page from a private window: compared, but nothing stored.
    const before = await page.evaluate(() => JSON.stringify(__store));
    await page.evaluate(() => {
      browser.extension.inIncognitoContext = true;
      __goto("/zed/status/300");
    });
    await page.waitForTimeout(800);
    const r4 = await capture(page, { video: "none" });
    assert.equal(r4.st.result.private, true);
    assert.equal(r4.data.environment.privateWindow, true);
    assert.ok(r4.st.result.comparedWith, "a private capture can still compare");
    assert.equal(await page.evaluate(() => JSON.stringify(__store)), before, "nothing stored from the private window");
    console.log("  run 4 (private window): ok");

    console.log("FIREFOX TESTS PASSED");
  } finally {
    await browser.close();
    await server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
