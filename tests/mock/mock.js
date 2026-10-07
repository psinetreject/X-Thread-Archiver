// A small imitation of X's conversation page, close enough to exercise the
// add-on: in-page routing with pushState/popstate, virtualized cells (only
// those near the viewport exist), a sticky header, "Show more" links, "Show
// replies" branches, inline expander buttons, an ad, photos, a GIF, videos
// and a "Discover more" section.

const LONG = "This is a very long post. ".repeat(30) + "THE END.";
const P = {
  90: { h: "bob", text: "Original question?", parent: null },
  95: { h: "alice", text: "Reply in the chain above", parent: "90" },
  100: { h: "alice", text: "The focal post", parent: "95", video: "555" },
  101: { h: "carol", text: "First reply with some words in it", parent: "100", likes: 5 },
  102: { h: "dave", text: LONG, parent: "100", long: true },
  103: { h: "erin", text: "A reply that will be deleted", parent: "100" },
  104: { h: "mona", text: "Two photos", parent: "100", likes: 10, photos: ["PHOTOA", "PHOTOB"] },
  105: { h: "ned", text: "Reply five", parent: "100" },
  106: { h: "olga", text: "A GIF", parent: "100", gif: "GIF1" },
  107: { h: "pete", text: "A reply taller than the window", parent: "100", tall: true },
  110: { h: "frank", text: "Reply that has hidden replies", parent: "100", branch: true },
  111: { h: "gina", text: "Branch reply one", parent: "110" },
  112: { h: "hank", text: "Branch reply two", parent: "110" },
  113: { h: "ivy", text: "Branch reply with its own branch", parent: "110", branch: true },
  114: { h: "liam", text: "Branch reply four", parent: "110" },
  115: { h: "jack", text: "Nested branch reply A", parent: "113" },
  116: { h: "kim", text: "Nested branch reply B", parent: "113" },
  120: { h: "quin", text: "Loaded by show more replies 1", parent: "100", hidden: "more" },
  121: { h: "rita", text: "Loaded by show more replies 2", parent: "100", hidden: "more" },
  122: { h: "sam", text: "Loaded by show more replies 3", parent: "100", hidden: "more" },
  130: { h: "spam1", text: "Probable spam one", parent: "100", hidden: "spam" },
  131: { h: "spam2", text: "Probable spam two", parent: "100", hidden: "spam" },
  300: { h: "zed", text: "A video post with nothing above it", parent: null, video: "777", playing: true },
  301: { h: "amy", text: "Reply under the video one", parent: "300" },
  302: { h: "ben", text: "Reply under the video two", parent: "300" },
  303: { h: "cal", text: "A reply with its own video", parent: "300", video: "778", playing: true },
  304: { h: "deb", text: "Reply under the video four", parent: "300" },
  305: { h: "eve", text: "Reply under the video five", parent: "300" },
  200: { h: "rec1", text: "Recommended post (must not be captured)", parent: null },
  201: { h: "rec2", text: "Another recommended post", parent: null },
};
const ORDER = Object.keys(P); // numeric keys come out in numeric order
const expanded = new Set();
const onX = location.hostname === "x.com"; // extension mode: the real add-on is watching

window.__mutate = () => {
  delete P[103]; // deleted
  ORDER.splice(ORDER.indexOf("103"), 1);
  const old = P[101];
  delete P[101];
  P[141] = { ...old, text: old.text + " (edited)" }; // an edit gets a new ID on X
  ORDER.splice(ORDER.indexOf("101"), 1, "141");
  P[104].likes = 99;
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function postHtml(id, opts = {}) {
  const p = P[id];
  const text = p.long && !opts.full ? p.text.slice(0, 120) + "…" : p.text;
  const video = p.video
    ? `<div data-testid="placementTracking"><div data-testid="videoPlayer"><video poster="https://pbs.twimg.com/amplify_video_thumb/${p.video}/img/p.jpg"${
        p.playing ? ' src="/fixtures/tone.wav" autoplay muted loop' : ""
      } style="display:block;width:100%;height:200px;background:#000"></video></div></div>`
    : "";
  const photos = (p.photos || [])
    .map((m) => `<div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/${m}?format=jpg&name=small" style="width:48%;height:120px"></div>`)
    .join("");
  const gif = p.gif
    ? `<div data-testid="tweetPhoto"><div data-testid="videoPlayer"><video src="https://video.twimg.com/tweet_video/${p.gif}.mp4" poster="https://pbs.twimg.com/tweet_video_thumb/${p.gif}.jpg" style="width:100%;height:100px"></video></div></div>`
    : "";
  return `<article>
    <div data-testid="Tweet-User-Avatar"><img src="https://pbs.twimg.com/profile_images/1/${p.h}_normal.jpg" style="width:20px;height:20px"></div>
    <div data-testid="User-Name"><div><a href="/${p.h}"><span>${p.h.toUpperCase()}</span></a></div><div><a href="/${p.h}"><span>@${p.h}</span></a></div></div>
    <div data-testid="tweetText" lang="en"><span>${esc(text)}</span></div>
    ${p.long && !opts.full ? `<a href="/${p.h}/status/${id}" data-testid="tweet-text-show-more-link">Show more</a>` : ""}
    ${video}${photos}${gif}
    ${p.tall ? `<div class="tall" style="height:1180px;background:repeating-linear-gradient(0deg,#246 0 20px,#fc3 20px 40px)"></div>` : ""}
    <a href="/${p.h}/status/${id}"><time datetime="2026-10-0${(Number(id) % 9) + 1}T12:00:00.000Z">Oct</time></a>
    <div role="group" aria-label="1 replies, 2 reposts, ${p.likes ?? 3} likes, 4 bookmarks, 500 views"></div>
  </article>`;
}

const cell = (key, html, h) => ({ key, html, h });
const heightOf = (id, full) => {
  const p = P[id];
  if (p.tall) return 1400;
  if (p.video) return 360;
  if (p.photos) return 260;
  if (p.gif) return 240;
  if (p.long) return full ? 420 : 200;
  return 140;
};

function cellsFor(focal) {
  const out = [];
  const chain = [];
  for (let id = P[focal]?.parent; id; id = P[id]?.parent) chain.unshift(id);
  for (const id of chain) out.push(cell(`p${id}`, postHtml(id), heightOf(id)));
  out.push(cell(`p${focal}`, postHtml(focal, { full: true }), heightOf(focal, true) + 60));
  out.push(cell("composer", `<div role="textbox" contenteditable="true">Post your reply</div>`, 70));
  const replies = ORDER.filter((id) => P[id]?.parent === focal);
  const placed = new Set();
  for (const id of replies) {
    const hid = P[id].hidden;
    if (hid && !expanded.has(`${focal}:${hid}`)) {
      if (!placed.has(hid)) {
        const label = hid === "more" ? "Show more replies" : "Show probable spam";
        out.push(cell(`${hid}${focal}`, `<div role="button" tabindex="0" data-expand="${focal}:${hid}">${label}</div>`, 52));
        placed.add(hid);
      }
      continue;
    }
    out.push(cell(`p${id}`, postHtml(id), heightOf(id)));
    if (P[id].branch) out.push(cell(`br${id}`, `<a href="/${P[id].h}/status/${id}" role="link"><span>Show replies</span></a>`, 52));
    if (id === "105" && focal === "100") {
      out.push(
        cell(
          "ad",
          `<div><article><div data-testid="top-impression-pixel"></div><div data-testid="User-Name"><div><span>Brand</span></div></div><div data-testid="tweetText">Buy things</div><span>Ad</span></article></div>`,
          140,
        ),
      );
    }
  }
  out.push(cell("disc", `<div><h2 role="heading">Discover more</h2></div>`, 60));
  for (const id of ["200", "201"]) out.push(cell(`p${id}`, postHtml(id), 140));
  return out;
}

// ---- Rendering with virtualization ----
let cells = [];
let tops = [];
const timeline = document.getElementById("timeline");
const live = new Map();

function layout() {
  tops = [];
  let y = 0;
  for (const c of cells) {
    tops.push(y);
    y += c.h;
  }
  timeline.style.height = `${y}px`;
}

function paint() {
  const base = timeline.getBoundingClientRect().top + scrollY;
  const lo = scrollY - base - 600;
  const hi = scrollY - base + innerHeight + 600;
  const want = new Set();
  cells.forEach((c, i) => {
    if (tops[i] + c.h < lo || tops[i] > hi) return;
    want.add(c.key);
    let el = live.get(c.key);
    if (!el) {
      el = document.createElement("div");
      el.dataset.testid = "cellInnerDiv";
      el.innerHTML = c.html;
      live.set(c.key, el);
      timeline.append(el);
      // Like X's player: a video's HLS playlist is requested when it appears.
      if (onX) {
        for (const v of el.querySelectorAll('[data-testid="videoPlayer"] video[poster*="amplify_video_thumb"]')) {
          const id = v.getAttribute("poster").match(/amplify_video_thumb\/(\d+)/)[1];
          fetch(`https://video.twimg.com/amplify_video/${id}/pl/master.m3u8`).catch(() => {});
        }
      }
    }
    el.style.cssText = `position:absolute;left:0;right:0;height:${c.h}px;transform:translateY(${tops[i]}px);border-bottom:1px solid #ddd;overflow:hidden;background:#fff`;
  });
  for (const [k, el] of live) {
    if (!want.has(k)) {
      el.remove();
      live.delete(k);
    }
  }
}

function render(restoreY) {
  const m = location.pathname.match(/^\/[^/]+\/status\/(\d+)/);
  const focal = m ? m[1] : null;
  for (const el of live.values()) el.remove();
  live.clear();
  cells = focal && P[focal] ? cellsFor(focal) : [cell("gone", `<div>This post is unavailable.</div>`, 80)];
  layout();
  paint();
  if (restoreY != null) {
    scrollTo(0, restoreY);
  } else {
    const i = cells.findIndex((c) => c.key === `p${focal}`);
    const base = timeline.getBoundingClientRect().top + scrollY;
    scrollTo(0, Math.max(0, base + tops[Math.max(i, 0)] - 53));
  }
  paint();
}

addEventListener("scroll", () => requestAnimationFrame(paint));

// Like X: internal links navigate in-page (preventDefault + pushState).
document.addEventListener("click", (e) => {
  const exp = e.target.closest("[data-expand]");
  if (exp) {
    expanded.add(exp.dataset.expand);
    const y = scrollY;
    setTimeout(() => {
      const m = location.pathname.match(/status\/(\d+)/);
      cells = cellsFor(m[1]);
      layout();
      for (const el of live.values()) el.remove();
      live.clear();
      scrollTo(0, y);
      paint();
    }, 400);
    return;
  }
  const a = e.target.closest("a[href^='/']");
  if (!a) return;
  e.preventDefault();
  history.replaceState({ y: scrollY }, "");
  history.pushState({}, "", a.getAttribute("href"));
  setTimeout(() => render(), 300);
});

addEventListener("popstate", (e) => setTimeout(() => render(e.state?.y), 300));

window.__goto = (path) => {
  history.pushState({}, "", path);
  render();
};

render();
