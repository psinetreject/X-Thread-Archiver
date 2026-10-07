// Walks the conversation top to bottom: scrolls, opens hidden replies,
// follows "Show replies" branches and long posts onto their own pages, and
// screenshots each cell. X only keeps cells near the viewport in the DOM, so
// everything is captured as it scrolls past, never from a full-page grab.

var XTA = globalThis.XTA || (globalThis.XTA = {});

(() => {
  const { SEL, EXPANDER_TEXT, BRANCH_TEXT, STATUS_PATH, VIDEO_THUMB_ID } = XTA;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const docEl = document.documentElement;
  const atBottom = () => scrollY + innerHeight >= docEl.scrollHeight - 4;

  class Stop extends Error {}

  async function waitFor(fn, ms, step = 250) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(step);
    }
  }

  // ---- Keeping floating UI out of the screenshots -------------------------

  const hidden = new Map();
  let styleEl = null;

  function hide(el) {
    if (hidden.has(el)) return;
    hidden.set(el, [el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
    el.style.setProperty("visibility", "hidden", "important");
  }

  // The sticky "Post" header (and any bottom bar) sits over the column.
  // Find it by probing the column's top and bottom edges rather than by a
  // selector, and never hide anything that contains timeline content.
  function hideFloating() {
    const col = document.querySelector(SEL.primaryColumn);
    if (!col) return;
    const r = col.getBoundingClientRect();
    for (const fx of [0.25, 0.5, 0.75]) {
      for (const y of [2, 40, innerHeight - 3, innerHeight - 40]) {
        let el = document.elementFromPoint(r.left + r.width * fx, y);
        while (el && el !== document.body && el !== docEl) {
          if (el.closest(SEL.cell) || el.contains(col) || el.querySelector(SEL.cell)) break;
          const pos = getComputedStyle(el).position;
          if (pos === "sticky" || pos === "fixed") {
            hide(el);
            break;
          }
          el = el.parentElement;
        }
      }
    }
  }

  XTA.beginCaptureMode = function () {
    styleEl = document.createElement("style");
    styleEl.textContent = `${SEL.overlays.join(",")} { visibility: hidden !important; }`;
    document.documentElement.append(styleEl);
  };

  XTA.endCaptureMode = function () {
    styleEl?.remove();
    styleEl = null;
    for (const [el, [value, priority]] of hidden) {
      if (value) el.style.setProperty("visibility", value, priority);
      else el.style.removeProperty("visibility");
    }
    hidden.clear();
  };

  // ---- Page helpers -------------------------------------------------------

  // True if the element sits in a fixed or sticky layer, so its position
  // moves with the screen and can't mark a place in the conversation.
  function stuckToScreen(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const p = getComputedStyle(e).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  }

  // X's "loading more" spinner, not a video's progress bar inside a post.
  const spinnerShowing = () =>
    [...document.querySelectorAll(`${SEL.primaryColumn} ${SEL.progress}`)].some((el) => !el.closest(SEL.article));

  const docTop = (el) => el.getBoundingClientRect().top + scrollY;
  const docBottom = (el) => el.getBoundingClientRect().bottom + scrollY;
  const signature = () => `${cells().length}:${docEl.scrollHeight}`;

  function cells() {
    return [...document.querySelectorAll(`${SEL.primaryColumn} ${SEL.cell}`)];
  }

  const visible = (c) => c.getBoundingClientRect().height > 0;
  const isPost = (id) => (c) => {
    const a = c.querySelector(SEL.article);
    return !!a && visible(c) && XTA.permalinkId(a) === id;
  };
  const findPostCell = (id) => cells().find(isPost(id));

  function classify(cell) {
    if (cell.getBoundingClientRect().height < 2) return "empty";
    if (cell.querySelector(SEL.ad)) return "ad";
    if (cell.querySelector(SEL.article)) return "post";
    if (cell.querySelector(SEL.composer)) return "skip";
    if (cell.querySelector(SEL.heading)) return "heading";
    if (expanderButton(cell)) return "expander";
    if (branchLink(cell)) return "branch";
    if (XTA.flatText(cell).trim()) return "notice";
    return "empty";
  }

  function expanderButton(cell) {
    return [...cell.querySelectorAll(SEL.button)].find(
      (b) => !b.closest("a[href]") && !b.hasAttribute("aria-haspopup") && EXPANDER_TEXT.test(b.textContent),
    );
  }

  function branchLink(cell) {
    return (
      cell.querySelector('a[href*="/status/"]') ||
      [...cell.querySelectorAll('[role="link"]')].find((el) => BRANCH_TEXT.test(el.textContent)) ||
      null
    );
  }

  async function waitForImages(root, ms) {
    const pending = [...root.querySelectorAll("img")].filter((i) => !i.complete);
    if (!pending.length) return;
    const loaded = pending.map(
      (i) =>
        new Promise((r) => {
          i.addEventListener("load", r, { once: true });
          i.addEventListener("error", r, { once: true });
        }),
    );
    await Promise.race([Promise.all(loaded), sleep(ms)]);
  }

  async function waitVisible() {
    while (document.hidden) {
      XTA.setPhase("Paused: switch back to this tab");
      await new Promise((r) => document.addEventListener("visibilitychange", r, { once: true }));
    }
  }

  async function screenshot(cell, opts) {
    const r0 = cell.getBoundingClientRect();
    cell.scrollIntoView({ block: r0.height < innerHeight * 0.85 ? "center" : "start", behavior: "instant" });
    await waitForImages(cell, 4000);
    await sleep(120);
    await frames();
    hideFloating();
    await frames();
    const r = cell.getBoundingClientRect();
    if (r.height < 2) return null;
    const rect = {
      x: Math.floor(r.left + scrollX),
      y: Math.floor(r.top + scrollY),
      width: Math.ceil(r.width),
      height: Math.ceil(r.height),
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const { dataUrl } = await browser.runtime.sendMessage({
          type: "capture",
          rect,
          format: opts.format,
          quality: 0.92,
        });
        return { dataUrl, w: rect.width, h: rect.height };
      } catch (e) {
        // Another tab came to the front between our check and the capture.
        if (!String(e?.message).includes("tab-not-in-front") || attempt >= 5) throw e;
        await waitVisible();
        await sleep(500);
      }
    }
  }

  // X only requests a video's playlist once the video starts, and the
  // background script needs to see that request to download it later.
  async function primeVideos(run, cell) {
    if (run.opts.video === "none") return;
    const players = [...cell.querySelectorAll(SEL.video)]
      .map((p) => {
        const v = p.querySelector("video");
        const poster = v?.getAttribute("poster") || p.querySelector("img")?.src || "";
        return { v, id: poster.match(VIDEO_THUMB_ID)?.[1] };
      })
      .filter((p) => p.id);
    if (!players.length) return;
    const known = async () => {
      const pl = await browser.runtime.sendMessage({ type: "video-playlists" });
      return players.every((p) => pl[p.id]);
    };
    if (await known()) return;
    const started = [];
    for (const { v } of players) {
      if (!v?.paused) continue;
      v.muted = true;
      v.play()?.catch?.(() => {});
      started.push(v);
    }
    await waitFor(known, 5000, 500);
    for (const v of started) v.pause();
  }

  // ---- Clicking and navigating --------------------------------------------

  // Click one of X's own controls. X's links navigate inside the page; if a
  // link ever isn't handled by X, block the browser's default action so a
  // full page load can't end the run.
  function safeClick(el) {
    const link = el.closest("a[href]");
    const guard = (e) => {
      if (link && !e.defaultPrevented) e.preventDefault();
    };
    window.addEventListener("click", guard);
    try {
      el.click();
    } finally {
      window.removeEventListener("click", guard);
    }
  }

  // After X switches pages, the old page's cells can linger for a moment.
  // Wait until everything on screen is new before reading the page.
  async function waitForSwap(oldCells) {
    await waitFor(() => {
      const now = cells().filter(visible);
      return now.length > 0 && now.every((c) => !oldCells.has(c));
    }, 10000);
    await sleep(300);
  }

  // Click and report what happened: X opened another page, or changed this one.
  async function activate(cell, el) {
    const path = location.pathname;
    const sig = signature();
    const old = new Set(cells());
    safeClick(el);
    for (let t = 0; t < 24; t++) {
      await sleep(250);
      if (location.pathname !== path) break;
      if (!cell.isConnected || signature() !== sig) break;
    }
    if (location.pathname === path) await sleep(600);
    if (location.pathname === path) return "changed";
    await waitForSwap(old);
    return "navigated";
  }

  // Return with the browser's own Back, which X handles like a user's Back.
  // (history.length can't tell whether X added an entry: after one round
  // trip, the next one replaces the forward entry and the length stays put.)
  async function back(run, path) {
    const old = new Set(cells());
    history.back();
    if (!(await waitFor(() => location.pathname === path, 10000))) {
      throw new Stop("Couldn't get back to the conversation after opening a link");
    }
    run.path = path;
    await waitForSwap(old);
    await sleep(500);
  }

  // After going back, find the re-rendered copy of the cell we left from.
  // X usually restores the scroll position; if not, look around where it was.
  async function relocate(match, y) {
    let cell = await waitFor(() => cells().find(match), 2500);
    if (!cell) {
      window.scrollTo({ top: Math.max(0, y - innerHeight / 2), behavior: "instant" });
      cell = await waitFor(() => cells().find(match), 2500);
    }
    return cell || null;
  }

  // "Show more" on a long post either expands it in place, or opens the
  // post's own page. On its page, read the full text and screenshot it.
  async function expandLongPost(run, cell, article, id) {
    const from = location.pathname;
    const y = docTop(cell);
    const what = await activate(cell, XTA.showMoreEl(article));
    if (what !== "navigated") return { cell: cell.isConnected ? cell : await relocate(isPost(id), y) };

    run.path = location.pathname;
    let full = null;
    try {
      run.check();
      const focal = await waitFor(() => findPostCell(id), 15000);
      if (focal) {
        const post = XTA.extractPost(focal.querySelector(SEL.article), run.opts);
        full = { post, shot: await screenshot(focal, run.opts) };
      }
    } catch (e) {
      if (e instanceof Stop) throw e;
    }
    await back(run, from);
    return { cell: await relocate(isPost(id), y), full };
  }

  // ---- The walk -----------------------------------------------------------

  // Walks one page. The main page starts from the top; a branch page (a reply
  // opened via "Show replies") starts at its post, since everything above it
  // was already captured.
  async function walkPage(run, page) {
    const { opts } = run;
    const stats = run.archive.stats;
    const done = new WeakSet();
    const clicks = new WeakMap();
    let cursorEl = null;
    let cursorY = 0;
    let idle = 0;
    let lastPostId = page.focalId;
    let section = page.main ? "ancestor" : "reply";

    if (page.main) {
      XTA.setPhase("Loading earlier posts…");
      await loadAncestors(run);
      XTA.setPhase("Capturing…");
    } else {
      const focal = await waitFor(() => findPostCell(page.focalId), 15000);
      if (!focal) throw new Error("the post didn't load");
      cursorY = docTop(focal) - 1;
    }

    // Mark a cell handled and move past it. After a round trip to another
    // page `cell` is the re-rendered copy, or null if it wasn't found again.
    const pass = (cell, y) => {
      if (cell) {
        done.add(cell);
        cursorEl = cell;
      } else {
        cursorEl = null;
        cursorY = y;
      }
    };

    const end = (reason) => {
      run.log("end", { depth: page.depth, reason });
      if (page.main) run.endReason = reason;
    };

    while (true) {
      run.check();
      await waitVisible();
      if (stats.posts >= opts.maxPosts) {
        run.hitLimit(`Reached the limit of ${opts.maxPosts} posts`);
        end("post limit");
        return;
      }

      if (cursorEl?.isConnected) {
        if (stuckToScreen(cursorEl)) {
          run.log("cursor-fixed", { cursor: Math.round(cursorY), bottom: Math.round(docBottom(cursorEl)) });
          cursorEl = null; // keep the last position it had in the page
        } else {
          cursorY = docBottom(cursorEl);
        }
      }
      const all = cells();
      const undone = all.filter((c) => !done.has(c)).map((c) => ({ cell: c, top: docTop(c) }));
      const next = undone.filter((c) => c.top >= cursorY - 2).sort((a, b) => a.top - b.top)[0];

      if (!next) {
        // At the bottom, give X a few tries to load more (longer if a spinner shows).
        const loading = spinnerShowing();
        idle = atBottom() ? idle + 1 : 0;
        run.log("no-next", {
          cursor: Math.round(cursorY),
          cursorEl: cursorEl ? (cursorEl.isConnected ? "connected" : "gone") : "none",
          cells: all.length,
          undone: undone.length,
          maxTop: Math.round(Math.max(-1, ...undone.map((c) => c.top))),
          scrollY: Math.round(scrollY),
          height: docEl.scrollHeight,
          viewport: innerHeight,
          loading,
          idle,
        });
        if (idle >= (loading ? 15 : 5)) {
          end("reached the bottom of the page");
          return;
        }
        window.scrollBy({ top: innerHeight * 0.8, behavior: "instant" });
        await sleep(loading ? 1200 : 900);
        continue;
      }
      idle = 0;
      const { cell } = next;
      const kind = classify(cell);
      run.kinds[kind] = (run.kinds[kind] || 0) + 1;
      const r = cell.getBoundingClientRect();
      run.log(kind, {
        depth: page.depth,
        top: Math.round(next.top),
        height: Math.round(r.height),
        cursor: Math.round(cursorY),
        scrollY: Math.round(scrollY),
        id: kind === "post" ? XTA.permalinkId(cell.querySelector(SEL.article)) : undefined,
        video: cell.querySelector(SEL.video) ? true : undefined,
        text: XTA.blockText(cell).slice(0, 40),
      });
      const canFollow = opts.followBranches && page.depth < opts.maxDepth && stats.branchesOpened < opts.maxBranches;

      if (kind === "expander" || kind === "branch") {
        const el = kind === "expander" ? expanderButton(cell) : branchLink(cell);
        const text = XTA.blockText(cell);
        const href = el.closest("a[href]")?.getAttribute("href") || null;
        const key = href || `${text}|${lastPostId}`;
        if (run.opened.has(key)) {
          pass(cell); // a branch we already followed, re-rendered after coming back
          continue;
        }
        const n = clicks.get(cell) || 0;
        const tryIt = n < 3 && (kind === "expander" ? opts.expand && run.expands < opts.maxExpands : canFollow);
        if (!tryIt) {
          page.out.push({ kind: "branch", text, url: href && absUrl(href), status: "not opened" });
          stats.branchesNotOpened++;
          pass(cell);
          continue;
        }
        clicks.set(cell, n + 1);
        if (kind === "expander") {
          run.expands++;
          stats.expandersClicked++;
        }
        XTA.setPhase(`Opening “${text}”…`);

        const from = location.pathname;
        const y = docTop(cell);
        const yEnd = docBottom(cell);
        const what = await activate(cell, el);
        if (what !== "navigated") {
          XTA.setPhase("Capturing…");
          continue; // opened in place: new posts appear where the button was
        }

        run.opened.add(key);
        const marker = { kind: "branch", text, url: location.origin + location.pathname, status: "opened", items: [] };
        page.out.push(marker);
        if (!canFollow) {
          marker.status = "not opened";
          delete marker.items;
          stats.branchesNotOpened++;
        } else {
          stats.branchesOpened++;
          run.path = location.pathname;
          XTA.setPhase(`Capturing a reply branch (level ${page.depth + 1})…`);
          try {
            const m = location.pathname.match(STATUS_PATH);
            if (!m) throw new Error("it opened something other than a post");
            await walkPage(run, { depth: page.depth + 1, focalId: m[2], out: marker.items, main: false });
          } catch (e) {
            if (e instanceof Stop) throw e;
            marker.status = "failed";
            marker.reason = e.message;
          }
        }
        await back(run, from);
        XTA.setPhase("Capturing…");
        const match = href
          ? (c) => !c.querySelector(SEL.article) && !!c.querySelector(`a[href="${CSS.escape(href)}"]`)
          : (c) => !c.querySelector(SEL.article) && XTA.blockText(c) === text && Math.abs(docTop(c) - y) < 800;
        pass(await relocate(match, y), yEnd);
        continue;
      }

      if (kind === "post") {
        const article = cell.querySelector(SEL.article);
        const id = XTA.permalinkId(article);
        if (id && run.seen.has(id)) {
          pass(cell);
          continue;
        }
        const yEnd = docBottom(cell);
        let target = cell;
        let full = null;
        const wasLong = !!(id && XTA.showMoreEl(article));
        if (wasLong && opts.fullText) {
          XTA.setPhase("Getting the full text of a long post…");
          ({ cell: target, full } = await expandLongPost(run, cell, article, id));
          XTA.setPhase("Capturing…");
        }
        const shot = target ? await screenshot(target, opts) : full?.shot || null;
        run.check();
        if (target) await primeVideos(run, target);
        const art = target?.querySelector(SEL.article);
        const post = (art && XTA.extractPost(art, opts)) || full?.post || null;
        pass(target, yEnd);

        if (!post) {
          addNotice(target || cell, shot);
          continue;
        }
        if (run.seen.has(post.id)) continue;
        run.seen.add(post.id);
        lastPostId = post.id;

        if (wasLong && opts.fullText) {
          if (full?.post && !full.post.truncated) {
            Object.assign(post, { text: full.post.text, parts: full.post.parts, truncated: true, fullText: "post page" });
          } else if (!post.truncated) {
            Object.assign(post, { truncated: true, fullText: "expanded" });
          }
          if (full?.shot && target) {
            run.shots.set(`${post.id}-full`, full.shot.dataUrl);
            post.fullShot = { w: full.shot.w, h: full.shot.h };
          }
          if (post.fullText) stats.longPostsExpanded++;
        }
        if (post.id === run.focalId) section = "focal";
        post.section = section;
        if (section === "focal") section = "reply";
        if (shot) {
          run.shots.set(post.id, shot.dataUrl);
          post.shot = { w: shot.w, h: shot.h };
        }
        page.out.push({ kind: "post", ...post });
        stats.posts++;
        if (post.section === "ancestor") stats.ancestors++;
        if (post.section === "reply") stats.replies++;
        if (post.truncated && !post.fullText) stats.truncated++;
        XTA.progress(stats.posts);
        continue;
      }

      pass(cell);
      // A heading after the focal post starts X's "Discover more" recommendations.
      if (kind === "heading" && (section !== "ancestor" || /discover more/i.test(cell.textContent))) {
        end(
          /discover more/i.test(cell.textContent)
            ? `reached the end of the replies (X's “Discover more” section starts here)${stats.replies ? "" : "; this post has no replies on the page"}`
            : `reached a heading (“${XTA.blockText(cell).slice(0, 40)}”)`,
        );
        return;
      }
      if (kind === "ad") stats.adsSkipped++;
      if (kind === "notice") addNotice(cell, await screenshot(cell, opts));
    }

    function addNotice(cell, shot) {
      const id = `notice-${++run.noticeN}`;
      const item = { kind: "notice", id, text: XTA.blockText(cell) };
      if (shot) {
        run.shots.set(id, shot.dataUrl);
        item.shot = { w: shot.w, h: shot.h };
      }
      page.out.push(item);
      stats.notices++;
    }
  }

  const absUrl = (href) => new URL(href, location.origin).href;

  // Scroll up until X stops loading earlier posts above the focal one.
  async function loadAncestors(run) {
    let stable = 0;
    for (let i = 0; i < 80 && stable < 3; i++) {
      run.check();
      const h = docEl.scrollHeight;
      window.scrollTo({ top: 0, behavior: "instant" });
      await sleep(700);
      stable = scrollY === 0 && docEl.scrollHeight === h ? stable + 1 : 0;
    }
  }

  XTA.walkConversation = (run) => walkPage(run, { depth: 0, focalId: run.focalId, out: run.archive.items, main: true });
  XTA.Stop = Stop;
})();
