// Builds the archive: one self-contained HTML file that needs no network and
// no JavaScript. Returns an array of string parts for `new Blob(parts)`, so
// the large base64 images and videos are never joined into one giant string.

var XTA = globalThis.XTA || (globalThis.XTA = {});

(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const safeHref = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
  const num = (n) => Number(n).toLocaleString("en-US");
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
  const snippet = (s, n = 90) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }

  const fmtSeconds = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const CSS = `
:root{--bg:#fff;--fg:#0f1419;--muted:#536471;--line:#e6ecf0;--card:#f7f9f9;--accent:#1d70b8;--warn-bg:#fff4e5;--warn-fg:#7a4100;--up:#1b7a3a;--down:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d0f;--fg:#e7e9ea;--muted:#8b98a5;--line:#2f3336;--card:#16181c;--accent:#6cb6ff;--warn-bg:#3a2a12;--warn-fg:#ffcf8a;--up:#7fd49b;--down:#ff9b93}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.wrap{max-width:640px;margin:0 auto;padding:0 16px 80px}
header{padding:28px 0 8px}
.kicker{margin:0;color:var(--muted);font-size:13px;letter-spacing:.04em;text-transform:uppercase}
h1{margin:6px 0 14px;font-size:20px;line-height:1.3;overflow-wrap:anywhere}
.meta{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0 0 14px;font-size:14px}
.meta dt{color:var(--muted)}.meta dd{margin:0;overflow-wrap:anywhere}
.warn{background:var(--warn-bg);color:var(--warn-fg);padding:8px 12px;border-radius:8px;font-size:14px}
.notes{margin:0 0 14px;padding-left:20px;color:var(--muted);font-size:14px}
.view{position:absolute;opacity:0;pointer-events:none}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-top:8px;position:sticky;top:0;background:var(--bg);z-index:1;overflow-x:auto}
.tabs label{padding:10px 14px;cursor:pointer;color:var(--muted);border-bottom:3px solid transparent;font-weight:600;white-space:nowrap}
#v-shots:checked~.wrap label[for=v-shots],#v-text:checked~.wrap label[for=v-text],#v-changes:checked~.wrap label[for=v-changes]{color:var(--fg);border-color:var(--accent)}
#v-shots:focus-visible~.wrap label[for=v-shots],#v-text:focus-visible~.wrap label[for=v-text],#v-changes:focus-visible~.wrap label[for=v-changes]{outline:2px solid var(--accent)}
.panel{display:none}
#v-shots:checked~.wrap .shots,#v-text:checked~.wrap .text,#v-changes:checked~.wrap .changes{display:block}
.shots{padding-top:12px}
.shot{position:relative}
.shot img{display:block;max-width:100%;height:auto}
.shot .open{position:absolute;top:6px;right:6px;padding:2px 8px;border-radius:6px;background:var(--bg);font-size:12px;opacity:0;transition:opacity .15s}
.shot:hover .open,.shot .open:focus{opacity:1}
.full{margin:0 0 6px;font-size:13px;color:var(--muted)}
.full summary{cursor:pointer;padding:4px 0}
.full img{display:block;max-width:100%;height:auto;border:1px solid var(--line)}
.shotnote{margin:0 0 6px;font-size:13px;color:var(--muted)}
.log{max-height:320px;overflow:auto;font-size:11px;line-height:1.4;background:var(--card);padding:8px;border-radius:8px}
.gap{margin:10px 0;padding:8px 12px;border:1px dashed var(--line);border-radius:8px;color:var(--muted);font-size:14px}
.nest{margin-left:6px;padding-left:10px;border-left:3px solid var(--line)}
.divider{margin:24px 0 4px;color:var(--muted);font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.post{display:grid;grid-template-columns:44px 1fr;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}
.post>div{min-width:0}
.post.focal .txt{font-size:18px}
.av{width:44px;height:44px;border-radius:50%;background:var(--line) center/cover no-repeat}
.hd{color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.hd b{color:var(--fg)}
.badge{color:var(--accent)}
.txt{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:2px}
.trunc{margin:6px 0 0;font-size:14px;color:var(--muted)}
.media{display:grid;gap:4px;margin-top:10px}
.media.multi{grid-template-columns:1fr 1fr}
.media img,.media video{display:block;width:100%;height:auto;border-radius:12px;border:1px solid var(--line)}
.media figure{margin:0}
.media figcaption{font-size:13px;color:var(--muted);margin-top:4px}
.card{display:block;margin-top:10px;border:1px solid var(--line);border-radius:12px;overflow:hidden;color:inherit;text-decoration:none}
.card img{display:block;width:100%;height:auto}
.card span{display:block;padding:8px 12px;font-size:14px;color:var(--muted)}
.quote{margin:10px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.cnote{margin-top:10px;padding:8px 12px;border-radius:8px;background:var(--card);font-size:14px}
.counts{margin-top:10px;color:var(--muted);font-size:13px}
.notice{padding:14px 12px;margin:8px 0;border-radius:8px;background:var(--card);color:var(--muted);font-size:14px}
.changes{padding-top:12px}
.changes h2{font-size:16px;margin:28px 0 4px}
.changes .hint{margin:0 0 8px;color:var(--muted);font-size:14px}
.summary{display:flex;flex-wrap:wrap;gap:6px;padding:0;margin:12px 0;list-style:none}
.summary li{padding:4px 10px;border-radius:999px;background:var(--card);font-size:14px}
.chg{padding:10px 0;border-bottom:1px solid var(--line)}
.was,.now{margin-top:6px;padding:6px 10px;border-radius:8px;background:var(--card);white-space:pre-wrap;overflow-wrap:anywhere}
.was{text-decoration:line-through;text-decoration-color:var(--muted);color:var(--muted)}
.lbl{display:block;font-size:12px;color:var(--muted);text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
td.n{white-space:nowrap;font-variant-numeric:tabular-nums}
.up{color:var(--up)}.down{color:var(--down)}
`;
  XTA.ARCHIVE_CSS = CSS;

  // ---- Changes since an earlier capture -----------------------------------

  const METRICS = ["replies", "reposts", "likes", "bookmarks", "views"];

  function refHtml(p) {
    return `<div class="hd"><b>${esc(p.name)}</b> @${esc(p.handle)} · <a href="${safeHref(p.url)}">${fmtTime(p.time) || "post"}</a></div>`;
  }

  XTA.renderChanges = function (d) {
    const out = [];
    out.push(
      `<p>Compared with the capture from <b>${fmtTime(d.before.capturedAt)}</b> (${plural(d.before.posts, "post", "posts")}) ` +
        `to the one from <b>${fmtTime(d.after.capturedAt)}</b> (${plural(d.after.posts, "post", "posts")}).</p>`,
    );
    if (d.before.partial || d.after.partial) {
      out.push(
        `<p class="warn">${d.before.partial && d.after.partial ? "Both captures were" : d.before.partial ? "The earlier capture was" : "This capture was"} ` +
          `incomplete, so some posts listed as new or gone may just not have been loaded.</p>`,
      );
    }
    const notChecked = d.notChecked || [];
    const summary = [
      [d.edited.length, "possibly edited"],
      [d.textChanged.length, "text changed"],
      [d.gone.length, "gone"],
      [d.added.length, "new"],
      [d.renamed.length, "name change", "name changes"],
      [d.notes.length, "community note change", "community note changes"],
      [d.counts.length, "count change", "count changes"],
    ].filter(([n]) => n);
    if (!summary.length) {
      out.push(`<p>No changes found.</p>`);
    } else {
      out.push(`<ul class="summary">${summary.map(([n, one, many = one]) => `<li><b>${num(n)}</b> ${n === 1 ? one : many}</li>`).join("")}</ul>`);
    }

    const beforeAfter = (b, a) =>
      `<div class="was"><span class="lbl">Before</span>${esc(b)}</div><div class="now"><span class="lbl">After</span>${esc(a)}</div>`;

    if (d.edited.length) {
      out.push(`<h2>Possibly edited</h2><p class="hint">X gives an edited post a new ID. These pairs have the same author and similar text.</p>`);
      for (const e of d.edited) out.push(`<div class="chg">${refHtml(e.after)}${beforeAfter(e.before.text, e.after.text)}</div>`);
    }
    if (d.textChanged.length) {
      out.push(`<h2>Text changed</h2>`);
      for (const c of d.textChanged) out.push(`<div class="chg">${refHtml(c.after)}${beforeAfter(c.before.text, c.after.text)}</div>`);
    }
    if (d.gone.length) {
      out.push(`<h2>Gone since the earlier capture</h2><p class="hint">Deleted, hidden, made private, or just not loaded this time. The text below is from the earlier capture.</p>`);
      for (const g of d.gone) out.push(`<div class="chg">${refHtml(g)}<div class="txt">${esc(g.text)}</div></div>`);
    }
    if (notChecked.length) {
      out.push(
        `<h2>Not checked this time</h2><p class="hint">${plural(notChecked.length, "post was", "posts were")} inside reply branches that this capture didn't open, so there's no way to tell whether they changed.</p>`,
        `<details class="full"><summary>Show them</summary>`,
      );
      for (const g of notChecked) out.push(`<div class="chg">${refHtml(g)}<div class="txt">${esc(snippet(g.text, 280))}</div></div>`);
      out.push(`</details>`);
    }
    if (d.added.length) {
      out.push(`<h2>New since the earlier capture</h2>`);
      for (const a of d.added) out.push(`<div class="chg">${refHtml(a)}<div class="txt">${esc(snippet(a.text, 280))}</div></div>`);
    }
    if (d.renamed.length) {
      out.push(`<h2>Name changes</h2>`);
      for (const r of d.renamed) {
        out.push(
          `<div class="chg">${refHtml(r.after)}${beforeAfter(`${r.before.name} @${r.before.handle}`, `${r.after.name} @${r.after.handle}`)}</div>`,
        );
      }
    }
    if (d.notes.length) {
      out.push(`<h2>Community notes</h2>`);
      for (const n of d.notes) out.push(`<div class="chg">${refHtml(n.after)}${beforeAfter(n.before.note || "(no note)", n.after.note || "(no note)")}</div>`);
    }
    if (d.counts.length) {
      const cols = METRICS.filter((k) => d.counts.some((c) => c.delta[k]));
      out.push(
        `<h2>Count changes</h2><div class="tablewrap"><table><thead><tr><th>Post</th>`,
        cols.map((k) => `<th>${k[0].toUpperCase() + k.slice(1)}</th>`).join(""),
        `</tr></thead><tbody>`,
      );
      for (const c of d.counts) {
        const cells = cols.map((k) => {
          if (!c.delta[k]) return `<td class="n">—</td>`;
          const [x, y] = c.delta[k];
          const diff = y - x;
          return `<td class="n">${num(x)} → ${num(y)} <span class="${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : "−"}${num(Math.abs(diff))}</span></td>`;
        });
        out.push(`<tr><td><a href="${safeHref(c.post.url)}">@${esc(c.post.handle)}</a>: ${esc(snippet(c.post.text, 60))}</td>${cells.join("")}</tr>`);
      }
      out.push(`</tbody></table></div>`);
    }
    return out.join("");
  };

  // A standalone page for the compare tool's "Save report".
  XTA.renderReport = function (d) {
    return (
      `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Archive comparison ${esc((d.after.capturedAt || "").slice(0, 10))}</title><style>${CSS}.changes{display:block}</style></head>` +
      `<body><div class="wrap"><header><p class="kicker">Archive comparison</p><h1>What changed</h1>` +
      `<p><a href="${safeHref(d.after.url)}">${esc(d.after.url)}</a></p></header>` +
      `<section class="changes">${XTA.renderChanges(d)}</section></div></body></html>\n`
    );
  };

  // ---- The archive --------------------------------------------------------

  XTA.renderArchive = function (archive, shots, assets, diff) {
    const out = [];
    const asset = (url) => (url && assets.get(url)?.dataUrl) || null;
    const items = archive.items;
    const all = [...XTA.walkItems(items)];
    const posts = all.filter((i) => i.kind === "post");
    const focal = posts.find((i) => i.section === "focal") || posts[0];
    const s = archive.stats;

    // Avatars repeat across posts, so each is embedded once as a CSS class.
    const avatarClass = new Map();
    for (const p of posts) {
      const a = p.author?.avatar;
      if (a && !avatarClass.has(a) && asset(a)) avatarClass.set(a, `a${avatarClass.size}`);
    }

    const title = focal ? `@${focal.author.handle}: “${snippet(focal.text, 100)}”` : "Archived conversation";
    const day = archive.captured.startedAt.slice(0, 10);

    out.push(
      `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`,
      `<meta name="viewport" content="width=device-width,initial-scale=1">`,
      `<meta name="generator" content="${esc(archive.tool.name)} ${esc(archive.tool.version)}">`,
      `<title>${esc(focal ? `@${focal.author.handle} conversation, archived ${day}` : `Archived conversation ${day}`)}</title>`,
      `<style>${CSS}`,
    );
    for (const [url, cls] of avatarClass) out.push(`.${cls}{background-image:url("`, asset(url), `")}\n`);
    out.push(`</style></head><body>`);

    // Radio inputs drive the tabs without any script.
    out.push(
      `<input class="view" type="radio" name="view" id="v-shots" checked aria-label="Screenshots view">`,
      `<input class="view" type="radio" name="view" id="v-text" aria-label="Text view">`,
      diff ? `<input class="view" type="radio" name="view" id="v-changes" aria-label="Changes view">` : "",
      `<div class="wrap"><header>`,
      `<p class="kicker">Archived conversation</p><h1>${esc(title)}</h1>`,
      `<dl class="meta">`,
      `<dt>Source</dt><dd><a href="${safeHref(archive.source.url)}">${esc(archive.source.url)}</a></dd>`,
      `<dt>Captured</dt><dd>${fmtTime(archive.captured.startedAt)} (took ${Math.round(archive.captured.durationMs / 1000)} s)</dd>`,
      `<dt>Contents</dt><dd>${plural(s.posts, "post", "posts")}: ${num(s.ancestors)} earlier, ${num(s.replies)} replies` +
        (s.notices ? `, ${num(s.notices)} notices` : "") +
        `</dd>`,
      diff ? `<dt>Compared</dt><dd>with your capture from ${fmtTime(diff.before.capturedAt)} (see Changes)</dd>` : "",
      `</dl>`,
    );
    if (archive.partial) out.push(`<p class="warn">Incomplete archive: ${esc(archive.stopReason)}</p>`);

    const notes = [];
    const videos = posts.flatMap((p) => [...p.media, ...(p.quote?.media || [])]).filter((m) => m.type === "video");
    const savedVideos = videos.filter((m) => m.file).length;
    const branches = all.filter((i) => i.kind === "branch" || i.kind === "unexpanded");
    const opened = branches.filter((b) => b.status === "opened").length;
    const failed = branches.filter((b) => b.status === "failed").length;
    const notOpened = branches.length - opened - failed;
    if (savedVideos) notes.push(`${plural(savedVideos, "video", "videos")} saved (Text tab).`);
    if (videos.length > savedVideos) notes.push(`${plural(videos.length - savedVideos, "video", "videos")} saved as a cover image only.`);
    if (s.longPostsExpanded) notes.push(`${plural(s.longPostsExpanded, "long post", "long posts")} expanded to full text.`);
    if (s.truncated) notes.push(`${plural(s.truncated, "long post was", "long posts were")} cut off on the page; the full text isn't saved.`);
    if (opened) notes.push(`${plural(opened, "reply branch", "reply branches")} opened and shown indented.`);
    if (notOpened) notes.push(`${plural(notOpened, "reply branch", "reply branches")} not opened.`);
    if (failed) notes.push(`${plural(failed, "reply branch", "reply branches")} couldn't be opened.`);
    if (s.assetsFailed) notes.push(`${plural(s.assetsFailed, "image", "images")} couldn't be downloaded and link to X instead.`);
    if (s.adsSkipped) notes.push(`${plural(s.adsSkipped, "ad", "ads")} skipped.`);
    if (notes.length) out.push(`<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`);
    if (archive.walk) {
      const lines = archive.walk.trace.map(({ ms, ev, ...rest }) => `${String(ms).padStart(7)} ms  ${ev}  ${JSON.stringify(rest)}`);
      out.push(
        `<details class="full"><summary>Capture log (ended: ${esc(archive.walk.endReason || "unknown")})</summary>`,
        `<pre class="log">${esc(lines.join("\n"))}</pre></details>`,
      );
    }

    out.push(
      `<nav class="tabs"><label for="v-shots">Screenshots</label><label for="v-text">Text</label>`,
      diff ? `<label for="v-changes">Changes</label>` : "",
      `</nav></header><main>`,
    );

    // ---- Screenshots view ----
    out.push(`<section class="panel shots" aria-label="Screenshots">`);
    shotsHtml(items);
    out.push(`</section>`);

    // ---- Text view ----
    out.push(`<section class="panel text" aria-label="Text">`);
    let lastSection = null;
    textHtml(items, 0);
    out.push(`</section>`);

    if (diff) out.push(`<section class="panel changes" aria-label="Changes">`, XTA.renderChanges(diff), `</section>`);
    out.push(`</main></div>`);

    // Machine-readable copy of everything above (minus image and video data).
    out.push(
      `<script type="application/json" id="xta-data">`,
      JSON.stringify(archive).replace(/</g, "\\u003c"),
      `</script></body></html>\n`,
    );
    return out;

    function shotsHtml(list) {
      for (const i of list) {
        if ((i.kind === "post" || i.kind === "notice") && shots.has(i.id)) {
          const alt = i.kind === "post" ? `Post by @${i.author.handle}: ${i.text}` : i.text;
          out.push(
            `<div class="shot" id="s-${esc(i.id)}"><img loading="lazy" decoding="async" width="${i.shot.w}" height="${i.shot.h}" alt="${esc(alt.slice(0, 500))}" src="`,
            shots.get(i.id),
            `">`,
            i.kind === "post" ? `<a class="open" href="${safeHref(i.url)}">Open on X</a>` : "",
            `</div>`,
          );
          if (i.kind === "post" && i.fullShot && shots.has(`${i.id}-full`)) {
            out.push(
              `<details class="full"><summary>Show the full long post</summary><img loading="lazy" decoding="async" width="${i.fullShot.w}" height="${i.fullShot.h}" alt="Full post by @${esc(i.author.handle)}" src="`,
              shots.get(`${i.id}-full`),
              `"></details>`,
            );
          }
          if (i.kind === "post" && i.media.some((m) => m.file)) out.push(`<p class="shotnote">▶ This post's video is saved in the Text tab.</p>`);
        } else if (i.kind === "post") {
          out.push(`<p class="gap">Screenshot failed for <a href="${safeHref(i.url)}">this post</a>.</p>`);
        } else if (i.kind === "branch" || i.kind === "unexpanded") {
          branchHtml(i, () => shotsHtml(i.items));
        }
      }
    }

    function textHtml(list, depth) {
      for (const i of list) {
        if (i.kind === "post") {
          if (depth === 0 && i.section !== lastSection && i.section !== "focal") {
            out.push(`<p class="divider">${i.section === "ancestor" ? "Earlier in the conversation" : "Replies"}</p>`);
          }
          if (depth === 0) lastSection = i.section;
          postHtml(i);
        } else if (i.kind === "notice") {
          out.push(`<p class="notice">${esc(i.text) || "(empty notice)"}</p>`);
        } else if (i.kind === "branch" || i.kind === "unexpanded") {
          branchHtml(i, () => textHtml(i.items, depth + 1));
        }
      }
    }

    function branchHtml(b, renderChildren) {
      const label = esc(b.text || "Show replies");
      const link = b.url ? ` <a href="${safeHref(b.url)}">Open on X</a>` : "";
      if (b.status === "opened") {
        const n = [...XTA.walkItems(b.items)].filter((i) => i.kind === "post").length;
        out.push(`<p class="gap">↳ Opened “${label}”: ${plural(n, "more post", "more posts")}.${link}</p><div class="nest">`);
        renderChildren();
        out.push(`</div>`);
      } else if (b.status === "failed") {
        out.push(`<p class="gap">↳ Couldn't open “${label}” (${esc(b.reason || "unknown error")}).${link}</p>`);
      } else {
        out.push(`<p class="gap">↳ Not opened: “${label}”.${link}</p>`);
      }
    }

    function partsHtml(p) {
      return p.parts.map((x) => (x.t === "link" ? `<a href="${safeHref(x.href)}">${esc(x.v)}</a>` : esc(x.v))).join("");
    }

    function headerHtml(author, time, url) {
      const when = time ? `<time datetime="${esc(time)}">${fmtTime(time)}</time>` : "";
      return (
        `<div class="hd"><b>${esc(author?.name || "")}</b>` +
        (author?.verified ? ` <span class="badge" title="Verified">✔</span>` : "") +
        ` @${esc(author?.handle || "?")}` +
        (when ? ` · ${url ? `<a href="${safeHref(url)}">${when}</a>` : when}` : "") +
        `</div>`
      );
    }

    function mediaHtml(list, postUrl) {
      if (!list.length) return;
      out.push(`<div class="media${list.length > 1 ? " multi" : ""}">`);
      for (const m of list) {
        if (m.type === "photo") {
          const data = asset(m.url);
          out.push(
            data
              ? `<img loading="lazy" decoding="async" alt="${esc(m.alt || "Image")}" src="${data}">`
              : `<a href="${safeHref(m.url)}">Image (not saved)</a>`,
          );
          continue;
        }
        if (m.type === "gif" && asset(m.url)) {
          out.push(`<video src="`, asset(m.url), `" autoplay loop muted playsinline controls></video>`);
          continue;
        }
        const poster = asset(m.poster);
        const video = m.type === "video" && m.file && asset(`video:${m.mediaId}`);
        if (video && m.file.mime === "video/mp4") {
          const info = [m.file.quality, m.file.seconds ? fmtSeconds(m.file.seconds) : null].filter(Boolean).join(", ");
          out.push(
            `<figure><video controls preload="metadata" playsinline`,
            poster ? ` poster="${poster}"` : "",
            ` src="`,
            video,
            `"></video><figcaption>Video${info ? ` (${esc(info)})` : ""}</figcaption></figure>`,
          );
          continue;
        }
        const cover = poster ? `<img loading="lazy" decoding="async" alt="Video cover image" src="${poster}">` : "";
        if (video) {
          out.push(
            `<figure>${cover}<figcaption>Video saved in MPEG-TS format, which browsers can't play. `,
            `<a download="video-${esc(m.mediaId)}.ts" href="`,
            video,
            `">Save the video file</a> (VLC can play it).</figcaption></figure>`,
          );
          continue;
        }
        const why = m.reason ? ` (${esc(m.reason)})` : "";
        out.push(
          `<figure>${cover}<figcaption>${m.type === "gif" ? "GIF" : "Video"} not saved${why}. <a href="${safeHref(postUrl)}">Watch on X</a></figcaption></figure>`,
        );
      }
      out.push(`</div>`);
    }

    function postHtml(p) {
      const av = avatarClass.get(p.author.avatar);
      out.push(
        `<article class="post ${esc(p.section)}" id="t-${esc(p.id)}">`,
        `<div class="av${av ? ` ${av}` : ""}" role="img" aria-label="@${esc(p.author.handle)}"></div><div>`,
        headerHtml(p.author, p.time, p.url),
        `<div class="txt"${p.lang ? ` lang="${esc(p.lang)}"` : ""}>${partsHtml(p)}</div>`,
        p.truncated && !p.fullText ? `<p class="trunc">Cut off on the page. <a href="${safeHref(p.url)}">Read the full post on X</a></p>` : "",
      );
      mediaHtml(p.media, p.url);
      if (p.card) {
        const img = asset(p.card.image);
        out.push(
          `<a class="card" href="${safeHref(p.card.url)}">${img ? `<img loading="lazy" decoding="async" alt="" src="${img}">` : ""}<span>${esc(p.card.text || p.card.url)}</span></a>`,
        );
      }
      if (p.quote) {
        const q = p.quote;
        out.push(`<blockquote class="quote">${headerHtml(q.author, q.time, q.url)}<div class="txt">${partsHtml(q)}</div>`);
        mediaHtml(q.media, q.url || p.url);
        out.push(`</blockquote>`);
      }
      if (p.communityNote) out.push(`<aside class="cnote">${esc(p.communityNote)}</aside>`);
      if (p.counts) {
        const c = p.counts;
        const bits = METRICS.filter((k) => c[k] != null).map((k) => `${num(c[k])} ${c[k] === 1 ? k.replace(/(ie)?s$/, (m, ie) => (ie ? "y" : "")) : k}`);
        if (bits.length) out.push(`<div class="counts">${bits.join(" · ")} <span title="Counts at capture time">(at capture)</span></div>`);
      }
      out.push(`</div></article>`);
    }
  };
})();
