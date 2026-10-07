// Saves X videos. While the page played them, the background script noted
// each video's HLS playlist address; here we download the chunks those
// playlists list and join video + audio into one MP4 (see mp4.js).

var XTA = globalThis.XTA || (globalThis.XTA = {});

(() => {
  const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

  // Parses an HLS attribute list: KEY=value,KEY="quoted, value"
  function attrs(s) {
    const out = {};
    for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
    return out;
  }

  XTA.parseMaster = function (text, base) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const variants = [];
    const audio = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith("#EXT-X-STREAM-INF:")) {
        const a = attrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
        if (j >= lines.length) break;
        const [width, height] = (a.RESOLUTION || "0x0").split("x").map(Number);
        variants.push({ url: new URL(lines[j], base).href, bandwidth: Number(a.BANDWIDTH) || 0, width, height, audio: a.AUDIO || null });
        i = j;
      } else if (l.startsWith("#EXT-X-MEDIA:")) {
        const a = attrs(l.slice(13));
        if (a.TYPE === "AUDIO" && a.URI) audio.push({ group: a["GROUP-ID"], url: new URL(a.URI, base).href });
      }
    }
    return { variants, audio };
  };

  XTA.parseMedia = function (text, base) {
    let init = null;
    let duration = 0;
    const segments = [];
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith("#EXT-X-MAP:")) {
        const a = attrs(l.slice(11));
        if (a.BYTERANGE) throw new Error("byte-range playlists aren't supported");
        init = new URL(a.URI, base).href;
      } else if (l.startsWith("#EXT-X-BYTERANGE")) {
        throw new Error("byte-range playlists aren't supported");
      } else if (l.startsWith("#EXT-X-KEY:")) {
        if (attrs(l.slice(11)).METHOD !== "NONE") throw new Error("the video is encrypted");
      } else if (l.startsWith("#EXTINF:")) {
        duration += parseFloat(l.slice(8)) || 0;
      } else if (!l.startsWith("#")) {
        segments.push(new URL(l, base).href);
      }
    }
    return { init, segments, duration };
  };

  // Judge quality by the shorter side, so portrait videos count like landscape.
  // maxSide 0 means best available.
  function pickVariant(variants, maxSide) {
    const side = (v) => Math.min(v.width, v.height) || 0;
    const sized = variants.filter(side);
    const sorted = [...(sized.length ? sized : variants)].sort((a, b) => side(a) - side(b) || a.bandwidth - b.bandwidth);
    if (!maxSide) return sorted[sorted.length - 1];
    const fit = sorted.filter((v) => side(v) <= maxSide);
    return fit.length ? fit[fit.length - 1] : sorted[0];
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  // io = { text(url), bytes(url) -> Uint8Array, progress(fraction) }
  XTA.downloadHls = async function (playlistUrl, maxSide, io) {
    const first = await io.text(playlistUrl);
    let video;
    let audio = null;
    let quality = null;
    let bandwidth = 0;
    if (first.includes("#EXT-X-STREAM-INF")) {
      const master = XTA.parseMaster(first, playlistUrl);
      if (!master.variants.length) throw new Error("the playlist lists no video streams");
      const v = pickVariant(master.variants, maxSide);
      quality = v.width && v.height ? `${v.width}x${v.height}` : null;
      bandwidth = v.bandwidth;
      video = XTA.parseMedia(await io.text(v.url), v.url);
      const a = v.audio && master.audio.find((x) => x.group === v.audio);
      if (a) audio = XTA.parseMedia(await io.text(a.url), a.url);
    } else {
      video = XTA.parseMedia(first, playlistUrl); // already a single-quality playlist
    }
    if (!video.segments.length) throw new Error("the playlist has no segments");
    if (audio && !audio.init) throw new Error("unsupported audio format");
    if (bandwidth && (bandwidth / 8) * video.duration > MAX_VIDEO_BYTES) {
      throw new Error(`too large (about ${Math.round((bandwidth / 8) * video.duration / 1e6)} MB)`);
    }

    const urls = [video.init, ...video.segments, ...(audio ? [audio.init, ...audio.segments] : [])].filter(Boolean);
    let done = 0;
    let total = 0;
    const data = await pool(urls, 4, async (url) => {
      const b = await io.bytes(url);
      total += b.length;
      if (total > MAX_VIDEO_BYTES) throw new Error("too large (over 300 MB)");
      io.progress?.(++done / urls.length);
      return b;
    });
    const got = new Map(urls.map((u, i) => [u, data[i]]));
    const segs = (pl) => pl.segments.map((u) => got.get(u));

    // Older videos use MPEG-TS chunks, which join by simple concatenation
    // (audio is already inside). Browsers can't play TS, but VLC can.
    if (!video.init) return { blob: new Blob(segs(video), { type: "video/mp2t" }), quality, duration: video.duration };
    const blob = XTA.mergeFmp4(got.get(video.init), segs(video), audio && got.get(audio.init), audio ? segs(audio) : [], video.duration);
    return { blob, quality, duration: video.duration };
  };

  async function ask(type, url) {
    const res = await XTA.send({ type, url });
    if (res?.error) throw new Error(res.error);
    return res;
  }

  function fromBase64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // Downloads every video in the archive into `assets` as "video:<mediaId>".
  XTA.collectVideos = async function (run, assets) {
    const maxSide = run.opts.video === "best" ? 0 : 720;
    const list = [];
    for (const i of XTA.walkItems(run.archive.items)) {
      if (i.kind !== "post") continue;
      for (const m of [...i.media, ...(i.quote?.media || [])]) if (m.type === "video") list.push(m);
    }
    if (!list.length || run.opts.video === "none") return;

    const playlists = await XTA.send({ type: "video-playlists" });
    const io = {
      text: async (url) => (await ask("fetch-text", url)).text,
      bytes: async (url) => fromBase64((await ask("fetch-bytes", url)).base64),
    };
    const results = new Map(); // mediaId -> { file } | { reason }, for videos shown twice
    const stats = run.archive.stats;
    let n = 0;
    for (const m of list) {
      n++;
      if (!m.mediaId) {
        m.reason = "couldn't identify the video";
        stats.videosFailed++;
        continue;
      }
      if (!results.has(m.mediaId)) {
        const url = playlists[m.mediaId];
        if (!url) {
          results.set(m.mediaId, { reason: "the page never loaded it (is autoplay off in X's settings?)" });
        } else {
          try {
            const res = await XTA.downloadHls(url, maxSide, {
              ...io,
              progress: (f) => XTA.setPhase(`Downloading video ${n} of ${list.length}… ${Math.round(f * 100)}%`),
            });
            const key = `video:${m.mediaId}`;
            assets.set(key, { dataUrl: await blobToDataUrl(res.blob), mime: res.blob.type, bytes: res.blob.size });
            run.archive.assets[key] = { mime: res.blob.type, bytes: res.blob.size };
            results.set(m.mediaId, {
              file: { mime: res.blob.type, bytes: res.blob.size, quality: res.quality, seconds: Math.round(res.duration) },
            });
          } catch (e) {
            results.set(m.mediaId, { reason: e.message });
          }
        }
      }
      const r = results.get(m.mediaId);
      if (r.file) {
        m.file = r.file;
        stats.videosSaved++;
      } else {
        m.reason = r.reason;
        stats.videosFailed++;
      }
    }
  };
})();
