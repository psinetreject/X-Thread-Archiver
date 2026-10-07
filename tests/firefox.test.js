// End-to-end capture tests in Firefox, in page mode: the add-on's content
// scripts run inside the mock X page with a stand-in `browser` API
// (mock/stub.js), because Playwright can't load add-ons into Firefox.

const assert = require("assert");
const { firefox } = require("playwright");
const fs = require("fs");
const path = require("path");
const { start, OUT } = require("./server");
const { archiveData, walk, postIds, routeMedia, checkFullConversation } = require("./lib");

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

// A profile capture saves several files; return them all.
async function captureProfile(page, options) {
  await page.evaluate(() => (window.__saves = []));
  const r = await capture(page, options);
  const files = await page.evaluate(async () =>
    Promise.all(__saves.map(async (f) => ({ name: f.filename.split("/").pop(), path: f.filename, html: await f.blob.text() }))),
  );
  return { ...r, files: Object.fromEntries(files.map((f) => [f.name, { ...f, data: archiveData(f.html) }])) };
}

const partsOf = (files, tab) =>
  Object.keys(files)
    .filter((n) => n.startsWith(`${tab}-`))
    .sort()
    .map((n) => files[n]);

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

    // 5. A whole profile: header, Posts and Replies tabs, in parts of 5.
    await page.evaluate(() => {
      browser.extension.inIncognitoContext = false;
      __goto("/alice");
    });
    await page.waitForTimeout(800);
    const r5 = await captureProfile(page, { partSize: 5, retryDelay: 300, video: "none" });
    console.log(`  run 5 (profile): ${r5.secs}s, ${r5.st.result.posts} posts in ${r5.st.result.files} files, ended: ${r5.st.result.endReason}`);
    assert.equal(r5.st.result.profile, "alice");
    assert.ok(/^x-archives\/alice-profile-[\dZ-]+\/index\.html$/.test(r5.st.result.filename), r5.st.result.filename);
    const index = r5.files["index.html"];
    assert.ok(index, "index.html saved");
    // Kept for a look by hand (tests/.output is ignored by git).
    fs.mkdirSync(OUT, { recursive: true });
    for (const name of ["index.html", "posts-001.html", "replies-001.html"]) fs.writeFileSync(path.join(OUT, `profile-${name}`), r5.files[name].html);
    const h = index.data.profile.header;
    assert.deepEqual(
      [h.name, h.handle, h.bio.text, h.location, h.url.text, h.joined, h.following, h.followers],
      ["Alice A", "alice", "Archivist. Likes #tests", "Internet", "example.com", "Joined March 2010", "123 Following", "4,567 Followers"],
    );
    assert.equal(h.avatar, "https://pbs.twimg.com/profile_images/1/alice.jpg", "original-size profile picture");
    assert.equal(h.banner, "https://pbs.twimg.com/profile_banners/1/2/1500x500", "largest banner");
    assert.ok(index.html.includes("Screenshot of the profile header"));
    assert.ok(index.data.walk.trace.some((t) => t.ev === "retry"), "retried when X said 'Something went wrong'");

    const postParts = partsOf(r5.files, "posts");
    assert.deepEqual(postParts.map((f) => f.name), ["posts-001.html", "posts-002.html", "posts-003.html", "posts-004.html"], "parts of 5");
    assert.deepEqual(postParts.map((f) => f.data.part.next), ["posts-002.html", "posts-003.html", "posts-004.html", null], "part links");
    const posts = postParts.flatMap((f) => [...walk(f.data.items)].filter((i) => i.kind === "post"));
    const expectedPosts = ["400", "410", "411", "412", "450", ...Array.from({ length: 13 }, (_, i) => String(413 + i))];
    assert.deepEqual(posts.map((p) => p.id), expectedPosts, `every post in order, skipping "Who to follow" and the ad: got ${posts.map((p) => p.id)}`);
    assert.equal(posts[0].section, "pinned");
    const repost = posts.find((p) => p.id === "450");
    assert.deepEqual([repost.section, repost.social, repost.author.handle], ["repost", "Alice reposted", "carol"]);
    assert.ok(postParts[0].html.includes("📌 Pinned post"), "pinned label");

    const replyParts = partsOf(r5.files, "replies");
    const replies = replyParts.flatMap((f) => [...walk(f.data.items)].filter((i) => i.kind === "post"));
    const expectedReplies = Array.from({ length: 16 }, (_, i) => String(500 + i));
    assert.deepEqual(replies.map((p) => p.id), expectedReplies, "replies with their context, past the retry, without repeating 411");
    assert.deepEqual([...new Set(replies.map((p) => `${p.author.handle === "alice"}:${p.section}`))].sort(), ["false:context", "true:reply"]);
    assert.ok(replyParts[0].html.includes("↩ The post this reply answers"), "context label");
    assert.equal(index.data.stats.adsSkipped, 1);

    // 6. Again after the profile changed, with only the Posts tab.
    await page.evaluate(() => {
      __mutateProfile();
      __goto("/alice");
    });
    await page.waitForTimeout(800);
    const r6 = await captureProfile(page, { partSize: 50, video: "none", tabs: ["posts"] });
    console.log(`  run 6 (profile again): ${r6.secs}s, ${r6.st.result.posts} posts`);
    assert.ok(r6.st.result.comparedWith, "compared with run 5");
    const ch = r6.files["index.html"].html;
    const pChanges = ch.slice(ch.indexOf('<section class="panel changes"'), ch.indexOf("</section></main>"));
    const pSec = (h) => pChanges.slice(pChanges.indexOf(h), pChanges.indexOf("<h2>", pChanges.indexOf(h) + 4) >>> 0);
    assert.ok(/Changed my bio/.test(pSec("<h2>Profile changes")), "bio change");
    assert.ok(/A brand new post/.test(pSec("<h2>New since")), "new post");
    const pGone = pSec("<h2>Gone");
    assert.ok(/Alice post number 3/.test(pGone) && !/reply/.test(pGone), "only the deleted post is gone");
    assert.ok(/Alice&#39;s reply 1/.test(pSec("<h2>Not checked")), "the Replies tab wasn't captured, so its posts aren't 'gone'");
    assert.ok(/1 → 77/.test(pChanges), "like count change");

    console.log("FIREFOX TESTS PASSED");
  } finally {
    await browser.close();
    await server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
