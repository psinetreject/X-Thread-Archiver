// Joins X's separate video and audio HLS streams (fragmented MP4) into one
// playable MP4, without re-encoding. Only box headers and track IDs change.
//
// Layout of the result:  ftyp | moov(video trak, audio trak, mvex) | moof mdat | moof mdat | ...
// Each moof keeps its mdat right behind it, so the sample offsets inside the
// moof (relative to the moof itself) stay valid.

var XTA = globalThis.XTA || (globalThis.XTA = {});

(() => {
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const setU32 = (b, o, v) => {
    b[o] = v >>> 24;
    b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255;
    b[o + 3] = v & 255;
  };

  function boxes(b, start = 0, end = b.length) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      let hdr = 8;
      if (size === 1) {
        size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12);
        hdr = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < hdr || o + size > end) throw new Error(`malformed MP4 box at byte ${o}`);
      out.push({ type: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), start: o, end: o + size, hdr });
      o += size;
    }
    return out;
  }
  const kids = (b, box) => boxes(b, box.start + box.hdr, box.end);
  const kid = (b, box, type) => box && kids(b, box).find((k) => k.type === type);
  const view = (b, box) => b.subarray(box.start, box.end);

  function makeBox(type, parts) {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    setU32(out, 0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  // Offset of a field inside a full box whose layout depends on its version
  // (v0 uses 32-bit times, v1 uses 64-bit).
  const fieldAfterTimes = (b, box) => box.start + box.hdr + 4 + (b[box.start + box.hdr] === 1 ? 16 : 8);

  function parseInit(b) {
    const top = boxes(b);
    const moov = top.find((x) => x.type === "moov");
    if (!moov) throw new Error("init segment has no moov box");
    const children = kids(b, moov);
    const traks = children.filter((k) => k.type === "trak");
    if (!traks.length) throw new Error("init segment has no tracks");
    const tkhd = kid(b, traks[0], "tkhd");
    const mdhd = kid(b, kid(b, traks[0], "mdia"), "mdhd");
    if (!tkhd || !mdhd) throw new Error("track is missing tkhd/mdhd");
    const idOff = fieldAfterTimes(b, tkhd);
    return {
      ftyp: top.find((x) => x.type === "ftyp"),
      moov,
      children,
      tracks: traks.length,
      trak: traks[0],
      idOff,
      trackId: u32(b, idOff),
      timescale: u32(b, fieldAfterTimes(b, mdhd)),
      mvex: children.find((k) => k.type === "mvex"),
    };
  }

  // Split a media segment into moof+mdat pairs, optionally renumbering the
  // track ID. Returns [{ moof (patched copy), mdat (view), time (seconds) }].
  function fragments(seg, timescale, trackId) {
    const out = [];
    const top = boxes(seg);
    for (let i = 0; i < top.length; i++) {
      if (top[i].type !== "moof") continue;
      const mdat = top[i + 1];
      if (mdat?.type !== "mdat") throw new Error("moof not followed by mdat");
      const moof = seg.slice(top[i].start, top[i].end);
      const root = boxes(moof)[0];
      let time = null;
      for (const traf of kids(moof, root).filter((k) => k.type === "traf")) {
        const tfhd = kid(moof, traf, "tfhd");
        if (!tfhd) throw new Error("traf without tfhd");
        // Absolute file offsets would break once fragments move.
        if (u32(moof, tfhd.start + tfhd.hdr) & 0x1) throw new Error("fragments use absolute data offsets");
        if (trackId != null) setU32(moof, tfhd.start + tfhd.hdr + 4, trackId);
        const tfdt = kid(moof, traf, "tfdt");
        if (tfdt && time == null) {
          const o = tfdt.start + tfdt.hdr + 4;
          const t = moof[tfdt.start + tfdt.hdr] === 1 ? u32(moof, o) * 2 ** 32 + u32(moof, o + 4) : u32(moof, o);
          time = t / timescale;
        }
      }
      out.push({ moof, mdat: view(seg, mdat), time });
      i++;
    }
    return out;
  }

  // mvhd with the total duration (and optionally next_track_ID) filled in.
  function patchMvhd(b, box, seconds, nextTrackId) {
    const m = b.slice(box.start, box.end);
    const local = { start: 0, hdr: box.hdr };
    const v1 = m[box.hdr] === 1;
    const tsOff = fieldAfterTimes(m, local);
    const duration = Math.round(seconds * u32(m, tsOff));
    if (v1) {
      setU32(m, tsOff + 4, Math.floor(duration / 2 ** 32));
      setU32(m, tsOff + 8, duration >>> 0);
    } else {
      setU32(m, tsOff + 4, Math.min(duration, 0xffffffff));
    }
    if (nextTrackId != null) setU32(m, m.length - 4, nextTrackId);
    return { box: m, duration };
  }

  // mehd: total fragmented duration, in the movie timescale.
  function mehd(duration) {
    const v1 = duration > 0xffffffff;
    const body = new Uint8Array(v1 ? 12 : 8);
    body[0] = v1 ? 1 : 0;
    if (v1) {
      setU32(body, 4, Math.floor(duration / 2 ** 32));
      setU32(body, 8, duration >>> 0);
    } else {
      setU32(body, 4, duration);
    }
    return makeBox("mehd", [body]);
  }

  // vInit/aInit: init segments (Uint8Array); vSegs/aSegs: media segments.
  // aInit may be null for a silent video. `seconds` is the total length from
  // the playlist: X's init segments say 0, which makes browsers treat the
  // file as a live stream with no seek bar. Returns a Blob.
  XTA.mergeFmp4 = function (vInit, vSegs, aInit, aSegs, seconds) {
    const V = parseInit(vInit);
    if (!V.mvex) throw new Error("stream isn't fragmented (no mvex)");
    const video = vSegs.flatMap((s) => fragments(s, V.timescale, null));
    let frags = video;
    let aTrak = null;
    let aTrex = null;
    let nextTrackId = null;

    if (aInit) {
      const A = parseInit(aInit);
      if (V.tracks !== 1 || A.tracks !== 1) throw new Error("expected one track in each stream");
      const aId = V.trackId + 1;
      aTrak = aInit.slice(A.trak.start, A.trak.end);
      setU32(aTrak, A.idOff - A.trak.start, aId);
      const trexBox = kid(aInit, A.mvex, "trex");
      if (!trexBox) throw new Error("audio stream isn't fragmented (no trex)");
      aTrex = aInit.slice(trexBox.start, trexBox.end);
      setU32(aTrex, trexBox.hdr + 4, aId);
      nextTrackId = aId + 1;

      // Interleave by start time so players don't have to seek far ahead.
      const audio = aSegs.flatMap((s) => fragments(s, A.timescale, aId));
      const keyed = [...video.map((f, i) => [f, f.time ?? i, 0]), ...audio.map((f, i) => [f, f.time ?? i, 1])];
      keyed.sort((x, y) => x[1] - y[1] || x[2] - y[2]);
      frags = keyed.map((k) => k[0]);
    }

    const parts = [];
    let duration = 0;
    for (const k of V.children) {
      if (k.type === "mvex") continue;
      if (k.type === "mvhd") {
        const p = patchMvhd(vInit, k, seconds || 0, nextTrackId);
        duration = p.duration;
        parts.push(p.box);
      } else {
        parts.push(view(vInit, k));
      }
      if (k.type === "trak" && aTrak) {
        parts.push(aTrak);
        aTrak = null;
      }
    }
    const mvexKids = kids(vInit, V.mvex)
      .filter((k) => k.type !== "mehd")
      .map((k) => view(vInit, k));
    parts.push(makeBox("mvex", [...(duration ? [mehd(duration)] : []), ...mvexKids, ...(aTrex ? [aTrex] : [])]));
    const moov = makeBox("moov", parts);

    frags.forEach((f, i) => {
      const mfhd = kid(f.moof, boxes(f.moof)[0], "mfhd");
      if (mfhd) setU32(f.moof, mfhd.start + mfhd.hdr + 4, i + 1); // sequence_number
    });
    const ftyp = V.ftyp ? view(vInit, V.ftyp) : new Uint8Array(0);
    return new Blob([ftyp, moov, ...frags.flatMap((f) => [f.moof, f.mdat])], { type: "video/mp4" });
  };
})();
