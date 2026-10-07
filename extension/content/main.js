// Entry point in the page. Owns the run's state so it survives the
// background script being suspended; the popup polls it for progress.
// A run archives either a conversation (a /status/ page) or a profile.

var XTA = globalThis.XTA || (globalThis.XTA = {});

(() => {
  if (XTA.loaded) return; // injected again by a later popup click
  XTA.loaded = true;

  const state = { running: false, phase: "", posts: 0, error: null, result: null };
  let current = null;
  let lastLog = null;

  const badge = (text, color) => XTA.send({ type: "badge", text, color }).catch(() => {});
  XTA.setPhase = (phase) => (state.phase = phase);
  XTA.progress = (n) => {
    state.posts = n;
    badge(String(n));
  };

  XTA.onMessage((msg) => {
    switch (msg?.type) {
      case "status":
        return { ...state };
      case "start":
        if (!state.running) start(msg.options || {});
        return { ...state };
      case "cancel":
        if (current) current.cancelled = true;
        return true;
      case "log":
        return lastLog;
    }
  });

  function stamp(d) {
    return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15) + "Z";
  }

  const int = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  async function start(options) {
    Object.assign(state, { running: true, phase: "Starting…", posts: 0, error: null, result: null });
    lastLog = null;
    const status = location.pathname.match(XTA.STATUS_PATH);
    const profile = !status && XTA.profilePath(location.pathname);
    if (!status && !profile) {
      Object.assign(state, { running: false, error: "Open a post (x.com/<user>/status/<id>) or a profile (x.com/<user>) first." });
      return;
    }

    const opts = {
      maxPosts: profile ? Infinity : Math.min(int(options.maxPosts, 1000), 5000),
      maxExpands: 300,
      expand: options.expand !== false,
      followBranches: !profile && options.followBranches !== false,
      maxBranches: 100,
      maxDepth: 3,
      fullText: options.fullText !== false,
      fullSize: options.fullSize !== false,
      video: ["none", "720", "best"].includes(options.video) ? options.video : "720",
      format: options.format === "png" ? "png" : "webp",
      // When X stops loading (often its rate limit): retries and first wait.
      maxRetries: 4,
      retryDelay: int(options.retryDelay, 30000),
      // Profiles: which tabs, an optional limit per tab, and posts per file.
      tabs: ["posts", "replies"].filter((t) => (options.tabs || ["posts", "replies"]).includes(t)),
      tabLimit: int(options.tabLimit, 0),
      partSize: int(options.partSize, 100),
    };
    const manifest = browser.runtime.getManifest();
    const started = new Date();
    // Mozilla's rules: nothing from a private window may be stored.
    const isPrivate = !!browser.extension?.inIncognitoContext;

    const run = (current = {
      opts,
      focalId: status?.[2] || null,
      path: location.pathname, // the page we expect to be on; changes while a branch is open
      cancelled: false,
      seen: new Set(), // post IDs already captured
      opened: new Set(), // branches already followed
      expands: 0,
      noticeN: 0,
      kinds: {}, // what the walk saw, for diagnosing "no posts found"
      endReason: null,
      trace: [],
      log(ev, data) {
        this.trace.push({ ms: Date.now() - started, ev, ...data });
        if (this.trace.length > 500) this.trace.shift();
      },
      shots: new Map(),
      archive: {
        format: "x-thread-archiver/1",
        tool: { name: manifest.name, version: manifest.version },
        source: { url: location.href, focalId: status?.[2] || null },
        captured: { startedAt: started.toISOString(), finishedAt: null, durationMs: 0 },
        environment: {
          userAgent: navigator.userAgent,
          language: navigator.language,
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          pageBackground: getComputedStyle(document.body).backgroundColor,
          privateWindow: isPrivate,
        },
        options: opts,
        partial: false,
        stopReason: null,
        stats: {
          posts: 0,
          ancestors: 0,
          replies: 0,
          notices: 0,
          branchesOpened: 0,
          branchesNotOpened: 0,
          truncated: 0,
          longPostsExpanded: 0,
          expandersClicked: 0,
          adsSkipped: 0,
          videosSaved: 0,
          videosFailed: 0,
          assetsFailed: 0,
        },
        items: [],
        assets: {},
      },
      check() {
        if (this.cancelled) throw new XTA.Stop("Stopped before the end");
        if (location.pathname !== this.path) throw new XTA.Stop("The page navigated away mid-capture");
      },
      hitLimit(reason) {
        this.archive.partial = true;
        this.archive.stopReason ??= reason;
      },
    });
    badge("…", "#1d70b8");

    try {
      const ctx = { started, stamp: stamp(started), isPrivate, manifest };
      state.result = status ? await conversation(run, status, ctx) : await profileRun(run, profile[1], ctx);
      badge("✓", "#2e7d32");
    } catch (e) {
      console.error("[Thread Archiver]", e);
      state.error = e?.message || String(e);
      badge("!", "#c62828");
    } finally {
      Object.assign(state, { running: false, phase: "" });
      current = null;
    }
  }

  // Runs the capture with screenshots set up, and records the capture log.
  async function capture(run, ctx, walk) {
    XTA.beginCaptureMode();
    try {
      await walk();
    } catch (e) {
      if (!(e instanceof XTA.Stop)) throw e;
      run.archive.partial = true;
      run.archive.stopReason = e.message;
      run.endReason = `stopped: ${e.message}`;
    } finally {
      XTA.endCaptureMode();
      // Kept in the archive, and copyable from the popup, for troubleshooting.
      run.archive.walk = { endReason: run.endReason, kinds: run.kinds, trace: run.trace };
      lastLog = JSON.stringify(
        { url: location.href, version: ctx.manifest.version, viewport: [innerWidth, innerHeight], ...run.archive.walk },
        null,
        1,
      );
    }
    if (!run.archive.stats.posts) {
      const saw = Object.entries(run.kinds).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing";
      throw new Error(`${run.archive.stopReason || "No posts found on this page"} (saw: ${saw}).`);
    }
  }

  function finish(run, ctx) {
    const finished = new Date();
    run.archive.captured.finishedAt = finished.toISOString();
    run.archive.captured.durationMs = finished - ctx.started;
  }

  // ---- A conversation: one file ---------------------------------------------

  async function conversation(run, m, ctx) {
    await capture(run, ctx, () => XTA.walkConversation(run));

    const assets = await XTA.collectAssets(run, run.archive);
    XTA.setPhase("Downloading videos…");
    await XTA.collectVideos(run, assets, run.archive);

    // Compare with the last time this post was archived, if ever.
    const snap = XTA.snapshot(run.archive);
    const previous = await XTA.history.latest(run.focalId).catch(() => null);
    const diff = previous ? XTA.diffSnapshots(previous, snap) : null;

    XTA.setPhase("Building the archive file…");
    finish(run, ctx);
    const blob = new Blob(XTA.renderArchive(run.archive, run.shots, assets, diff), { type: "text/html" });

    XTA.setPhase("Saving…");
    const filename = `x-archives/${m[1]}-${m[2]}-${ctx.stamp}.html`;
    await XTA.saveFile(blob, filename);
    // A private capture can still be compared with earlier ones, but isn't remembered.
    if (!ctx.isPrivate) await XTA.history.add(run.focalId, snap).catch((e) => console.warn("[Thread Archiver] history:", e));
    return {
      filename,
      posts: run.archive.stats.posts,
      bytes: blob.size,
      partial: run.archive.partial,
      comparedWith: previous?.capturedAt || null,
      endReason: run.endReason,
      private: ctx.isPrivate,
    };
  }

  // ---- A profile: a folder of part files plus an index ----------------------

  async function profileRun(run, handle, ctx) {
    const folder = `x-archives/${handle}-profile-${ctx.stamp}`;
    run.profile = { handle, folder, header: null, headerShot: null, tabs: {}, parts: [], snapPosts: {}, coverage: {}, bytes: 0 };
    run.archive.source.profile = handle;
    await capture(run, ctx, () => XTA.runProfile(run, handle));

    const p = run.profile;
    const key = `profile:${handle.toLowerCase()}`;
    const snap = {
      v: 1,
      kind: "profile",
      focalId: key,
      url: `https://x.com/${handle}`,
      capturedAt: run.archive.captured.startedAt,
      partial: run.archive.partial,
      stopReason: run.archive.stopReason,
      tabs: Object.keys(p.tabs),
      coverage: p.coverage,
      unopened: [],
      profile: p.header,
      posts: p.snapPosts,
    };
    const previous = await XTA.history.latest(key).catch(() => null);
    const diff = previous ? XTA.diffSnapshots(previous, snap) : null;

    XTA.setPhase("Building the index…");
    const imgs = [p.header?.avatar, p.header?.banner].filter(Boolean);
    const assets = new Map();
    for (const url of imgs) assets.set(url, await XTA.send({ type: "fetch-asset", url }).catch((e) => ({ error: String(e) })));
    finish(run, ctx);
    const blob = new Blob(XTA.renderProfileIndex(run.archive, p, assets, diff), { type: "text/html" });
    const filename = `${folder}/index.html`;
    await XTA.saveFile(blob, filename);
    if (!ctx.isPrivate) await XTA.history.add(key, snap).catch((e) => console.warn("[Thread Archiver] history:", e));
    return {
      filename,
      profile: handle,
      posts: run.archive.stats.posts,
      files: p.parts.length + 1,
      bytes: p.bytes + blob.size,
      partial: run.archive.partial || Object.values(p.tabs).some((t) => t.partial),
      comparedWith: previous?.capturedAt || null,
      endReason: Object.entries(p.tabs).map(([tab, t]) => `${tab}: ${t.endReason || "unknown"}`).join("; "),
      private: ctx.isPrivate,
    };
  }

  // ---- Shared ---------------------------------------------------------------

  // Firefox can hand the Blob to the background. Chrome can't pass Blobs in
  // messages, so it gets a blob: URL made here (its service worker can't make one).
  XTA.saveFile = async function (blob, filename) {
    if ((await XTA.caps()).blobMessages) return XTA.send({ type: "save", blob, filename });
    const url = URL.createObjectURL(blob);
    try {
      return await XTA.send({ type: "save", url, filename });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    }
  };

  // Download every avatar, image, GIF and video cover an archive file shows,
  // so it works offline. Videos themselves are handled in video.js.
  XTA.collectAssets = async function (run, archive) {
    const urls = new Set();
    for (const i of XTA.walkItems(archive.items)) {
      if (i.kind !== "post") continue;
      if (i.author.avatar) urls.add(i.author.avatar);
      if (i.card?.image) urls.add(i.card.image);
      for (const m of [...i.media, ...(i.quote?.media || [])]) {
        if (m.type !== "video") urls.add(m.url);
        else if (m.poster) urls.add(m.poster);
      }
    }

    const list = [...urls];
    const assets = new Map();
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < list.length) {
        const url = list[next++];
        const res = await XTA.send({ type: "fetch-asset", url }).catch((e) => ({ error: String(e) }));
        assets.set(url, res);
        archive.assets[url] = res.error ? { error: res.error } : { mime: res.mime, bytes: res.bytes, width: res.width, height: res.height };
        if (res.error) archive.stats.assetsFailed++;
        XTA.setPhase(`Downloading images… ${++done}/${list.length}`);
      }
    };
    XTA.setPhase(`Downloading images… 0/${list.length}`);
    await Promise.all(Array.from({ length: 4 }, worker));
    return assets;
  };
})();
