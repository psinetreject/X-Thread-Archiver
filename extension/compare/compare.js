// Compares two archive files using the data block each one carries at its end.

const MARK = '<script type="application/json" id="xta-data">';
const $ = (id) => document.getElementById(id);
let lastDiff = null;

const style = document.createElement("style");
style.textContent = XTA.ARCHIVE_CSS;
document.head.prepend(style);

function status(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

// The data sits after all the embedded images, so read the end of the file
// first and only fall back to the whole thing if it's not there.
async function readArchive(file) {
  for (const tail of [8 * 1024 * 1024, Infinity]) {
    const part = tail >= file.size ? file : file.slice(file.size - tail);
    const text = await part.text();
    const start = text.lastIndexOf(MARK);
    if (start !== -1) {
      const end = text.indexOf("</script>", start);
      if (end === -1) break;
      const data = JSON.parse(text.slice(start + MARK.length, end));
      if (!data?.items || !data.captured?.startedAt) break;
      return data;
    }
    if (part === file) break;
  }
  throw new Error(`“${file.name}” isn't an archive made by this add-on.`);
}

function show(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  $("changes").replaceChildren(...doc.body.childNodes);
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const a = $("fileA").files[0];
  const b = $("fileB").files[0];
  if (!a || !b) return;
  status("Reading the archives…");
  $("result").hidden = true;
  try {
    const [x, y] = await Promise.all([readArchive(a), readArchive(b)]);
    const [older, newer] = [x, y].sort((p, q) => p.captured.startedAt.localeCompare(q.captured.startedAt));
    lastDiff = XTA.diffSnapshots(XTA.snapshot(older), XTA.snapshot(newer));
    show(XTA.renderChanges(lastDiff));
    $("result").hidden = false;
    status(
      older.source?.focalId !== newer.source?.focalId
        ? "These archives start from different posts, so many posts may show as new or gone."
        : "",
    );
  } catch (err) {
    status(err.message, "err");
  }
});

$("save").addEventListener("click", () => {
  if (!lastDiff) return;
  const url = URL.createObjectURL(new Blob([XTA.renderReport(lastDiff)], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `x-archive-changes-${(lastDiff.after.capturedAt || "").slice(0, 10)}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});
