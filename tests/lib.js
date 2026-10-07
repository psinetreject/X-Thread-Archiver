// Helpers shared by the test files.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { mediaFile, TYPES } = require("./server");

const MARK = '<script type="application/json" id="xta-data">';

// The machine-readable data every archive carries at its end.
function archiveData(html) {
  const s = html.lastIndexOf(MARK);
  return JSON.parse(html.slice(s + MARK.length, html.indexOf("</script>", s)));
}

function* walk(items) {
  for (const i of items || []) {
    yield i;
    if (i.items) yield* walk(i.items);
  }
}

const postIds = (items) => [...walk(items)].filter((i) => i.kind === "post").map((p) => p.id);

// Page mode: answer requests to X's media servers from tests/fixtures.
async function routeMedia(page) {
  await page.route(/^https:\/\/(pbs|video)\.twimg\.com\//, (route) => {
    const u = new URL(route.request().url());
    const file = mediaFile(u.hostname, u.pathname);
    const headers = { "access-control-allow-origin": "*" };
    if (!file || !fs.existsSync(file)) return route.fulfill({ status: 404, headers, body: "" });
    route.fulfill({ path: file, headers: { ...headers, "content-type": TYPES[path.extname(file)] || "application/octet-stream" } });
  });
}

// Everything the full mock conversation should produce (run with default
// options). Shared by the Firefox and Chrome tests.
function checkFullConversation(data, html) {
  const items = [...walk(data.items)];
  const posts = items.filter((i) => i.kind === "post");
  const ids = posts.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate posts");
  const expected = ["90", "95", "100", "101", "102", "103", "104", "105", "106", "107", "110", "111", "112", "113", "115", "116", "114", "120", "121", "122", "130", "131"];
  assert.deepEqual(ids, expected, "every post, in order");
  assert.equal(data.stats.adsSkipped, 1, "ad skipped");

  const sec = Object.fromEntries(posts.map((p) => [p.id, p.section]));
  assert.deepEqual([sec[90], sec[95], sec[100], sec[101]], ["ancestor", "ancestor", "focal", "reply"], "sections");

  // Branches nest: 111-114 under 110, with 115/116 under 113.
  const b110 = data.items.find((i) => i.kind === "branch" && /frank\/status\/110/.test(i.url));
  assert.equal(b110?.status, "opened", "branch 110 opened");
  assert.deepEqual(postIds(b110.items), ["111", "112", "113", "115", "116", "114"], "branch 110 contents");
  const b113 = b110.items.find((i) => i.kind === "branch");
  assert.ok(b113?.status === "opened" && /ivy\/status\/113/.test(b113.url), "nested branch 113");

  // Long post: full text from its own page, plus a screenshot of it there.
  const p102 = posts.find((p) => p.id === "102");
  assert.equal(p102.fullText, "post page");
  assert.ok(p102.text.endsWith("THE END."), "full text of the long post");
  assert.ok(p102.fullShot, "screenshot of the full long post");

  // Media: video joined from HLS, photos at original size, GIF as MP4.
  const v = posts.find((p) => p.id === "100").media.find((m) => m.type === "video");
  assert.equal(v.mediaId, "555");
  assert.equal(v.file?.mime, "video/mp4", `video saved: ${JSON.stringify(v)}`);
  assert.equal(v.file.quality, "320x180", "highest quality up to 720p");
  assert.ok(html.includes("<figure><video controls"), "video embedded");
  const photos = posts.find((p) => p.id === "104").media;
  assert.deepEqual(photos.map((m) => m.url), [
    "https://pbs.twimg.com/media/PHOTOA?format=jpg&name=orig",
    "https://pbs.twimg.com/media/PHOTOB?format=jpg&name=orig",
  ]);
  for (const m of photos) assert.deepEqual([data.assets[m.url]?.width, data.assets[m.url]?.height], [1600, 1200], "photo at full size");
  assert.ok(html.includes("1600 × 1200"), "size shown on the thumbnail");
  const gif = posts.find((p) => p.id === "106").media[0];
  assert.equal(gif.type, "gif");
  assert.equal(data.assets[gif.url]?.mime, "video/mp4", "GIF saved");

  for (const p of posts) assert.ok(p.shot?.w > 0 && p.shot?.h > 0, `screenshot of ${p.id}`);
  assert.ok(!html.includes('id="v-changes"'), "no Changes tab on a first capture");
  return { posts, ids };
}

module.exports = { archiveData, walk, postIds, routeMedia, checkFullConversation };
