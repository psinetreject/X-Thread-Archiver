// Every assumption about X's markup lives here. When X changes its site,
// this is the file to fix.

var XTA = globalThis.XTA || (globalThis.XTA = {});

XTA.SEL = {
  primaryColumn: '[data-testid="primaryColumn"]',
  cell: '[data-testid="cellInnerDiv"]',
  article: "article",
  // Ads carry impression pixels, but so does a post that is also running as
  // an ad; classify() tells them apart by the timestamp. (Not
  // "placementTracking": X also wraps every ordinary video player in that.)
  ad: '[data-testid$="-impression-pixel"]',
  composer: '[role="textbox"], [contenteditable="true"]',
  heading: 'h2, [role="heading"]',
  button: '[role="button"], button',

  userName: '[data-testid="User-Name"]',
  avatar: '[data-testid="Tweet-User-Avatar"] img',
  verified: '[data-testid="icon-verified"]',
  text: '[data-testid="tweetText"]',
  showMore: '[data-testid="tweet-text-show-more-link"]',
  photo: '[data-testid="tweetPhoto"] img',
  video: '[data-testid="videoPlayer"], [data-testid="videoComponent"]',
  card: '[data-testid="card.wrapper"]',
  communityNote: '[data-testid="birdwatch-pivot"]',
  actionBar: '[role="group"][aria-label]',
  progress: '[role="progressbar"]',
  socialContext: '[data-testid="socialContext"]', // "Pinned", "You reposted"

  // Profile pages
  profileName: '[data-testid="UserName"]',
  profileBio: '[data-testid="UserDescription"]',
  profileLocation: '[data-testid="UserLocation"]',
  profileUrl: '[data-testid="UserUrl"]',
  profileJoined: '[data-testid="UserJoinDate"]',
  profileBanner: 'a[href$="/header_photo"] img',
  profileAvatar: '[data-testid^="UserAvatar-Container"] img',
  tabList: '[role="tablist"]',
  userCell: '[data-testid="UserCell"]', // "Who to follow" cards

  // Fixed/floating UI that should never appear in screenshots.
  overlays: [
    '[data-testid="DMDrawer"]',
    '[data-testid="BottomBar"]',
    '[data-testid="toast"]',
  ],
};

// Buttons that reveal more of the conversation in place. Matched on text,
// so this is English-only for now.
XTA.EXPANDER_TEXT = /show (more |additional )?repl|probable spam|show more/i;
// Links into a nested reply thread on its own page.
XTA.BRANCH_TEXT = /show (more )?repl/i;

// A video's cover image and its playlist share a numeric media ID:
//   pbs.twimg.com/amplify_video_thumb/<id>/...  <->  video.twimg.com/amplify_video/<id>/pl/...
XTA.VIDEO_THUMB_ID = /\/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)\//;

XTA.STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/;
// A profile's Posts or Replies tab. The first part must not be one of X's own pages.
XTA.PROFILE_PATH = /^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies))?\/?$/;
XTA.NOT_PROFILES = new Set(
  "home explore notifications messages i settings search compose login logout signup tos privacy jobs communities lists bookmarks premium hashtag account intent share topics jf".split(" "),
);
XTA.profilePath = (pathname) => {
  const m = pathname.match(XTA.PROFILE_PATH);
  return m && !XTA.NOT_PROFILES.has(m[1].toLowerCase()) ? m : null;
};
XTA.STATUS_HREF = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
