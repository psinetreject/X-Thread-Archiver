# Tests

Automated tests for the add-on. They don't touch the real X: a mock X page
(`mock/`) and stand-ins for X's image and video servers answer from
`fixtures/`.

## Run

Needs Node.js 18+ and `openssl` (for the test server's throwaway HTTPS
certificate).

```
cd tests
npm install
npx playwright install firefox chromium
npm test
```

Run one file with `npm run test:unit`, `npm run test:firefox` or
`npm run test:chrome`. Set `DEBUG=1` to see the Chrome capture's progress.

## What each file covers

| File | Browser | What it tests |
|---|---|---|
| `unit.test.js` | Firefox, Node | Reading X's markup, building the archive page, comparing captures, and joining HLS video and audio into one MP4. |
| `firefox.test.js` | Firefox | Full captures with the content scripts running inside the mock page and a stand-in `browser` API (Playwright can't load add-ons into Firefox): branches, long posts, media, the Changes tab, a video-first page, a private window, and a profile (header, Posts and Replies tabs in parts, retrying when X fails, and a re-capture's Changes). |
| `chrome.test.js` | Chromium | A conversation and a profile captured with the real add-on loaded. Chromium is pointed at the test server for x.com and X's media servers, so injection, the service worker, screenshots, video and the downloads all run for real. |

The Chrome test loads a copy of the add-on with `<all_urls>` added, which
stands in for the toolbar click that grants screenshot access.
