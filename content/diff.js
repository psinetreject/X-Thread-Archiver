// Comparing captures. Each archive is reduced to a snapshot (text and counts
// per post, no images). Snapshots of past captures are kept in the add-on's
// local storage so a re-archive can show what changed since last time.

var XTA = globalThis.XTA || (globalThis.XTA = {});

(() => {
  const METRICS = ["replies", "reposts", "likes", "bookmarks", "views"];
  const HISTORY_PER_POST = 5;

  // Every item, including those nested inside opened reply branches.
  function* walkItems(items) {
    for (const i of items || []) {
      yield i;
      if (i.items) yield* walkItems(i.items);
    }
  }
  XTA.walkItems = walkItems;

  XTA.snapshot = function (archive) {
    const posts = {};
    const unopened = [];
    // `path` is the chain of reply branches a post was found under.
    const visit = (items, path) => {
      for (const i of items || []) {
        if (i.kind === "post") addPost(i, path);
        else if (i.kind === "branch" && i.status === "opened") visit(i.items, [...path, i.url]);
        else if (i.kind === "branch" && i.url) unopened.push(i.url);
      }
    };
    const addPost = (i, path) => {
      const counts = {};
      for (const k of METRICS) if (i.counts?.[k] != null) counts[k] = i.counts[k];
      posts[i.id] = {
        url: i.url,
        handle: i.author?.handle || "",
        name: i.author?.name || "",
        time: i.time,
        text: i.text || "",
        cutOff: !!(i.truncated && !i.fullText),
        counts,
        note: i.communityNote || null,
        media: i.media?.length || 0,
        branches: path,
      };
    };
    visit(archive.items, []);
    return {
      v: 1,
      focalId: archive.source?.focalId,
      url: archive.source?.url,
      capturedAt: archive.captured?.startedAt,
      partial: !!archive.partial,
      stopReason: archive.stopReason || null,
      unopened,
      posts,
    };
  };

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const words = (s) => new Set(norm(s).toLowerCase().split(" ").filter(Boolean));

  function similarity(a, b) {
    const A = words(a);
    const B = words(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared++;
    return shared / (A.size + B.size - shared);
  }

  // One capture saw the post cut off at "Show more", the other saw it whole.
  function onlyTruncationDiffers(a, b) {
    const x = norm(a).replace(/…$/, "");
    const y = norm(b).replace(/…$/, "");
    return x.startsWith(y) || y.startsWith(x);
  }

  XTA.diffSnapshots = function (before, after) {
    const added = [];
    const gone = [];
    const textChanged = [];
    const renamed = [];
    const notes = [];
    const counts = [];

    for (const [id, a] of Object.entries(after.posts)) {
      const b = before.posts[id];
      if (!b) {
        added.push({ id, ...a });
        continue;
      }
      if (norm(a.text) !== norm(b.text) && !onlyTruncationDiffers(a.text, b.text)) textChanged.push({ id, before: b, after: a });
      if (a.name !== b.name || a.handle !== b.handle) renamed.push({ id, before: b, after: a });
      if (norm(a.note) !== norm(b.note)) notes.push({ id, before: b, after: a });
      const delta = {};
      for (const k of METRICS) {
        if (a.counts?.[k] != null && b.counts?.[k] != null && a.counts[k] !== b.counts[k]) delta[k] = [b.counts[k], a.counts[k]];
      }
      if (Object.keys(delta).length) counts.push({ id, post: a, delta });
    }
    // Posts that were inside a reply branch the newer capture didn't open
    // weren't checked, so they aren't "gone".
    const notChecked = [];
    const skipped = new Set(after.unopened || []);
    for (const [id, b] of Object.entries(before.posts)) {
      if (after.posts[id]) continue;
      if ((b.branches || []).some((u) => skipped.has(u))) notChecked.push({ id, ...b });
      else gone.push({ id, ...b });
    }

    // X gives an edited post a new ID, so an edit looks like one post gone
    // and one new. Pair them up when the author matches and the text is close.
    const edited = [];
    for (const g of [...gone]) {
      let best = null;
      let score = 0;
      for (const a of added) {
        if (a.handle !== g.handle) continue;
        const s = similarity(g.text, a.text);
        if (s > score) [best, score] = [a, s];
      }
      if (best && score >= 0.5) {
        edited.push({ before: g, after: best, score });
        gone.splice(gone.indexOf(g), 1);
        added.splice(added.indexOf(best), 1);
      }
    }

    const size = (d) => Math.max(...Object.values(d.delta).map(([x, y]) => Math.abs(y - x) / Math.max(x, 1)));
    counts.sort((x, y) => size(y) - size(x));
    const meta = (s) => ({ capturedAt: s.capturedAt, url: s.url, posts: Object.keys(s.posts).length, partial: s.partial, stopReason: s.stopReason });

    return { before: meta(before), after: meta(after), added, gone, notChecked, edited, textChanged, renamed, notes, counts };
  };

  XTA.history = {
    key: (focalId) => `history:${focalId}`,
    async latest(focalId) {
      const key = this.key(focalId);
      const list = (await browser.storage.local.get(key))[key] || [];
      return list[list.length - 1] || null;
    },
    async add(focalId, snap) {
      const key = this.key(focalId);
      const list = (await browser.storage.local.get(key))[key] || [];
      list.push(snap);
      await browser.storage.local.set({ [key]: list.slice(-HISTORY_PER_POST) });
    },
  };
})();
