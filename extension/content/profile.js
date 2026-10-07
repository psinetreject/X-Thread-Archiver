// Archiving a profile: its header, then the Posts and Replies tabs as far
// back as X loads them. A profile can have thousands of posts, so instead of
// one file the archive is a folder, written as the capture goes:
//
//   x-archives/<user>-profile-<time>/
//     posts-001.html, posts-002.html, …   100 posts each, self-contained
//     replies-001.html, …
//     index.html                          header, overview, changes, links
//
// Each part is saved and dropped from memory as soon as it's full.

var XTA = globalThis.XTA || (globalThis.XTA = {});

(() => {
  const { SEL } = XTA;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TABS = { posts: "Posts", replies: "Replies" };

  XTA.runProfile = async function (run, handle) {
    const { opts } = run;
    const profile = run.profile;

    await gotoTab(run, handle, "posts");
    XTA.setPhase("Capturing the profile header…");
    window.scrollTo({ top: 0, behavior: "instant" });
    await sleep(800);
    profile.header = XTA.extractProfile();
    const shot = await XTA.shootHeader(opts);
    if (shot) profile.headerShot = shot;

    for (const tab of Object.keys(TABS)) {
      if (!opts.tabs.includes(tab)) continue;
      const t = (profile.tabs[tab] = { posts: 0, parts: 0, endReason: null, partial: false });
      const out = [];
      const page = {
        out,
        timeline: {
          tab,
          limit: opts.tabLimit,
          section: (post) => sectionOf(post, tab, handle),
          onPost: () => (out.length >= opts.partSize ? flush(run, tab, out, false) : null),
        },
      };
      try {
        await gotoTab(run, handle, tab);
        await XTA.walkTimeline(run, page);
        t.endReason = page.endReason;
      } catch (e) {
        // Save what this tab has. A stop ends the whole run; any other
        // failure is noted on this tab and the next tab still runs.
        t.partial = true;
        t.endReason = `${e instanceof XTA.Stop ? "stopped" : "failed"}: ${e.message}`;
        run.log("tab-error", { tab, error: e.message });
        await flush(run, tab, out, true);
        if (e instanceof XTA.Stop) throw e;
        continue;
      }
      await flush(run, tab, out, true);
    }
  };

  // How a post appears on the profile, from X's label above it.
  function sectionOf(post, tab, handle) {
    if (/pinned/i.test(post.social || "")) return "pinned";
    if (/repost/i.test(post.social || "")) return "repost";
    const mine = (post.author?.handle || "").toLowerCase() === handle.toLowerCase();
    if (tab === "replies") return mine ? "reply" : "context"; // context: the post being replied to
    return "post";
  }

  async function gotoTab(run, handle, tab) {
    const path = tab === "posts" ? `/${handle}` : `/${handle}/with_replies`;
    if (location.pathname.replace(/\/$/, "").toLowerCase() !== path.toLowerCase()) {
      window.scrollTo({ top: 0, behavior: "instant" });
      await sleep(300);
      const link = [...document.querySelectorAll(`${SEL.primaryColumn} ${SEL.tabList} a[href]`)].find(
        (a) => a.getAttribute("href").toLowerCase() === path.toLowerCase(),
      );
      if (!link) throw new Error(`couldn't find the ${TABS[tab]} tab on the profile`);
      XTA.setPhase(`Opening the ${TABS[tab]} tab…`);
      if (!(await XTA.followLink(link))) throw new Error(`the ${TABS[tab]} tab didn't open`);
    }
    run.path = location.pathname;
  }

  // Save the posts collected so far as the tab's next part file.
  async function flush(run, tab, out, last) {
    const items = out.splice(0);
    if (!items.length) return;
    const profile = run.profile;
    const t = profile.tabs[tab];
    const n = ++t.parts;
    const file = `${tab}-${String(n).padStart(3, "0")}.html`;
    const posts = items.filter((i) => i.kind === "post");
    const times = posts.filter((p) => p.section === "post" || p.section === "reply").map((p) => p.time).filter(Boolean).sort();
    const from = t.posts + 1;
    t.posts += posts.length;
    XTA.setPhase(`Saving ${TABS[tab]} part ${n}…`);

    const archive = {
      format: "x-thread-archiver/1",
      tool: run.archive.tool,
      source: { url: `https://x.com/${profile.handle}${tab === "replies" ? "/with_replies" : ""}`, profile: profile.handle },
      captured: run.archive.captured,
      environment: run.archive.environment,
      options: run.opts,
      partial: false,
      stopReason: null,
      part: {
        handle: profile.handle,
        tab,
        tabName: TABS[tab],
        n,
        from,
        to: t.posts,
        prev: n > 1 ? `${tab}-${String(n - 1).padStart(3, "0")}.html` : null,
        next: last ? null : `${tab}-${String(n + 1).padStart(3, "0")}.html`,
      },
      stats: partStats(posts),
      items,
      assets: {},
    };
    const assets = await XTA.collectAssets(run, archive);
    await XTA.collectVideos(run, assets, archive);
    const blob = new Blob(XTA.renderArchive(archive, run.shots, assets, null), { type: "text/html" });
    await XTA.saveFile(blob, `${profile.folder}/${file}`);

    // Remember a compact copy for the index and the Changes comparison,
    // then let the screenshots and media go.
    for (const p of posts) {
      profile.snapPosts[p.id] = XTA.snapshotPost(p, { tab, section: p.section });
      run.shots.delete(p.id);
      run.shots.delete(`${p.id}-full`);
    }
    if (times.length) {
      const c = profile.coverage;
      c[tab] = !c[tab] || times[0] < c[tab] ? times[0] : c[tab];
    }
    profile.parts.push({ tab, n, file, from, to: t.posts, newest: times[times.length - 1] || null, oldest: times[0] || null, bytes: blob.size });
    profile.bytes += blob.size;
    XTA.setPhase(`Capturing the ${tab} tab…`);
  }

  function partStats(posts) {
    const count = (s) => posts.filter((p) => p.section === s).length;
    const media = posts.flatMap((p) => [...p.media, ...(p.quote?.media || [])]);
    return {
      posts: posts.length,
      pinned: count("pinned"),
      reposts: count("repost"),
      replies: count("reply"),
      context: count("context"),
      truncated: posts.filter((p) => p.truncated && !p.fullText).length,
      longPostsExpanded: posts.filter((p) => p.fullText).length,
      videos: media.filter((m) => m.type === "video").length,
      assetsFailed: 0,
      videosSaved: 0,
      videosFailed: 0,
    };
  }
})();
