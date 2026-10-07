// Unit tests: reading X's markup, building the archive page, comparing
// captures (in Firefox via Playwright), and joining HLS video (in Node).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");
const { firefox } = require("playwright");
const { FIX, EXT } = require("./server");

const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

// ---- Video: HLS download + joining video and audio into one MP4 -----------

async function testVideo() {
  const ctx = vm.createContext({ Blob, URL, console, atob });
  for (const f of ["content/mp4.js", "content/video.js"]) vm.runInContext(read(f), ctx, { filename: f });
  const XTA = ctx.XTA;
  const BASE = "https://video.twimg.com/amplify_video/1/pl/";
  const io = {
    text: async (u) => fs.readFileSync(path.join(FIX, "hls", u.slice(BASE.length).split("?")[0]), "utf8"),
    bytes: async (u) => new Uint8Array(fs.readFileSync(path.join(FIX, "hls", u.slice(BASE.length).split("?")[0]))),
  };

  assert.equal((await XTA.downloadHls(BASE + "master.m3u8?tag=1", 720, io)).quality, "320x180", "best up to 720p");
  assert.equal((await XTA.downloadHls(BASE + "master.m3u8", 100, io)).quality, "160x90", "respects a lower limit");
  const res = await XTA.downloadHls(BASE + "master.m3u8", 0, io);
  assert.equal(res.blob.type, "video/mp4");
  const b = new Uint8Array(await res.blob.arrayBuffer());

  // Walk the boxes: ftyp, moov(mvhd, trak, trak, mvex(mehd, trex, trex)), then moof/mdat pairs.
  const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const boxes = (s, e) => {
    const out = [];
    for (let o = s; o + 8 <= e; ) {
      const size = u32(o);
      out.push({ type: String.fromCharCode(...b.subarray(o + 4, o + 8)), s: o, e: o + size });
      o += size;
    }
    return out;
  };
  const top = boxes(0, b.length);
  assert.deepEqual(top.slice(0, 2).map((x) => x.type), ["ftyp", "moov"]);
  const moov = boxes(top[1].s + 8, top[1].e);
  assert.deepEqual(moov.map((x) => x.type).filter((t) => t !== "udta"), ["mvhd", "trak", "trak", "mvex"], "video + audio tracks");
  const mvex = boxes(moov.find((x) => x.type === "mvex").s + 8, moov.find((x) => x.type === "mvex").e);
  assert.deepEqual(mvex.map((x) => x.type), ["mehd", "trex", "trex"], "duration box + both tracks");
  const mvhd = moov[0];
  const timescale = u32(mvhd.s + 8 + 4 + 8);
  assert.ok(Math.abs(u32(mvex[0].s + 12) / timescale - 4) < 0.1, "duration ≈ 4 s, so players get a seek bar");
  const seq = top.filter((x) => x.type === "moof").map((m) => u32(boxes(m.s + 8, m.e)[0].s + 12));
  assert.deepEqual(seq, seq.map((_, i) => i + 1), "fragments renumbered in order");

  // If ffmpeg is installed, have it decode the result too.
  const tmp = path.join(os.tmpdir(), `xta-merged-${process.pid}.mp4`);
  fs.writeFileSync(tmp, b);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", tmp], { encoding: "utf8" });
  if (!probe.error) {
    assert.deepEqual(probe.stdout.trim().split("\n").sort(), ["audio", "video"], "ffprobe sees both streams");
    const dec = spawnSync("ffmpeg", ["-v", "error", "-i", tmp, "-f", "null", "-"], { encoding: "utf8" });
    assert.equal(dec.stderr.trim(), "", "ffmpeg decodes it without errors");
  }
  fs.rmSync(tmp, { force: true });
  console.log("  video: ok");
}

// ---- Page code: extraction, archive page, comparison ----------------------

async function testPage() {
  const browser = await firefox.launch();
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    // Serve the fixture as if it were x.com, since links resolve against it.
    await page.route("https://x.com/alice/status/100", (r) => r.fulfill({ path: path.join(FIX, "post.html"), contentType: "text/html" }));
    await page.goto("https://x.com/alice/status/100");
    for (const f of ["content/selectors.js", "content/extract.js", "content/diff.js", "content/render.js"]) {
      await page.addScriptTag({ content: read(f) });
    }

    const [p, gone] = await page.evaluate(() => {
      const [a1, a2] = document.querySelectorAll("article");
      return [XTA.extractPost(a1, { fullSize: true }), XTA.extractPost(a2, { fullSize: true })];
    });
    assert.equal(p.id, "100");
    assert.deepEqual([p.author.handle, p.author.name, p.author.verified], ["alice", "Alice 🦊", true]);
    assert.equal(p.author.avatar, "https://pbs.twimg.com/profile_images/1/a_bigger.jpg");
    assert.equal(p.time, "2026-10-06T14:22:05.000Z");
    assert.ok(p.text.includes("😀") && p.text.includes("\nline two"), "emoji and line breaks kept");
    assert.deepEqual(p.parts.filter((x) => x.t === "link").map((x) => x.href), ["https://t.co/abc", "https://x.com/bob", "https://x.com/hashtag/test"]);
    assert.equal(p.truncated, true);
    assert.deepEqual(p.media.map((m) => m.type), ["photo", "video", "gif"], "a video wrapped in placementTracking is still a video");
    assert.equal(p.media[0].url, "https://pbs.twimg.com/media/PHOTO1?format=jpg&name=orig", "asks for the original image");
    assert.equal(p.media[1].mediaId, "9");
    assert.equal(p.media[2].url, "https://video.twimg.com/tweet_video/GIF1.mp4");
    assert.deepEqual([p.quote.id, p.quote.author.handle, p.quote.text, p.quote.media.length], ["555", "carol", "quoted text", 1]);
    assert.deepEqual([p.counts.replies, p.counts.reposts, p.counts.likes, p.counts.bookmarks, p.counts.views], [14, 52, 1043, 9, 88210]);
    assert.equal(p.card.url, "https://t.co/card");
    assert.equal(gone, null, "a post without a timestamp link is not a post");

    // The archive page escapes post text and drops unsafe links.
    const html = await page.evaluate((post) => {
      post.section = "focal";
      post.shot = { w: 600, h: 300 };
      post.parts.push({ t: "link", v: "x", href: "javascript:alert(1)" });
      const archive = {
        tool: { name: "Thread Archiver for X", version: "test" },
        source: { url: "https://x.com/alice/status/100" },
        captured: { startedAt: "2026-10-06T14:22:00.000Z", durationMs: 1000 },
        partial: false,
        stats: { posts: 1, ancestors: 0, replies: 0, notices: 0 },
        items: [{ kind: "post", ...post }, { kind: "branch", text: "Show replies", url: "https://x.com/bob/status/7", status: "not opened" }],
        assets: {},
      };
      const assets = new Map([[post.media[0].url, { dataUrl: "data:image/jpeg;base64,AAAA", width: 4096, height: 3072 }]]);
      return XTA.renderArchive(archive, new Map([["100", "data:image/webp;base64,BBBB"]]), assets).join("");
    }, p);
    assert.ok(html.includes("Hello &lt;b&gt;world&lt;/b&gt;") && !html.includes("<b>world</b>"), "post text escaped");
    assert.ok(!/href="javascript:/i.test(html), "unsafe link dropped");
    assert.ok(html.includes("4096 × 3072"), "image size label");
    assert.ok(html.includes("Not opened: “Show replies”"));

    // Comparing two captures.
    const d = await page.evaluate(() => {
      const mk = (posts, extra = {}) => ({
        source: { focalId: "1", url: "u" },
        captured: { startedAt: extra.at || "2026-01-01T00:00:00Z" },
        items: posts,
        ...extra,
      });
      const post = (id, text, likes, extra = {}) => ({ kind: "post", id, url: `u/${id}`, author: { handle: "h", name: "H" }, text, media: [], counts: { likes }, ...extra });
      const before = mk([post("1", "focal", 1), post("2", "first reply with some words", 5), post("3", "deleted one", 1), { kind: "branch", url: "b", status: "opened", items: [post("4", "in a branch", 1)] }]);
      const after = mk([post("1", "focal", 9), post("22", "first reply with some words (edited)", 5), { kind: "branch", url: "b", status: "not opened" }], { at: "2026-02-01T00:00:00Z" });
      return XTA.diffSnapshots(XTA.snapshot(before), XTA.snapshot(after));
    });
    assert.deepEqual(d.edited.map((e) => [e.before.id, e.after.id]), [["2", "22"]], "edit paired by author and text");
    assert.deepEqual(d.gone.map((g) => g.id), ["3"], "deletion");
    assert.deepEqual(d.notChecked.map((g) => g.id), ["4"], "posts in an unopened branch aren't 'gone'");
    assert.deepEqual(d.counts.map((c) => [c.id, c.delta.likes]), [["1", [1, 9]]], "count change");
    console.log("  page code: ok");
  } finally {
    await browser.close();
  }
}

(async () => {
  await testVideo();
  await testPage();
  console.log("UNIT TESTS PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
