// Turns rendered X markup into plain data. Reads the page only.

var XTA = globalThis.XTA || (globalThis.XTA = {});

(() => {
  const { SEL, STATUS_HREF } = XTA;

  const absUrl = (href) => {
    try {
      return new URL(href, location.origin).href;
    } catch {
      return null;
    }
  };

  // Text with emoji kept: X draws emoji as <img alt="😀">, which innerText drops.
  function flatText(node) {
    let out = "";
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
      else if (n.nodeType !== Node.ELEMENT_NODE) continue;
      else if (n.tagName === "IMG") out += n.getAttribute("alt") || "";
      else if (n.tagName === "BR") out += "\n";
      else out += flatText(n);
    }
    return out;
  }

  // Post text as a list of parts so links, mentions and hashtags survive.
  function richText(root) {
    const parts = [];
    const push = (t, v, href) => {
      if (!v) return;
      const last = parts[parts.length - 1];
      if (t === "text" && last?.t === "text") last.v += v;
      else parts.push(href ? { t, v, href } : { t, v });
    };
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) push("text", n.nodeValue);
        else if (n.nodeType !== Node.ELEMENT_NODE) continue;
        else if (n.tagName === "IMG") push("text", n.getAttribute("alt") || "");
        else if (n.tagName === "BR") push("text", "\n");
        else if (n.tagName === "A") push("link", flatText(n), absUrl(n.getAttribute("href")));
        else walk(n);
      }
    };
    walk(root);
    return { text: parts.map((p) => p.v).join(""), parts };
  }

  // Ask X's image server for the original instead of the display size.
  function mediaUrl(src, full) {
    try {
      const u = new URL(src);
      if (u.hostname === "pbs.twimg.com" && u.pathname.startsWith("/media/")) {
        u.searchParams.set("name", full ? "orig" : "small");
      }
      return u.href;
    } catch {
      return src;
    }
  }

  // The action bar's aria-label has exact counts, e.g.
  // "14 replies, 52 reposts, 1043 likes, 9 bookmarks, 88210 views".
  function parseCounts(label) {
    const counts = { label };
    const keys = { repl: "replies", repost: "reposts", retweet: "reposts", like: "likes", bookmark: "bookmarks", view: "views" };
    for (const m of label.matchAll(/([\d.,]+)\s+(repl|repost|retweet|like|bookmark|view)/gi)) {
      counts[keys[m[2].toLowerCase()]] = Number(m[1].replace(/[.,]/g, ""));
    }
    return counts;
  }

  // A quoted post is a role="link" card holding a second User-Name.
  function findQuote(article) {
    const names = article.querySelectorAll(SEL.userName);
    if (names.length < 2) return null;
    const card = names[1].closest('[role="link"]');
    return card && article.contains(card) && !card.contains(names[0]) ? card : null;
  }

  function extractUser(userNameEl) {
    if (!userNameEl) return null;
    const nameBlock = userNameEl.firstElementChild || userNameEl;
    const handle = userNameEl.textContent.match(/@([A-Za-z0-9_]{1,15})/);
    return {
      name: flatText(nameBlock).trim(),
      handle: handle ? handle[1] : null,
      verified: !!userNameEl.querySelector(SEL.verified),
    };
  }

  function extractMedia(scope, mine, fullSize) {
    const media = [];
    for (const img of scope.querySelectorAll(SEL.photo)) {
      if (!mine(img) || img.closest(SEL.video)) continue;
      if (!/pbs\.twimg\.com\/media\//.test(img.src)) continue;
      const alt = img.getAttribute("alt");
      media.push({ type: "photo", url: mediaUrl(img.src, fullSize), alt: alt && alt !== "Image" ? alt : null });
    }
    for (const player of scope.querySelectorAll(SEL.video)) {
      if (!mine(player) || player.parentElement?.closest(SEL.video)) continue;
      const v = player.querySelector("video");
      const src = v?.currentSrc || v?.getAttribute("src") || v?.querySelector("source")?.getAttribute("src") || "";
      const poster = v?.getAttribute("poster") || player.querySelector("img")?.src || null;
      // GIFs are plain MP4 files; real videos stream through a blob: URL.
      if (/^https:\/\/video\.twimg\.com\/tweet_video\//.test(src)) media.push({ type: "gif", url: src, poster });
      else media.push({ type: "video", poster, mediaId: poster?.match(XTA.VIDEO_THUMB_ID)?.[1] || null });
    }
    return media;
  }

  function extractCard(scope, mine) {
    const card = [...scope.querySelectorAll(SEL.card)].find(mine);
    if (!card) return null;
    const link = card.querySelector("a[href]");
    const img = card.querySelector("img");
    return {
      url: link ? absUrl(link.getAttribute("href")) : null,
      text: blockText(card),
      image: img?.src || null,
    };
  }

  function extractQuote(card, fullSize) {
    const all = () => true;
    const time = card.querySelector("time");
    const textEl = card.querySelector(SEL.text);
    // The quote card itself isn't a link, but its photos link to /status/<id>/photo/N.
    const idLink = [...card.querySelectorAll("a[href]")]
      .map((a) => a.getAttribute("href").match(STATUS_HREF))
      .find(Boolean);
    return {
      id: idLink ? idLink[2] : null,
      url: idLink ? `https://x.com/${idLink[1]}/status/${idLink[2]}` : null,
      author: extractUser(card.querySelector(SEL.userName)),
      time: time?.getAttribute("datetime") || null,
      ...(textEl ? richText(textEl) : { text: "", parts: [] }),
      media: extractMedia(card, all, fullSize),
    };
  }

  // The post's own timestamp link (not the quoted post's).
  function permalink(article) {
    const quote = findQuote(article);
    return [...article.querySelectorAll('a[href*="/status/"]')].find(
      (a) => (!quote || !quote.contains(a)) && a.querySelector("time"),
    );
  }

  XTA.permalinkId = (article) => permalink(article)?.getAttribute("href").match(STATUS_HREF)?.[2] || null;

  // The "Show more" control on a long post, if it has one.
  XTA.showMoreEl = function (article) {
    const quote = findQuote(article);
    return [...article.querySelectorAll(SEL.showMore)].find((el) => !quote || !quote.contains(el)) || null;
  };

  // Returns post data, or null when the article has no permalink (deleted,
  // withheld, etc.), which the caller records as a notice instead.
  XTA.extractPost = function (article, { fullSize }) {
    const quote = findQuote(article);
    const mine = (el) => !quote || !quote.contains(el);
    const first = (sel) => [...article.querySelectorAll(sel)].find(mine) || null;

    const link = permalink(article);
    const m = link?.getAttribute("href").match(STATUS_HREF);
    if (!m) return null;

    const time = link.querySelector("time");
    const textEl = first(SEL.text);
    const avatar = first(SEL.avatar);
    const bar = first(SEL.actionBar);
    const note = first(SEL.communityNote);
    const social = first(SEL.socialContext);
    const author = extractUser(first(SEL.userName)) || { name: "", verified: false };
    author.handle = m[1];
    author.avatar = avatar ? avatar.src.replace("_normal.", "_bigger.") : null;

    return {
      id: m[2],
      url: `https://x.com/${m[1]}/status/${m[2]}`,
      author,
      time: time.getAttribute("datetime"),
      timeShown: time.textContent.trim(),
      lang: textEl?.getAttribute("lang") || null,
      ...(textEl ? richText(textEl) : { text: "", parts: [] }),
      truncated: !!first(SEL.showMore),
      media: extractMedia(article, mine, fullSize),
      card: extractCard(article, mine),
      quote: quote ? extractQuote(quote, fullSize) : null,
      counts: bar ? parseCounts(bar.getAttribute("aria-label")) : null,
      communityNote: note ? flatText(note).trim() : null,
      social: social ? flatText(social).trim() : null,
    };
  };

  // Biggest versions X serves: avatars without a size suffix are the
  // original upload; banners top out at 1500x500.
  const fullAvatar = (src) => src.replace(/_(normal|bigger|mini|x96|200x200|400x400)(\.\w+)$/, "$2");
  const fullBanner = (src) => src.replace(/\/[^/]+$/, "/1500x500");

  // The profile header on a profile page.
  XTA.extractProfile = function () {
    const col = document.querySelector(SEL.primaryColumn);
    const q = (sel) => col?.querySelector(sel) || null;
    const nameEl = q(SEL.profileName);
    const user = nameEl ? extractUser(nameEl) : null;
    const bio = q(SEL.profileBio);
    const urlEl = q(SEL.profileUrl);
    const link = urlEl?.closest("a[href]") || urlEl?.querySelector("a[href]");
    const count = (...suffixes) => {
      for (const s of suffixes) {
        const a = col?.querySelector(`a[href$="${s}"]`);
        if (a) return blockText(a);
      }
      return null;
    };
    const avatar = q(SEL.profileAvatar)?.src;
    const banner = q(SEL.profileBanner)?.src;
    return {
      name: user?.name || "",
      handle: user?.handle || null,
      verified: !!user?.verified,
      ...(bio ? { bio: richText(bio) } : { bio: { text: "", parts: [] } }),
      location: q(SEL.profileLocation) ? blockText(q(SEL.profileLocation)) : null,
      url: urlEl ? { text: blockText(urlEl), href: link ? absUrl(link.getAttribute("href")) : null } : null,
      joined: q(SEL.profileJoined) ? blockText(q(SEL.profileJoined)) : null,
      following: count("/following"),
      followers: count("/verified_followers", "/followers"),
      avatar: avatar ? fullAvatar(avatar) : null,
      banner: banner ? fullBanner(banner) : null,
    };
  };

  // Visible text with line breaks between blocks collapsed to spaces.
  function blockText(el) {
    return (el.innerText ?? flatText(el)).replace(/\s+/g, " ").trim();
  }

  XTA.flatText = flatText;
  XTA.blockText = blockText;
})();
