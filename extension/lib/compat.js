// Lets the same code run in Firefox and Chrome. Loaded first everywhere: as
// a background script (Firefox), via importScripts (Chrome's service
// worker), before the content scripts, and in the popup.
//
// Firefox provides `browser.*`; Chrome provides `chrome.*` (promise-based in
// MV3 too). Chrome can only pass JSON-like messages and needs listeners to
// answer through sendResponse, so all messaging goes through these helpers.

var XTA = globalThis.XTA || (globalThis.XTA = {});
globalThis.browser ??= globalThis.chrome;

(() => {
  // A listener's error travels back as { __error } and is re-thrown here.
  const unwrap = (r) => {
    if (r && typeof r === "object" && "__error" in r) throw new Error(r.__error);
    return r;
  };

  XTA.send = async (msg) => unwrap(await browser.runtime.sendMessage(msg));
  XTA.sendToTab = async (tabId, msg) => unwrap(await browser.tabs.sendMessage(tabId, msg));

  // `handler(msg, sender)` returns a value or a promise. Every message gets
  // an answer (null if unhandled), which Chrome needs to settle the sender.
  XTA.onMessage = (handler) =>
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      let result;
      try {
        result = handler(msg, sender);
      } catch (e) {
        sendResponse({ __error: e?.message || String(e) });
        return false;
      }
      Promise.resolve(result).then(
        (value) => sendResponse(value ?? null),
        (e) => sendResponse({ __error: e?.message || String(e) }),
      );
      return true;
    });
})();
