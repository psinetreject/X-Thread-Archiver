// Entry point in the page. Owns the run's state so it survives the
// background script being suspended; the popup polls it for progress.

var XTA = globalThis.XTA || (globalThis.XTA = {});

(() => {
  if (XTA.loaded) return; // injected again by a later popup click
  XTA.loaded = true;

  const state = { running: false, phase: "", posts: 0, error: null, result: null };
  let current = null;
  let lastLog = null;

  const badge = (text, color) => browser.runtime.sendMessage({ type: "badge", text, color }).catch(() => {});
  XTA.setPhase = (phase) => (state.phase = phase);
  XTA.progress = (n) => {
    state.posts = n;
    badge(String(n));
  };

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case "status":
        return Promise.resolve({ ...state });
      case "start":
        if (!state.running) start(msg.options || {});
        return Promise.resolve({ ...state });
      case "cancel":
        if (current) current.cancelled = true;
        return Promise.resolve(true);
      case "log":
        return Promise.resolve(lastLog);
    }
  });

  function stamp(d) {
    return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15) + "Z";
  }

  async function start(options) {
    const m = location.pathname.match(XTA.STATUS_PATH);
    Object.assign(state, { running: true, phase: "Starting…", posts: 0, error: null, result: null });
    lastLog = null;
    if (!m) {
      Object.assign(state, { running: false, error: "Open a single post (x.com/<user>/status/<id>) first." });
      return;
    }

    const maxPosts = Math.min(Math.max(parseInt(options.maxPosts, 10) || 1000, 1), 5000);
    const opts = {
      maxPosts,
      maxExpands: 300,
      expand: options.expand !== false,
      followBranches: options.followBranches !== false,
      maxBranches: 100,
      maxDepth: 3,
      fullText: options.fullText !== false,
      fullSize: options.fullSize !== false,
      video: ["none", "720", "best"].includes(options.video) ? options.video : "720",
      format: options.format === "png" ? "png" : "webp",
    };
    const manifest = browser.runtime.getManifest();
    const started = new Date();

    const run = (current = {
      opts,
      focalId: m[2],
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
        source: { url: location.href, focalId: m[2] },
        captured: { startedAt: started.toISOString(), finishedAt: null, durationMs: 0 },
        environment: {
          userAgent: navigator.userAgent,
          language: navigator.language,
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          pageBackground: getComputedStyle(document.body).backgroundColor,
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
      XTA.beginCaptureMode();
      try {
        await XTA.walkConversation(run);
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
          { url: location.href, version: manifest.version, viewport: [innerWidth, innerHeight], ...run.archive.walk },
          null,
          1,
        );
      }
      if (!run.archive.stats.posts) {
        const saw = Object.entries(run.kinds).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing";
        throw new Error(`${run.archive.stopReason || "No posts found on this page"} (saw: ${saw}).`);
      }

      const assets = await collectAssets(run);
      XTA.setPhase("Downloading videos…");
      await XTA.collectVideos(run, assets);

      // Compare with the last time this post was archived, if ever.
      const snap = XTA.snapshot(run.archive);
      const previous = await XTA.history.latest(run.focalId).catch(() => null);
      const diff = previous ? XTA.diffSnapshots(previous, snap) : null;

      XTA.setPhase("Building the archive file…");
      const finished = new Date();
      run.archive.captured.finishedAt = finished.toISOString();
      run.archive.captured.durationMs = finished - started;
      const blob = new Blob(XTA.renderArchive(run.archive, run.shots, assets, diff), { type: "text/html" });

      XTA.setPhase("Saving…");
      const filename = `x-archives/${m[1]}-${m[2]}-${stamp(started)}.html`;
      await browser.runtime.sendMessage({ type: "save", blob, filename });
      await XTA.history.add(run.focalId, snap).catch((e) => console.warn("[X Thread Archiver] history:", e));
      state.result = {
        filename,
        posts: run.archive.stats.posts,
        bytes: blob.size,
        partial: run.archive.partial,
        comparedWith: previous?.capturedAt || null,
        endReason: run.endReason,
      };
      badge("✓", "#2e7d32");
    } catch (e) {
      console.error("[X Thread Archiver]", e);
      state.error = e?.message || String(e);
      badge("!", "#c62828");
    } finally {
      Object.assign(state, { running: false, phase: "" });
      current = null;
    }
  }

  // Download every avatar, image, GIF and video cover the archive shows, so
  // the file works offline. Videos themselves are handled in video.js.
  async function collectAssets(run) {
    const urls = new Set();
    for (const i of XTA.walkItems(run.archive.items)) {
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
        const res = await browser.runtime
          .sendMessage({ type: "fetch-asset", url })
          .catch((e) => ({ error: String(e) }));
        assets.set(url, res);
        run.archive.assets[url] = res.error ? { error: res.error } : { mime: res.mime, bytes: res.bytes };
        if (res.error) run.archive.stats.assetsFailed++;
        XTA.setPhase(`Downloading images… ${++done}/${list.length}`);
      }
    };
    XTA.setPhase(`Downloading images… 0/${list.length}`);
    await Promise.all(Array.from({ length: 4 }, worker));
    return assets;
  }
})();
