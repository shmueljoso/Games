/* ══════════════════════════════════════════════════════════════════════════
   Tech Empire — אימפריית טק
   ---------------------------------------------------------------------------
   Architecture note (read this before editing):

     ENGINE  — pure-ish logic. Reads and writes the single state object `G`.
               Never touches the DOM, never reads the clock, never uses
               Math.random (all randomness flows through the seeded PRNG that
               lives *inside* G, so a save file replays identically).
     UI      — rendering + input. Reads G, calls ENGINE, re-renders. Holds no
               game state of its own beyond ephemeral view flags.

   `G` is a plain JSON-serializable object. G.version + migrateSave() keep old
   saves loadable when the model changes.
   ══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §0 — constants & small helpers
   ═══════════════════════════════════════════════════════════════════════════ */

var SAVE_KEY = 'techEmpire.save.v1';
var VERSION  = 4;               /* bump whenever G's shape changes */
var Y0       = 2026;            /* the sim opens in January 2026 */
var HORIZON  = 120;             /* 10 in-game years */

var MONTHS_HE = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
var lerp  = function (a, b, t) { return a + (b - a) * t; };
var sum   = function (a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; };
var keys  = Object.keys;
var round = function (v, d) { var p = Math.pow(10, d == null ? 1 : d); return Math.round(v * p) / p; };

function hash32(s) {
  var h = 2166136261; s = String(s);
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/* xorshift32 — the seed lives in G so saves are deterministic */
function rand(G) {
  var s = G.rs >>> 0 || 2463534242;
  s ^= s << 13; s >>>= 0;
  s ^= s >> 17;
  s ^= s << 5;  s >>>= 0;
  G.rs = s;
  return s / 4294967296;
}
var rr   = function (G, a, b) { return a + rand(G) * (b - a); };
var ri   = function (G, a, b) { return Math.floor(rr(G, a, b + 1)); };
var pick = function (G, a) { return a[Math.floor(rand(G) * a.length)]; };
/* normal-ish noise without Math.random */
var noise = function (G, sd) { return (rand(G) + rand(G) + rand(G) - 1.5) * 1.4 * (sd || 1); };

var turnY  = function (t) { return Y0 + Math.floor(t / 12); };
var turnM  = function (t) { return ((t % 12) + 12) % 12; };
var dateHe = function (t) { return MONTHS_HE[turnM(t)] + ' ' + turnY(t); };

/* ── §1 components ──────────────────────────────────────────────────────── */
/* One flat catalogue of parts. Categories pick a subset and weight them. */
var PARTS = {
  soc:     { n: 'שבב ראשי',        cost: 78, tech: 'silicon'   },
  display: { n: 'מסך',             cost: 62, tech: 'display'   },
  camera:  { n: 'מערך מצלמות',     cost: 56, tech: 'imaging'   },
  optics:  { n: 'אופטיקה',         cost: 48, tech: 'imaging'   },
  memory:  { n: 'זיכרון ואחסון',   cost: 44, tech: 'materials' },
  battery: { n: 'סוללה וטעינה',    cost: 16, tech: 'power'     },
  sensors: { n: 'חיישנים',         cost: 22, tech: 'materials' },
  audio:   { n: 'מערכת שמע',       cost: 26, tech: 'materials' },
  build:   { n: 'שלדה והרכבה',     cost: 52, tech: 'materials' }
};
var TIER_COST = [0.46, 0.70, 1.00, 1.44, 2.10];   /* cost multiplier per tier 1..5 */
var TIER_Q    = [22,   44,   64,   82,   96  ];   /* quality points per tier 1..5 */
var TIER_NAME = ['בסיסי', 'חסכוני', 'סטנדרטי', 'מתקדם', 'פורץ דרך'];

/* ── Tech packages ───────────────────────────────────────────────────────
   Players do not pick a screw at a time. Components are grouped into four
   packages, each bought as a generation. The engine still reasons per part —
   a package just writes the same tier across the parts it covers.          */
var PKGS = {
  compute: { n: 'פלטפורמת חישוב', parts: ['soc', 'memory'],           tech: 'silicon',   d: 'מעבד, מאיץ בינה וזיכרון. קובע ביצועים ותחושת מהירות.' },
  frame:   { n: 'תצוגה וגימור',   parts: ['display', 'build', 'audio'], tech: 'display',   d: 'מסך, שלדה, חומרים ואודיו. מה שמרגישים ביד.' },
  imaging: { n: 'מערכת הדמיה',    parts: ['camera', 'optics', 'sensors'], tech: 'imaging', d: 'חיישנים, עדשות וחישה. הסעיף שהמבקרים בודקים ראשון.' },
  power:   { n: 'מערך אנרגיה',    parts: ['battery'],                  tech: 'power',     d: 'צפיפות סוללה וטעינה. הסעיף שהמשתמשים מתלוננים עליו.' }
};
var PKG_K = keys(PKGS);
var GEN_NAME = ['דור בסיס', 'דור 2', 'דור 3', 'דור 4', 'דור 5 · פורץ דרך'];

/* Which packages a category actually uses, in display order. */
function pkgsFor(cat) {
  var w = CATS[cat].w;
  return PKG_K.filter(function (k) {
    return PKGS[k].parts.some(function (part) { return w[part] != null; });
  });
}
/* A package's weight in the category = the sum of the parts it covers. */
function pkgWeight(cat, k) {
  var w = CATS[cat].w;
  return sum(PKGS[k].parts.map(function (part) { return w[part] || 0; }));
}
function pkgTier(p, k) {
  var used = PKGS[k].parts.filter(function (part) { return p.spec[part] != null; });
  if (!used.length) return 3;
  return Math.round(sum(used.map(function (part) { return p.spec[part]; })) / used.length);
}
function setPkgTier(p, k, tier) {
  PKGS[k].parts.forEach(function (part) {
    if (p.spec[part] != null) p.spec[part] = clamp(tier, 1, 5);
  });
}
function pkgLabel(cat, k, tier) { return PKGS[k].n + ' · ' + GEN_NAME[clamp(tier, 1, 5) - 1]; }

/* ── §2 product categories ──────────────────────────────────────────────── */
/* base   — installed base worldwide, in millions of live devices
   life   — replacement cycle in months (24–36): the ONLY reason anyone buys
   bands  — how the monthly buyer pool splits across price segments
   ref    — the price the market considers "fair" for a quality-62 device      */
var CATS = {
  phone: {
    n: 'סמארטפונים', short: '', ic: '📱', base: 3600, life: 30, growth: 0.0011, ref: 560, costF: 1.0,
    w: { soc: .22, display: .18, camera: .20, memory: .10, battery: .14, build: .16 },
    bands: { budget: .41, mid: .34, prem: .25 },
    bandRef: { budget: 190, mid: 520, prem: 1080 },
    seas: [.86, .80, .92, .90, .94, .92, .96, 1.02, 1.14, 1.06, 1.18, 1.30]
  },
  laptop: {
    n: 'מחשבים ניידים', short: 'Book', ic: '💻', base: 940, life: 36, growth: 0.0006, ref: 940, costF: 1.85,
    w: { soc: .30, display: .22, memory: .16, battery: .16, build: .16 },
    bands: { budget: .38, mid: .37, prem: .25 },
    bandRef: { budget: 380, mid: 900, prem: 1900 },
    seas: [.84, .80, .90, .88, .92, .96, 1.16, 1.24, 1.06, .96, 1.12, 1.16]
  },
  wearable: {
    n: 'מכשירים לבישים', short: 'Watch', ic: '⌚', base: 820, life: 28, growth: 0.0022, ref: 250, costF: 0.42,
    w: { soc: .20, display: .22, battery: .26, sensors: .14, build: .18 },
    bands: { budget: .46, mid: .32, prem: .22 },
    bandRef: { budget: 65, mid: 240, prem: 520 },
    seas: [.88, .84, .92, .92, .96, .98, .98, 1.00, 1.06, 1.00, 1.20, 1.26]
  },
  audio: {
    n: 'אודיו אישי', short: 'Buds', ic: '🎧', base: 980, life: 24, growth: 0.0018, ref: 130, costF: 0.22,
    w: { soc: .16, audio: .40, battery: .24, build: .20 },
    bands: { budget: .52, mid: .30, prem: .18 },
    bandRef: { budget: 34, mid: 130, prem: 290 },
    seas: [.88, .86, .92, .94, .96, .98, 1.00, 1.02, 1.06, 1.02, 1.16, 1.20]
  },
  xr: {
    n: 'משקפי XR', short: 'Vision', ic: '🥽', base: 44, life: 30, growth: 0.0085, ref: 780, costF: 2.30,
    w: { soc: .24, display: .28, optics: .22, sensors: .14, battery: .12 },
    bands: { budget: .34, mid: .38, prem: .28 },
    bandRef: { budget: 290, mid: 740, prem: 1700 },
    seas: [.86, .82, .90, .90, .94, .96, .98, 1.00, 1.08, 1.02, 1.22, 1.32]
  }
};
var CK = keys(CATS);
var BANDS = ['budget', 'mid', 'prem'];
var BAND_HE = { budget: 'תקציבי', mid: 'ביניים', prem: 'פרימיום' };

/* ── §3 technology domains ──────────────────────────────────────────────── */
var TECH = {
  silicon:   { n: 'סיליקון ועיבוד',  d: 'ביצועים לוואט. משפיע על השבב הראשי.',            heats: ['phone', 'laptop'] },
  display:   { n: 'תצוגה',           d: 'בהירות, קצב רענון, מסכים מתקפלים.',               heats: ['phone', 'laptop', 'xr'] },
  imaging:   { n: 'הדמיה ואופטיקה',  d: 'חיישנים, עדשות, עיבוד תמונה חישובי.',             heats: ['phone', 'xr'] },
  power:     { n: 'אנרגיה',          d: 'צפיפות אנרגיה וטעינה מהירה.',                     heats: ['wearable', 'audio', 'xr'] },
  ai:        { n: 'בינה מלאכותית',   d: 'מודלים על המכשיר. מוסיף ניקוד תוכנה לכל מוצר.',    heats: ['phone', 'laptop', 'wearable'] },
  materials: { n: 'חומרים וייצור',   d: 'תשואת ייצור, עמידות, עלות יחידה.',                heats: ['audio', 'wearable'] }
};
var TK = keys(TECH);

/* ── §4 suppliers (real-world supply chain) ─────────────────────────────── */
var SUPPLIERS = [
  { id: 'tsmc',     n: 'TSMC',              parts: ['soc'],                       q: 1.14, price: 1.20, rel: .97, geo: 'טאיוואן',   cap: 1.00, d: 'הצומת הכי צר בעולם. הכי טוב, הכי יקר, ותור ארוך.' },
  { id: 'samfab',   n: 'Samsung Foundry',   parts: ['soc'],                       q: 0.98, price: 0.90, rel: .90, geo: 'קוריאה',    cap: 0.85, d: 'תשואות פחות יציבות, מחיר נוח, זמינות מיידית.' },
  { id: 'samdisp',  n: 'Samsung Display',   parts: ['display'],                   q: 1.12, price: 1.12, rel: .95, geo: 'קוריאה',    cap: 0.95, d: 'שולטת בפאנלים הגמישים. גם מספקת ליריבות שלכם.' },
  { id: 'lgd',      n: 'LG Display',        parts: ['display'],                   q: 1.01, price: 0.96, rel: .93, geo: 'קוריאה',    cap: 0.80, d: 'איכות גבוהה במחיר שפוי, חזקה במיוחד בפאנלים גדולים.' },
  { id: 'boe',      n: 'BOE',               parts: ['display'],                   q: 0.87, price: 0.74, rel: .84, geo: 'סין',       cap: 1.20, d: 'זולה ורחבה. בקרת איכות היא הימור.' },
  { id: 'sonysens', n: 'Sony Semiconductor',parts: ['camera', 'sensors', 'optics'], q: 1.15, price: 1.16, rel: .96, geo: 'יפן',      cap: 0.90, d: 'חיישני התמונה של חצי מהתעשייה יוצאים מכאן.' },
  { id: 'omni',     n: 'OmniVision',        parts: ['camera', 'sensors'],         q: 0.92, price: 0.80, rel: .89, geo: 'סין־ארה״ב', cap: 0.95, d: 'חלופה סבירה כשהתקציב לא סוגר על סוני.' },
  { id: 'hynix',    n: 'SK Hynix',          parts: ['memory'],                    q: 1.06, price: 1.02, rel: .94, geo: 'קוריאה',    cap: 1.00, d: 'זיכרון מהיר. המחיר תנודתי כמו סחורה.' },
  { id: 'micron',   n: 'Micron',            parts: ['memory'],                    q: 1.00, price: 0.93, rel: .92, geo: 'ארה״ב',     cap: 0.95, d: 'יציבה, מגובה סובסידיות, פחות מובילה טכנולוגית.' },
  { id: 'catl',     n: 'CATL',              parts: ['battery'],                   q: 1.07, price: 0.90, rel: .93, geo: 'סין',       cap: 1.25, d: 'צפיפות אנרגיה מובילה בקנה מידה עצום.' },
  { id: 'tdk',      n: 'TDK',               parts: ['battery', 'audio'],          q: 1.03, price: 1.05, rel: .95, geo: 'יפן',       cap: 0.80, d: 'תאים קטנים ומדויקים לאוזניות ולשעונים.' },
  { id: 'goertek',  n: 'Goertek',           parts: ['audio', 'sensors'],          q: 0.99, price: 0.88, rel: .91, geo: 'סין',       cap: 1.05, d: 'מרכיבה חלק ניכר מהאוזניות והמשקפיים בעולם.' },
  { id: 'foxconn',  n: 'Foxconn',           parts: ['build'],                     q: 1.03, price: 1.00, rel: .94, geo: 'סין־הודו',  cap: 1.60, d: 'קיבולת ההרכבה הגדולה בעולם. גמישות מטורפת בעונת החגים.' },
  { id: 'luxshare', n: 'Luxshare',          parts: ['build', 'audio'],            q: 0.98, price: 0.90, rel: .90, geo: 'סין',       cap: 1.15, d: 'עולה מהר, מוכנה לקחת עבודה שפוקסקון דוחה.' },
  { id: 'pegatron', n: 'Pegatron',          parts: ['build'],                     q: 0.95, price: 0.85, rel: .88, geo: 'טאיוואן',   cap: 0.90, d: 'זולה יותר, פחות מדויקת, נוחה למכשירי נפח.' }
];
var SUP_BY_ID = {};
SUPPLIERS.forEach(function (s) { SUP_BY_ID[s.id] = s; });
function suppliersFor(part) { return SUPPLIERS.filter(function (s) { return s.parts.indexOf(part) >= 0; }); }

/* ── §5 tech creators ───────────────────────────────────────────────────── */
/* reach in millions of subscribers; bias = what this creator actually cares
   about when scoring a device; harsh = how punishing they are about price.   */
var CREATORS = [
  { id: 'mkbhd',  n: 'MKBHD',              reach: 19.4, harsh: .52, bias: { display: .26, camera: .22, build: .16, soft: .20, value: .16 }, d: 'הביקורת הכי מצוטטת בעולם. מדבר על תצוגה, מצלמה וגימור.' },
  { id: 'mwtb',   n: 'Mrwhosetheboss',     reach: 20.1, harsh: .44, bias: { soft: .26, value: .28, display: .16, camera: .16, build: .14 }, d: 'קהל רחב ומיינסטרים. תמורה למחיר מעל הכול.' },
  { id: 'jerry',  n: 'JerryRigEverything', reach: 9.2,  harsh: .30, bias: { build: .62, value: .18, display: .20 },                          d: 'פותח, מכופף, משרט. עמידות ותיקונות זה כל הסיפור.' },
  { id: 'dave2d', n: 'Dave2D',             reach: 4.3,  harsh: .46, bias: { display: .28, soft: .24, value: .24, build: .24 },               d: 'קהל קטן ואיכותי. מסכים ומחשבים ניידים.' },
  { id: 'ltt',    n: 'Linus Tech Tips',    reach: 16.2, harsh: .58, bias: { value: .34, soft: .20, display: .18, camera: .10, build: .18 },  d: 'בודק מפרטים לעומק ומעניש תמחור מנופח.' },
  { id: 'gsm',    n: 'GSMArena',           reach: 6.0,  harsh: .50, bias: { camera: .24, value: .24, display: .20, build: .16, soft: .16 },  d: 'מדידות מעבדה יבשות. משפיע על קונים שקוראים לפני שהם קונים.' }
];

/* ── §6 companies (real-world roster) ───────────────────────────────────── */
/* arch — what the board wants:
     megacap   → margin, dividends, steady growth. Rapid 10x is a *red* flag.
     challenger→ share growth with an eventual path to profit.
     startup   → growth and runway. Losses are expected.
   otherRev — the non-device business ($B/month) that keeps paying regardless:
     services, ads, cloud, B2B components. It shapes what the board tolerates. */
var CO_DEFS = [
  {
    id: 'apple', n: 'Apple', he: 'אפל', tag: 'AAPL', marginTarget: 0.3, arch: 'megacap', playable: 1,
    cash: 58, brand: 95, otherRev: 8.6, capacity: 34, reach: .92, costEff: 1.06, mktEff: 1.15,
    tech: { silicon: 93, display: 74, imaging: 82, power: 60, ai: 64, materials: 82 },
    catBrand: { phone: 96, laptop: 88, wearable: 93, audio: 90, xr: 58 },
    focus: ['phone', 'laptop', 'wearable', 'audio'],
    style: { agg: .30, price: 1.36, rnd: .075, mkt: .050 },
    d: 'המכונה הרווחית ביותר בתעשייה. הדירקטוריון רוצה שוליים, דיבידנד ואפס הפתעות — צמיחה פרועה נחשבת סיכון.'
  },
  {
    id: 'samsung', n: 'Samsung', he: 'סמסונג', tag: '005930', marginTarget: 0.17, arch: 'megacap', playable: 1,
    cash: 74, brand: 79, otherRev: 9.4, capacity: 43, reach: 1.00, costEff: 0.90, mktEff: 1.00,
    tech: { silicon: 74, display: 92, imaging: 70, power: 72, ai: 60, materials: 84 },
    catBrand: { phone: 84, laptop: 62, wearable: 74, audio: 68, xr: 52 },
    focus: ['phone', 'laptop', 'wearable', 'audio'],
    style: { agg: .52, price: 1.06, rnd: .095, mkt: .072 },
    d: 'מאונכת מהשבב ועד המדף: מייצרת מסכים וזיכרון גם למתחרות. יתרון עלות מובנה, ומלחמת נפח בלתי פוסקת.'
  },
  {
    id: 'google', n: 'Google', he: 'גוגל', tag: 'GOOGL', marginTarget: 0.26, arch: 'megacap', playable: 1,
    cash: 92, brand: 76, otherRev: 27.5, capacity: 3.4, reach: .58, costEff: 0.96, mktEff: 1.06,
    tech: { silicon: 68, display: 60, imaging: 86, power: 56, ai: 96, materials: 58 },
    catBrand: { phone: 66, laptop: 54, wearable: 58, audio: 60, xr: 56 },
    focus: ['phone', 'wearable', 'audio'],
    style: { agg: .46, price: .92, rnd: .16, mkt: .085 },
    d: 'הבינה הכי חזקה בשוק על גבי חומרה בנפח זעום. הפרסום מממן הכול, ולכן החומרה נמדדת בהשפעה — לא ברווח.'
  },
  {
    id: 'xiaomi', n: 'Xiaomi', he: 'שיאומי', tag: '1810', marginTarget: 0.055, arch: 'challenger', playable: 1,
    cash: 12, brand: 64, otherRev: 1.4, capacity: 30, reach: .86, costEff: 0.80, mktEff: 0.88,
    tech: { silicon: 56, display: 64, imaging: 66, power: 78, ai: 58, materials: 72 },
    catBrand: { phone: 70, laptop: 52, wearable: 68, audio: 66, xr: 44 },
    focus: ['phone', 'wearable', 'audio', 'laptop'],
    style: { agg: .80, price: .74, rnd: .062, mkt: .048 },
    d: 'מוכרת חומרה כמעט במחיר עלות ומרוויחה מהאקוסיסטם. אם השוליים שלכם עוברים 8% — כנראה תמחרתם גבוה מדי.'
  },
  {
    id: 'sony', n: 'Sony', he: 'סוני', tag: '6758', marginTarget: 0.09, arch: 'challenger', playable: 1,
    cash: 21, brand: 75, otherRev: 6.2, capacity: 2.6, reach: .46, costEff: 1.02, mktEff: 0.82,
    tech: { silicon: 62, display: 76, imaging: 97, power: 60, ai: 58, materials: 78 },
    catBrand: { phone: 58, laptop: 50, wearable: 46, audio: 88, xr: 66 },
    focus: ['phone', 'audio', 'xr'],
    style: { agg: .34, price: 1.18, rnd: .13, mkt: .038 },
    d: 'מותג פרימיום עם נפחי נישה. מוכרת חיישנים לכל התעשייה, כולל למי שמנצח אותה בשוק הטלפונים.'
  },
  {
    id: 'meta', n: 'Meta', he: 'מטא', tag: 'META', marginTarget: 0.2, arch: 'megacap', playable: 1,
    cash: 46, brand: 57, otherRev: 13.8, capacity: 2.2, reach: .50, costEff: 0.94, mktEff: 1.10,
    tech: { silicon: 58, display: 72, imaging: 70, power: 62, ai: 88, materials: 60 },
    catBrand: { phone: 22, laptop: 20, wearable: 54, audio: 48, xr: 86 },
    focus: ['xr', 'wearable', 'audio'],
    style: { agg: .70, price: .68, rnd: .21, mkt: .12 },
    d: 'מסבסדת כל משקף כדי לקנות נתח בפלטפורמה הבאה. הדירקטוריון סופר את ההפסד — ושואל כל רבעון מתי זה נגמר.'
  },
  {
    id: 'microsoft', n: 'Microsoft', he: 'מיקרוסופט', tag: 'MSFT', marginTarget: 0.32, arch: 'megacap', playable: 1,
    cash: 88, brand: 72, otherRev: 22.4, capacity: 3.0, reach: .54, costEff: 0.98, mktEff: 1.02,
    tech: { silicon: 60, display: 66, imaging: 54, power: 58, ai: 90, materials: 64 },
    catBrand: { phone: 18, laptop: 78, wearable: 34, audio: 46, xr: 62 },
    focus: ['laptop', 'xr', 'audio'],
    style: { agg: .40, price: 1.14, rnd: .15, mkt: .062 },
    d: 'הענן מממן הכול, והחומרה קיימת כדי להציג את התוכנה. לוח ניידים חזק, כמעט אפס נוכחות בכיס.'
  },
  {
    id: 'nothing', n: 'Nothing', he: 'נאת׳ינג', tag: '—', marginTarget: -0.14, arch: 'startup', playable: 1,
    cash: 0.95, brand: 44, otherRev: 0.01, capacity: 0.9, reach: .26, costEff: 0.88, mktEff: 1.30,
    tech: { silicon: 34, display: 48, imaging: 46, power: 44, ai: 40, materials: 52 },
    catBrand: { phone: 48, laptop: 24, wearable: 44, audio: 58, xr: 26 },
    focus: ['phone', 'audio', 'wearable'],
    style: { agg: .74, price: .86, rnd: .085, mkt: .105 },
    d: 'סטארטאפ עם עיצוב שגורם לאנשים לדבר ותזרים שנגמר בעוד כמה חודשים. המשקיעים רוצים צמיחה — עכשיו.'
  },

  /* rivals only — not playable */
  { id: 'huawei', n: 'Huawei', he: 'וואווי', tag: '—', arch: 'challenger', playable: 0,
    cash: 24, brand: 63, otherRev: 5.4, capacity: 20, reach: .58, costEff: 0.86, mktEff: 0.9,
    tech: { silicon: 70, display: 74, imaging: 84, power: 76, ai: 72, materials: 76 },
    catBrand: { phone: 72, laptop: 58, wearable: 66, audio: 60, xr: 48 },
    focus: ['phone', 'wearable', 'laptop'], style: { agg: .68, price: 1.02, rnd: .16, mkt: .06 },
    d: 'בנתה שרשרת אספקה עצמאית אחרי הסנקציות, ושולטת בשוק הביתי שלה.' },
  { id: 'oppo', n: 'OPPO', he: 'אופו', tag: '—', arch: 'challenger', playable: 0,
    cash: 8, brand: 56, otherRev: .3, capacity: 24, reach: .74, costEff: .82, mktEff: .86,
    tech: { silicon: 50, display: 66, imaging: 72, power: 84, ai: 52, materials: 68 },
    catBrand: { phone: 64, laptop: 30, wearable: 58, audio: 58, xr: 34 },
    focus: ['phone', 'audio', 'wearable'], style: { agg: .82, price: .80, rnd: .07, mkt: .07 },
    d: 'טעינה מהירה, נוכחות עצומה בחנויות פיזיות בשווקים מתעוררים.' },
  { id: 'lenovo', n: 'Lenovo', he: 'לנובו', tag: '—', arch: 'challenger', playable: 0,
    cash: 6, brand: 58, otherRev: 2.1, capacity: 20, reach: .78, costEff: .84, mktEff: .8,
    tech: { silicon: 52, display: 64, imaging: 48, power: 58, ai: 50, materials: 74 },
    catBrand: { phone: 34, laptop: 82, wearable: 32, audio: 40, xr: 42 },
    focus: ['laptop', 'phone'], style: { agg: .62, price: .86, rnd: .055, mkt: .045 },
    d: 'מספר אחת בניידים לעסקים, עם רשת הפצה שאף אחד לא משחזר.' },
  { id: 'amazon', n: 'Amazon', he: 'אמזון', tag: '—', arch: 'megacap', playable: 0,
    cash: 54, brand: 66, otherRev: 24.0, capacity: 6.0, reach: .82, costEff: .9, mktEff: 1.0,
    tech: { silicon: 54, display: 50, imaging: 52, power: 52, ai: 78, materials: 56 },
    catBrand: { phone: 16, laptop: 22, wearable: 52, audio: 62, xr: 38 },
    focus: ['audio', 'wearable'], style: { agg: .58, price: .60, rnd: .09, mkt: .1 },
    d: 'מוכרת חומרה בהפסד כדי למכור מנויים, ושולטת בערוץ המכירה עצמו.' }
];
var CO_BY_ID = {};
CO_DEFS.forEach(function (c) { CO_BY_ID[c.id] = c; });

/* ── A company of your own ───────────────────────────────────────────────
   Built rather than inherited: almost no cash, no brand anybody recognises,
   one small line, and a board of investors who want to see a hockey stick.
   `raise` lets a creator who crossed over start with the capital their
   channel could actually attract.                                          */
var CUSTOM_ID = 'ownco';
function makeCustomDef(name, o) {
  o = o || {};
  return {
    id: CUSTOM_ID, n: name, he: name, tag: '—', arch: 'startup', playable: 1,
    cash: o.cash != null ? o.cash : 0.55,
    brand: o.brand != null ? o.brand : 14,
    otherRev: o.otherRev || 0,
    capacity: o.capacity != null ? o.capacity : 0.42,
    reach: o.reach != null ? o.reach : 0.12,
    costEff: 0.92, mktEff: o.mktEff != null ? o.mktEff : 1.30,
    marginTarget: -0.20,
    tech: o.tech || { silicon: 24, display: 27, imaging: 25, power: 26, ai: 28, materials: 30 },
    catBrand: o.catBrand || { phone: 14, laptop: 8, wearable: 12, audio: 17, xr: 9 },
    focus: o.focus || ['phone', 'audio'],
    style: { agg: .80, price: .84, rnd: .13, mkt: .15 },
    d: o.d || 'חברה שאתם מקימים מאפס. אין מותג, אין ערוץ הפצה, ויש מסלול מזומן קצר — אבל גם אף אחד לא מחכה מכם לדיבידנד.'
  };
}
/* The custom company lives in the save, so a reload has to put it back on
   the roster before anything looks it up. */
function registerCustom(G) {
  if (G && G.customDef) CO_BY_ID[G.customDef.id] = G.customDef;
  return G;
}

/* ── §7 board archetypes ────────────────────────────────────────────────── */
/* This is the fix for "board wants 10x": a mega-cap board is *unhappy* with a
   wild swing in either direction. Only a startup board rewards a hockey stick. */
var ARCH = {
  megacap: {
    n: 'דירקטוריון של ענקית',
    growth: 0.045,       /* target YoY device-revenue growth */
    tol: 0.35,           /* how much overshoot is tolerated before it reads as risk */
    margin: 0.21,        /* target operating margin */
    marginW: 26,         /* how hard the board leans on that margin */
    runway: 6,           /* months of cash below which panic starts */
    wantsPayout: 1,      /* expects dividend / buyback */
    payoutTarget: 0.22,  /* share of net income returned to holders */
    lossTol: 3,          /* months of losses before it hurts */
    d: 'רוצה שוליים גבוהים, דיבידנד קבוע וצמיחה חד־ספרתית יציבה. זינוק פראי נקרא כאן כסיכון, לא כהצלחה.'
  },
  challenger: {
    n: 'דירקטוריון של מאתגרת',
    growth: 0.115, tol: 0.75, margin: 0.075, marginW: 19, runway: 6, wantsPayout: 0, payoutTarget: 0.05, lossTol: 7,
    d: 'רוצה נתח שוק גדל ומסלול ברור לרווח. מוכן לשוליים דקים כל עוד הנפח עולה.'
  },
  startup: {
    n: 'משקיעי הסטארטאפ',
    growth: 0.34, tol: 2.0, margin: -0.55, marginW: 5, runway: 4, wantsPayout: 0, payoutTarget: 0, lossTol: 30,
    d: 'רוצה צמיחה מהירה ומסלול מזומן של לפחות חצי שנה. הפסדים זה חלק מהתוכנית — קיפאון זה לא.'
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §8 — state construction
   ═══════════════════════════════════════════════════════════════════════════ */

var PROD_WORDS = ['Pro', 'Ultra', 'Air', 'Max', 'Lite', 'Neo', 'Edge', 'Fold', 'Mini', 'Plus'];

function newProduct(G, co, cat, opt) {
  opt = opt || {};
  var C = CATS[cat];
  var spec = {};
  keys(C.w).forEach(function (p) { spec[p] = opt.tier || 3; });
  var pr = {
    id: 'p' + (G.pid++),
    co: co.id,
    cat: cat,
    name: opt.name || (co.n + (CATS[cat].short ? ' ' + CATS[cat].short : '') + ' ' + turnY(G.t)),
    spec: spec,
    price: opt.price || C.ref,
    mkt: opt.mkt || 0,          /* $B per month of marketing */
    mktStock: opt.mktStock || 0,
    prodPlan: opt.prodPlan || 0,/* millions of units per month */
    inv: opt.inv || 0,          /* millions of units in stock */
    price0: opt.price || CATS[cat].ref,
    born: opt.born != null ? opt.born : G.t,
    devLeft: opt.devLeft || 0,  /* months until launch; 0 = live */
    live: opt.devLeft ? 0 : 1,
    dead: 0,
    review: 0,                  /* 0..100, set on launch */
    reviewAge: 99,
    auto: 0,                    /* auto-manage toggle */
    lastShare: 0,
    sold: 0, demand: 0, stockout: 0, rev: 0, unitCost: 0
  };
  return pr;
}

/* A company's total monthly marketing wallet, in $B. Scales with the business
   it actually has, so a startup cannot outspend a mega-cap by wishing. */
function mktBudget(co) {
  return co.style.mkt * Math.max(0.015, co.otherRev * 0.5 + (co.revDev || 0) * 0.7 + 0.06);
}

/* Band identity is real: a budget device is built from budget parts even when
   the company could afford better. R&D leans the mix, it does not break it. */
function specForBand(G, co, p, band, tier) {
  var lo = band === 'budget' ? 1 : (band === 'mid' ? 2 : 3);
  var hi = band === 'budget' ? 3 : (band === 'mid' ? 4 : 5);
  keys(p.spec).forEach(function (part) {
    var lvl = (co.tech[PARTS[part].tech] != null ? co.tech[PARTS[part].tech] : 50);
    p.spec[part] = clamp(Math.round(tier + (lvl - 62) / 30), lo, hi);
  });
}

/* Price from the bill of materials outward, then pulled toward the band's
   reference price. Nobody in this game ships below cost by accident. */
function priceFor(G, co, p, band) {
  var cost = unitCostOf(G, co, p);
  var markup = lerp(1.30, 2.15, clamp((co.style.price - 0.6) / 0.8, 0, 1));
  var want = cost * markup;
  var refP = CATS[p.cat].bandRef[band];
  var price = Math.max(cost * 1.12, want * 0.68 + refP * 0.32 * clamp(co.style.price, .6, 1.4));
  return Math.round(price / 10) * 10;
}

var NAME_BAND = { prem: ['Pro', 'Ultra', 'Max'], mid: ['', 'Plus', 'Neo'], budget: ['Lite', 'SE', 'A'] };
function productName(G, def, cat, band, bi) {
  var head = def.n + (CATS[cat].short ? ' ' + CATS[cat].short : '');
  var suf = NAME_BAND[band][bi % NAME_BAND[band].length];
  return (head + ' ' + suf).replace(/\s+/g, ' ').trim();
}

/* Seed a plausible opening portfolio so month 1 already has a market. */
function seedPortfolio(G, co) {
  var def = CO_BY_ID[co.id];
  def.focus.forEach(function (cat, idx) {
    var C = CATS[cat];
    /* A big brand fields a full ladder in its home category; a startup fields one. */
    var lineups;
    if (def.arch === 'startup') lineups = def.id === CUSTOM_ID ? ['budget'] : ['mid'];
    else if (idx === 0) lineups = def.reach > .55 ? ['prem', 'mid', 'budget'] : ['prem', 'mid'];
    else lineups = def.reach > .55 ? ['mid', 'budget'] : ['mid'];
    if (co.id === 'apple') lineups = idx === 0 ? ['prem', 'prem', 'mid'] : ['prem'];
    lineups.forEach(function (band, bi) {
      var tier = band === 'prem' ? 4 : (band === 'mid' ? 3 : 2);
      var p = newProduct(G, co, cat, {
        name: productName(G, def, cat, band, bi),
        tier: tier,
        born: G.t - ri(G, 2, 14)
      });
      specForBand(G, co, p, band, tier);
      p.price = priceFor(G, co, p, band); p.price0 = p.price;
      p.review = clamp(52 + (def.brand - 62) * .4 + noise(G, 6), 20, 92);
      p.reviewAge = G.t - p.born;
      p.mkt = mktBudget(co) * (band === 'prem' ? .34 : .20);
      p.mktStock = p.mkt * 4;
      G.prods.push(p);
    });
  });
}

function newGame(coId, seedStr, mode, opts) {
  var seed = seedStr || ('e' + Math.floor(Math.random() * 1e9));
  var G = {
    version: VERSION,
    rs: hash32(seed), seed: seed,
    mode: mode || 'ceo',
    t: 0, over: false, ending: null,
    horizon: HORIZON,   /* crossing over from a channel buys a second act */
    pid: 1,
    me: coId,
    cos: {},
    prods: [],
    market: {},
    world: { demandMult: 1, costMult: 1, rateMult: 1, mood: 'יציב' },
    disrupt: {},        /* supplierId -> { m: months left, f: capacity factor } */
    log: [],            /* newsfeed, newest first */
    report: null,       /* last month-end report */
    hist: { t: [], cash: [], rev: [], profit: [], share: [], brand: [], mood: [] },
    board: { mood: 62, warnings: 0, payout: 0, lastNote: '' },
    fin: { revDev: 0, revOther: 0, cogs: 0, opex: 0, rnd: 0, mkt: 0, capex: 0, net: 0, netTTM: [] },
    plan: { rnd: {}, capexQueue: [], payout: 0 },
    contracts: {},
    talent: null,      /* { market: [...], seq } — the current shortlist */
    cheats: {},
    customDef: null,
    creatorPast: null,   /* the channel you came from, once you cross over */
    creator: null,
    seenTips: {}
  };

  /* a company of the player's own joins the roster before anything is built */
  if (opts && opts.custom) {
    G.customDef = makeCustomDef(opts.custom.name, opts.custom);
    registerCustom(G);
  }
  var roster = CO_DEFS.concat(G.customDef ? [G.customDef] : []);

  /* companies — the player is simulated by the exact same code as the rivals */
  roster.forEach(function (d) {
    var c = {
      id: d.id, n: d.n, he: d.he, tag: d.tag, arch: d.arch,
      cash: d.cash, brand: d.brand, otherRev: d.otherRev,
      capacity: d.capacity, capBuild: [],
      reach: d.reach, costEff: d.costEff, mktEff: d.mktEff,
      tech: JSON.parse(JSON.stringify(d.tech)),
      catBrand: JSON.parse(JSON.stringify(d.catBrand)),
      style: d.style,
      brand0: d.brand,
      installed: {},      /* live devices of ours still in people's hands, per category */
      staff: [],          /* poached key talent */
      revDev: 0, revLast: 0, rev12: [], profit: 0, share: {}, units: 0,
      rndSpend: 0, debt: 0, ai: d.id !== coId ? 1 : 0
    };
    TK.forEach(function (k) { if (c.tech[k] == null) c.tech[k] = 42; });
    G.cos[d.id] = c;
  });

  /* markets */
  CK.forEach(function (k) {
    G.market[k] = { base: CATS[k].base, heat: 50 + (k === 'xr' ? 12 : 0), trend: 0, pool: 0, sold: 0, shares: {} };
  });

  /* portfolios */
  roster.forEach(function (d) { seedPortfolio(G, G.cos[d.id]); });
  G.prods.forEach(function (p) {
    /* opening production lines roughly match opening demand */
    p.prodPlan = 0; p.inv = 0;
  });

  /* player defaults */
  var me = G.cos[coId] || G.cos.apple;
  keys(PARTS).forEach(function (part) {
    var opts = suppliersFor(part);
    if (opts.length) G.contracts[part] = opts[Math.floor(opts.length / 2)].id;
  });
  G.plan.payout = ARCH[me.arch].payoutTarget;
  G.board.payout = G.plan.payout;

  if (G.mode === 'creator') { G.me = ''; G.creator = newCreator(G, coId); }

  /* prime one silent month so opening numbers are real, not zeros */
  marketTick(G);
  distributeAll(G, true);
  G.prods.forEach(function (p) { p.prodPlan = round(p.demand * 1.02, 3); p.inv = round(p.demand * .35, 3); });

  /* everyone arrives with an installed base already in people's hands */
  keys(G.cos).forEach(function (id) {
    var co = G.cos[id];
    CK.forEach(function (k) {
      co.installed[k] = (G.market[k].shares[id] || 0) * G.market[k].base * rr(G, .85, 1.0);
    });
  });

  /* now that demand is known, size the opening R&D plan to the real business */
  var estRev = sum(G.prods.filter(function (p) { return p.co === G.me; })
    .map(function (p) { return p.demand * p.price / 1000; }));
  var rndBudget = me.style.rnd * Math.max(0.015, me.otherRev * 0.6 + estRev * 0.9 + 0.03);
  TK.forEach(function (k) { G.plan.rnd[k] = round(rndBudget / TK.length, 4); });
  if (G.mode === 'creator') primeCreator(G); else primeFinancials(G);
  pushLog(G, 'ℹ️', 'התעשייה נכנסת ל־' + Y0 + '. ' + (G.mode === 'creator' ? 'הערוץ עולה לאוויר.' : 'הדירקטוריון מחכה לרבעון הראשון שלכם.'));
  return G;
}

/* Fill in an opening snapshot from the primed demand so month one shows the
   business as it actually stands. Nothing here moves cash — it is a read of
   the position the player is inheriting, not a turn that was played. */
function primeFinancials(G) {
  var me = G.cos[G.me];
  if (!me) return;
  var mine = G.prods.filter(function (p) { return p.co === G.me && p.live && !p.dead; });
  var revDev = 0, cogs = 0;
  mine.forEach(function (p) {
    p.sold = p.demand;
    p.unitCost = unitCostOf(G, me, p);
    p.rev = p.sold * p.price / 1000;
    revDev += p.rev;
    cogs += p.sold * p.unitCost / 1000;
  });
  var mkt = sum(mine.map(function (p) { return p.mkt || 0; }));
  var rnd = sum(TK.map(function (k) { return G.plan.rnd[k] || 0; }));
  var opex = (revDev + me.otherRev) * 0.170 + me.capacity * 0.012;
  var net = revDev + me.otherRev - cogs - mkt - rnd - opex;
  me.revDev = revDev;
  me.rev0 = revDev;          /* the line a later stage is measured against */
  me.rev12 = [revDev];
  G.fin = {
    revDev: revDev, revOther: me.otherRev, prodCost: cogs, hold: 0, writeoff: 0,
    mkt: mkt, rnd: rnd, opex: opex, capex: 0, payout: 0, net: net,
    margin: (revDev + me.otherRev) > 0 ? net / (revDev + me.otherRev) : 0, netTTM: [net]
  };
  var totShare = sum(CK.map(function (c) { return (G.market[c].shares[G.me] || 0) * G.market[c].pool * CATS[c].ref; }));
  var totAll = sum(CK.map(function (c) { return G.market[c].pool * CATS[c].ref; }));
  me.shareVal = totAll > 0 ? totShare / totAll : 0;
  G.tick = { units: sum(mine.map(function (p) { return p.sold; })), stockoutUnits: 0, prodCost: cogs, holdCost: 0, revDev: revDev, capCrunch: 0 };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §9 — product mathematics
   ═══════════════════════════════════════════════════════════════════════════ */

/* Quality of one component, 0..100. Tier sets the floor, the supplier scales
   it, and the company's R&D in the matching domain adds headroom. */
function partQuality(G, co, part, tier, contracts) {
  var base = TIER_Q[clamp(tier, 1, 5) - 1];
  var sup = SUP_BY_ID[(contracts || {})[part]];
  var sq = sup ? sup.q : 1.0;
  var dom = PARTS[part].tech;
  var lvl = co.tech[dom] || 40;
  /* R&D can lift a component by up to ~16 points; it cannot conjure a tier */
  return clamp(base * sq + (lvl - 55) * 0.30, 4, 100);
}

function contractsOf(G, co) {
  if (co.id === G.me) return G.contracts;
  return aiContracts(co);
}
/* Rivals keep a stable, archetype-flavoured supplier mix. */
var AI_CONTRACT_CACHE = {};
function aiContracts(co) {
  if (AI_CONTRACT_CACHE[co.id]) return AI_CONTRACT_CACHE[co.id];
  var out = {};
  keys(PARTS).forEach(function (part) {
    var opts = suppliersFor(part);
    if (!opts.length) return;
    var want = co.style.price;   /* premium companies buy premium parts */
    var best = opts[0], bestD = 9;
    opts.forEach(function (s) { var d = Math.abs(s.price - want); if (d < bestD) { bestD = d; best = s; } });
    out[part] = best.id;
  });
  AI_CONTRACT_CACHE[co.id] = out;
  return out;
}

function qualityOf(G, co, p) {
  var C = CATS[p.cat], ctr = contractsOf(G, co), q = 0;
  keys(C.w).forEach(function (part) {
    q += C.w[part] * partQuality(G, co, part, p.spec[part] || 3, ctr);
  });
  /* software layer: AI research lifts every device the company ships */
  var soft = (co.tech.ai - 50) * 0.13;
  return clamp(q + soft, 3, 100);
}

/* Bill of materials, in dollars per unit. */
function unitCostOf(G, co, p) {
  var C = CATS[p.cat], ctr = contractsOf(G, co), c = 0;
  keys(C.w).forEach(function (part) {
    var sup = SUP_BY_ID[ctr[part]];
    var pm = sup ? sup.price : 1.0;
    c += PARTS[part].cost * TIER_COST[clamp(p.spec[part] || 3, 1, 5) - 1] * pm;
  });
  c *= C.costF * co.costEff * G.world.costMult;
  /* manufacturing learning curve: an old line is a cheap line */
  var age = G.t - p.born;
  c *= clamp(1.10 - Math.min(age, 24) * 0.0055, 0.86, 1.10);
  return c;
}

/* What the market thinks a device of this quality is worth. Superlinear:
   the last few quality points are what people pay a real premium for. */
function fairPrice(G, p, q) {
  var C = CATS[p.cat];
  return C.ref * Math.pow(clamp(q, 8, 100) / 62, 1.72);
}

/* Freshness — a device decays across its category lifecycle, and that decay is
   the only thing that ever forces a refresh. Bounded, never negative. */
function freshnessOf(G, p) {
  var life = CATS[p.cat].life;
  var age = G.t - p.born;
  return clamp(0.34 + 0.78 * Math.exp(-Math.max(0, age) / (life * 0.46)), 0.32, 1.12);
}

/* Hype, 0..100. Marketing has *diminishing* returns and cannot run away:
   ad-stock saturates. Category heat pushes everyone in the category at once. */
function hypeOf(G, co, p) {
  var C = CATS[p.cat];
  /* Saturation scales with how big and how expensive the audience is, so
     buying attention in phones costs far more than buying it in earbuds. */
  var scale = 3.0 * Math.max(0.12, G.market[p.cat].pool / 100) * Math.pow(Math.max(30, p.price) / 300, 0.55);
  var ads = 42 * (1 - Math.exp(-p.mktStock / Math.max(0.05, scale))) * co.mktEff;
  var rev = p.reviewAge < 12 ? (p.review - 50) * 0.52 * Math.exp(-p.reviewAge / 9) : 0;
  var heat = (G.market[p.cat].heat - 50) * 0.24;
  var launch = (G.t - p.born) < 3 ? 12 - (G.t - p.born) * 4 : 0;
  return clamp(30 + ads + rev + heat + launch, 0, 100);
}

/* ── the Product Score: 0..100, everything the buyer weighs ─────────────── */
function scoreOf(G, co, p) {
  var q = qualityOf(G, co, p);
  var fair = fairPrice(G, p, q);
  /* logistic value curve — 50 at a fair price, saturating both ways */
  var value = 100 / (1 + Math.exp((p.price / Math.max(1, fair) - 1) * 3.1));
  var hype = hypeOf(G, co, p);
  var brand = 0.52 * co.brand + 0.48 * (co.catBrand[p.cat] || 40);
  var s = 0.32 * q + 0.24 * value + 0.19 * hype + 0.25 * brand;
  s *= freshnessOf(G, p);
  return clamp(s, 1, 100);
}

/* How well a price sits inside a band. Log-gaussian, so a $1,200 flagship
   simply does not appear in the budget shelf at all. */
function bandFit(p, cat, band) {
  var c = CATS[cat].bandRef[band];
  var x = Math.log(Math.max(5, p.price) / c);
  return Math.exp(-(x * x) / (2 * 0.42 * 0.42));
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §10 — market: pool sizing and demand distribution
   ═══════════════════════════════════════════════════════════════════════════ */

/* The purchasing pool is a *fraction* of the installed base — only the cohort
   whose device reached end of life this month, nudged by season, heat and the
   macro picture. This is the ceiling that stops any exponential run. */
function marketTick(G) {
  var m12 = turnM(G.t);
  CK.forEach(function (k) {
    var m = G.market[k], C = CATS[k];
    m.base *= (1 + C.growth + m.trend);
    /* the installed base moves, but a global device base does not double in a
       year no matter how exciting the technology gets */
    m.base = clamp(m.base, C.base * 0.70, C.base * (k === 'xr' ? 7.0 : 1.34));
    m.trend = clamp(m.trend * 0.80, -0.0035, 0.0035);                       /* event-driven trends fade */
    m.heat = clamp(50 + (m.heat - 50) * 0.90, 6, 100);  /* heat always decays home */
    var heatF = 0.86 + 0.30 * (m.heat / 100);
    m.pool = (m.base / C.life) * C.seas[m12] * heatF * G.world.demandMult;
  });
}

function liveProducts(G, cat) {
  var out = [];
  for (var i = 0; i < G.prods.length; i++) {
    var p = G.prods[i];
    if (p.live && !p.dead && p.cat === cat) out.push(p);
  }
  return out;
}

/* Proportional share inside each price band. No unbounded multipliers: every
   product's weight is score^K × band fit × distribution reach, then normalised.
   A slice of last month's share is carried over so demand has inertia. */
var SHARE_K = 2.05;
function distributeAll(G, priming) {
  CK.forEach(function (cat) {
    var m = G.market[cat];
    var ps = liveProducts(G, cat);
    m.shares = {};
    ps.forEach(function (p) { p.demand = 0; });
    if (!ps.length) { m.sold = 0; return; }

    var scores = ps.map(function (p) { return scoreOf(G, G.cos[p.co], p); });
    BANDS.forEach(function (band) {
      var poolB = m.pool * CATS[cat].bands[band];
      var w = ps.map(function (p, i) {
        var co = G.cos[p.co];
        var eco = 1 + ECO_MAX * ecoPull(G, co, cat);
        return Math.pow(scores[i], SHARE_K) * bandFit(p, cat, band) * (0.45 + 0.55 * co.reach) * eco;
      });
      var tot = sum(w);
      if (tot <= 0) return;
      for (var i = 0; i < ps.length; i++) {
        var raw = w[i] / tot;
        /* inertia: shelves, carriers and habits move slower than spec sheets */
        var prev = ps[i].lastShare || raw;
        var sh = priming ? raw : (0.74 * raw + 0.26 * prev);
        ps[i].demand += poolB * sh;
      }
    });

  });

  capacityCap(G);

  CK.forEach(function (cat) {
    var m = G.market[cat], ps = liveProducts(G, cat);
    var totD = sum(ps.map(function (p) { return p.demand; }));
    m.shares = {};
    ps.forEach(function (p) {
      p.lastShare = totD > 0 ? p.demand / totD : 0;
      m.shares[p.co] = (m.shares[p.co] || 0) + p.demand;
    });
    m.sold = totD;
    keys(m.shares).forEach(function (id) { m.shares[id] = totD > 0 ? m.shares[id] / totD : 0; });
  });
}

/* ── Ecosystem lock-in ───────────────────────────────────────────────────
   Somebody already carrying your phone is markedly more likely to buy your
   watch next. `installed` tracks the devices of ours still in people's hands
   per category; the pull a company gets in one category is drawn from the
   base it holds in all the *others*, so a coherent product family compounds
   and a lone flagship does not.                                            */
function ecoPull(G, co, cat) {
  var num = 0, den = 0;
  CK.forEach(function (k) {
    if (k === cat) return;
    var base = G.market[k].base;
    if (base <= 0) return;
    var w = CATS[k].base;
    num += w * clamp((co.installed[k] || 0) / base, 0, 1);
    den += w;
  });
  if (den <= 0) return 0;
  /* diminishing: the first slice of an ecosystem is worth the most */
  return Math.pow(clamp(num / den, 0, 1), 0.6);
}
var ECO_MAX = 0.40;   /* a total ecosystem lock is worth +40% weight */

/* Devices age out of people's hands at the category's replacement rate. */
function ecosystemTick(G) {
  keys(G.cos).forEach(function (id) {
    var co = G.cos[id];
    co.installed = co.installed || {};
    CK.forEach(function (k) {
      var sold = sum(G.prods.filter(function (p) { return p.co === id && p.cat === k; })
        .map(function (p) { return p.sold || 0; }));
      co.installed[k] = Math.max(0, (co.installed[k] || 0) * (1 - 1 / CATS[k].life) + sold);
    });
  });
}

/* Demand a company physically cannot serve is not demand. A firm with two
   million units of line time never books twenty million units of intent — the
   overflow moves to whoever still has a factory, and a quarter of it evaporates
   because the buyer simply bought something else that week. */
function capacityCap(G) {
  var byCo = {};
  G.prods.forEach(function (p) { if (p.live && !p.dead) (byCo[p.co] = byCo[p.co] || []).push(p); });
  var capped = {};
  keys(byCo).forEach(function (id) {
    var need = sum(byCo[id].map(function (p) { return p.demand * LINE_USE[p.cat]; }));
    var cap = effectiveCapacity(G, G.cos[id]) * 1.12;   /* a line can be stretched, not tripled */
    if (need > cap && need > 0) {
      var s = cap / need;
      capped[id] = 1;
      byCo[id].forEach(function (p) { p.spill = p.demand * (1 - s); p.demand *= s; });
    }
  });
  CK.forEach(function (cat) {
    var ps = liveProducts(G, cat);
    var spill = sum(ps.map(function (p) { return p.spill || 0; }));
    if (spill > 0) {
      var head = ps.filter(function (p) { return !capped[p.co]; });
      var tot = sum(head.map(function (p) { return p.demand; }));
      if (tot > 0) head.forEach(function (p) { p.demand += spill * 0.75 * p.demand / tot; });
    }
    ps.forEach(function (p) { p.spill = 0; });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §11 — production, inventory and capacity
   ═══════════════════════════════════════════════════════════════════════════ */

/* One unit of "line time" is a phone. A headset eats far more of the factory. */
var LINE_USE = { phone: 1.0, laptop: 2.15, wearable: 0.55, audio: 0.30, xr: 2.60 };
var CAPEX_PER_LINE = 1.25;   /* $B to add 1M phone-equivalents/month, at scale */
var CAPEX_MONTHS = 6;

/* A small top-up is contract capacity at somebody else's plant: cheap, and it
   comes online in a quarter. A large block is a line of your own, which costs
   the full rate and takes half a year. That on-ramp is what makes a company
   with no balance sheet able to grow at all. */
function capexQuote(add) {
  var rate = CAPEX_PER_LINE * clamp(0.34 + add / 6, 0.34, 1.55);
  var months = add < 1 ? 3 : CAPEX_MONTHS;
  return { total: round(add * rate, 4), months: months, contract: add < 1 };
}
var HOLD_RATE = 0.014;       /* monthly carrying cost, share of unit cost */
var WRITEOFF = 0.55;         /* how much of a dead unit's cost is lost forever */

function effectiveCapacity(G, co) {
  var dis = 1;
  var ctr = contractsOf(G, co);
  var asm = SUP_BY_ID[ctr.build];
  if (asm) dis *= (0.72 + 0.28 * asm.cap * 1.15);
  if (co.disruptM > 0) dis *= co.disruptF || 0.8;
  return Math.max(0.02, co.capacity * dis);
}

/* Auto-Manage: the QoL toggle. An older product quietly slides down the price
   ladder, its marketing is cut, and its line is matched to real demand — so a
   long tail stops silently burning cash while you look elsewhere. */
/* Nothing discounts to cost. A device bottoms out somewhere above its BOM and
   never far below what it launched at — that floor is what keeps a long tail
   from quietly turning every sale into a loss. */
function priceFloor(G, co, p) {
  return Math.max(unitCostOf(G, co, p) * 1.18, (p.price0 || p.price) * 0.55);
}

function autoManage(G, p) {
  if (!p.auto || !p.live || p.dead) return;
  var co = G.cos[p.co];
  var age = G.t - p.born;
  var floor = priceFloor(G, co, p);
  if (age >= 5) p.price = Math.max(floor, p.price * (age > 14 ? 0.972 : 0.986));
  p.mkt = p.mkt * (age > 9 ? 0.84 : 0.94);
  if (p.mkt < 0.0006) p.mkt = 0;
  p.prodPlan = Math.max(0, p.demand * 1.02 - p.inv * 0.5);
  /* relative to its own best month, so a niche product is not culled merely
     for being niche */
  if (age > CATS[p.cat].life * 0.7 && (p.sold || 0) < (p.peakSold || 0) * 0.10) p.dead = 1;
}

/* AI rivals plan production against their own forecast, with archetype bias:
   aggressive firms over-build (and eat dead stock), cautious ones under-build. */
function aiProductionPlan(G, co, p) {
  var bias = 0.94 + co.style.agg * 0.22;
  return Math.max(0, p.demand * bias - p.inv * 0.45);
}

function produceAndSell(G) {
  var byCo = {};
  G.prods.forEach(function (p) {
    if (!p.live || p.dead) return;
    (byCo[p.co] = byCo[p.co] || []).push(p);
  });

  G.tick = { prodCost: 0, holdCost: 0, revDev: 0, units: 0, stockoutUnits: 0, deadUnits: 0, capCrunch: 0 };

  keys(G.cos).forEach(function (id) {
    var co = G.cos[id];
    var ps = byCo[id] || [];
    co.units = 0; co.revDev = 0;
    if (!ps.length) return;

    var plans = ps.map(function (p) {
      return id === G.me ? Math.max(0, p.prodPlan || 0) : aiProductionPlan(G, co, p);
    });
    /* capacity is measured in line time, not raw units */
    var need = sum(ps.map(function (p, i) { return plans[i] * LINE_USE[p.cat]; }));
    var cap = effectiveCapacity(G, co);
    var scale = need > cap && need > 0 ? cap / need : 1;
    if (id === G.me && scale < 0.995) G.tick.capCrunch = 1 - scale;

    ps.forEach(function (p, i) {
      var made = plans[i] * scale;
      var cost = unitCostOf(G, co, p);
      p.unitCost = cost;
      var avail = p.inv + made;
      var sold = Math.min(p.demand, avail);
      p.stockout = Math.max(0, p.demand - avail);
      p.inv = Math.max(0, avail - sold);
      p.sold = sold;
      p.peakSold = Math.max(p.peakSold || 0, sold);
      p.made = made;
      p.rev = sold * p.price / 1000;            /* units are millions → $B */
      co.units += sold;
      co.revDev += p.rev;
      if (id === G.me) {
        G.tick.prodCost += made * cost / 1000;
        G.tick.holdCost += p.inv * cost * HOLD_RATE / 1000;
        G.tick.revDev += p.rev;
        G.tick.units += sold;
        G.tick.stockoutUnits += p.stockout;
      }
      /* running out of stock costs you more than the sale: it costs the hype */
      if (p.stockout > p.demand * 0.12) p.mktStock *= 0.94;
    });
  });
}

/* End-of-life inventory is written off. This is the dead-stock penalty. */
function retireProducts(G) {
  G.prods.forEach(function (p) {
    if (p.dead || !p.live) return;
    var age = G.t - p.born;
    var life = CATS[p.cat].life;
    /* nothing stays on the shelf forever: a generation ends on age alone,
       and a product nobody is buying ends sooner */
    if (age > life * 1.5 || (age > life * 0.9 && (p.sold || 0) < (p.peakSold || 0) * 0.08)) {
      p.dead = 1;
      var loss = p.inv * (p.unitCost || 0) * WRITEOFF / 1000;
      if (p.co === G.me && p.inv > 0.001) {
        G.tick.deadUnits += p.inv;
        G.tick.writeoff = (G.tick.writeoff || 0) + loss;
        pushLog(G, '📦', 'הפסקנו את ' + p.name + '. נמחקו ' + fmtU(p.inv) + ' יחידות מלאי בהפסד של ' + fmtM(loss) + '.');
      }
      p.inv = 0;
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §12 — reviews
   ═══════════════════════════════════════════════════════════════════════════ */

function traitsOf(G, co, p) {
  var ctr = contractsOf(G, co), C = CATS[p.cat];
  var g = function (part) {
    if (C.w[part] == null) return 46;
    return partQuality(G, co, part, p.spec[part] || 3, ctr);
  };
  var q = qualityOf(G, co, p);
  var fair = fairPrice(G, p, q);
  return {
    display: g('display'),
    camera: Math.max(g('camera'), g('optics'), g('sensors') * 0.9),
    build: g('build') * 0.75 + (co.tech.materials || 50) * 0.25,
    soft: clamp((co.tech.ai || 40) * 0.8 + co.brand * 0.2, 5, 100),
    value: 100 / (1 + Math.exp((p.price / Math.max(1, fair) - 1) * 3.1)),
    fairRatio: p.price / Math.max(1, fair)
  };
}

function runReviews(G, co, p) {
  var tr = traitsOf(G, co, p);
  var wsum = 0, ssum = 0, best = null, bestS = -1;
  var press = co.id === G.me ? (G.plan.press || 0) : (co.style.mkt > .08 ? 1 : 0);
  CREATORS.forEach(function (cr) {
    var s = 0, w = 0;
    keys(cr.bias).forEach(function (k) { s += cr.bias[k] * (tr[k] != null ? tr[k] : 50); w += cr.bias[k]; });
    s = s / Math.max(0.01, w);
    s -= cr.harsh * (tr.fairRatio - 1) * 46;          /* overpriced gets punished */
    s += press * 2.2;                                  /* early-access goodwill */
    if (G.creator && G.creator.rel && G.creator.rel[cr.id]) s += 0;
    s += noise(G, 5.5);
    s = clamp(s, 4, 99);
    p.rev_by = p.rev_by || {};
    p.rev_by[cr.id] = Math.round(s) / 10;
    ssum += s * cr.reach; wsum += cr.reach;
    if (s > bestS) { bestS = s; best = cr; }
  });
  p.review = clamp(ssum / wsum, 4, 99);
  p.reviewAge = 0;
  return { score: p.review, top: best };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §13 — R&D and breakthroughs
   ═══════════════════════════════════════════════════════════════════════════ */

function aiRndPlan(G, co) {
  var budget = co.style.rnd * Math.max(0.015, co.otherRev * 0.6 + (co.revDev || 0) * 0.9 + 0.03);
  var out = {}, tot = 0;
  TK.forEach(function (k) { var w = 0.5 + (co.tech[k] || 40) / 120; out[k] = w; tot += w; });
  TK.forEach(function (k) { out[k] = budget * out[k] / tot; });
  return out;
}

function rndTick(G) {
  keys(G.cos).forEach(function (id) {
    var co = G.cos[id];
    var plan = id === G.me ? G.plan.rnd : aiRndPlan(G, co);
    var spent = 0;
    TK.forEach(function (k) {
      var b = Math.max(0, plan[k] || 0);
      spent += b;
      var lvl = co.tech[k] || 0;
      /* a domain with a star in it converts budget into progress faster */
      var star = 1;
      (co.staff || []).forEach(function (t) { if (t.role === k) star += 0.22; });
      var gain = b * 2.4 * star / (1 + Math.pow(lvl / 22, 1.6));
      var before = lvl;
      co.tech[k] = clamp(lvl + gain, 0, 98);
      /* every 10 levels above 50 is a public breakthrough that heats a market */
      var b0 = Math.floor(before / 10), b1 = Math.floor(co.tech[k] / 10);
      /* only a move at the industry frontier is news the market reacts to */
      if (b1 > b0 && co.tech[k] >= 60 && co.tech[k] >= frontier(G, k) - 1.5) breakthrough(G, co, k, b1 * 10);
    });
    co.rndSpend = spent;
  });
}

function frontier(G, k) {
  var m = 0;
  for (var id in G.cos) { var v = G.cos[id].tech[k] || 0; if (v > m) m = v; }
  return m;
}

function breakthrough(G, co, k, lvl) {
  var T = TECH[k];
  var mag = 6 + (lvl - 50) * 0.42;
  T.heats.forEach(function (cat) {
    G.market[cat].heat = clamp(G.market[cat].heat + mag * rr(G, .7, 1.25), 6, 100);
    G.market[cat].trend = clamp(G.market[cat].trend + 0.0004 * (mag / 10), -0.0035, 0.0035);
  });
  co.brand = clamp(co.brand + 0.55, 5, 100);
  var mine = co.id === G.me;
  pushLog(G, '🔬', (mine ? 'המעבדות שלנו' : co.n) + ' חצו רף ב' + T.n + ' (' + lvl + '). ' +
    'קטגוריות ' + T.heats.map(function (c) { return CATS[c].n; }).join(', ') + ' מתחממות.', mine ? 'good' : '');
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §13b — key talent
   Money alone does not buy a decade of silicon experience. Poaching a named
   person moves a tech domain immediately, speeds its research while they
   stay, and takes the same capability away from whoever lost them.
   ═══════════════════════════════════════════════════════════════════════════ */

var ROLES = {
  ai:        { n: 'ראש/ת חזון בינה מלאכותית', d: 'בנתה מודלים שרצים על המכשיר עצמו.' },
  silicon:   { n: 'ארכיטקט/ית שבבים ראשי/ת',  d: 'הובילה שלושה דורות של מעבדים.' },
  display:   { n: 'מוביל/ת טכנולוגיית תצוגה', d: 'הביאה פאנלים מתקפלים לייצור המוני.' },
  imaging:   { n: 'ראש/ת הדמיה חישובית',      d: 'חתומה על הפטנטים שמאחורי מצב הלילה.' },
  power:     { n: 'מהנדס/ת אנרגיה ראשי/ת',    d: 'העלתה צפיפות אנרגיה בשליש בלי לשנות נפח.' },
  materials: { n: 'מעצב/ת חומרה ראשי/ת',      d: 'הפכה תשואות ייצור לבעיה פתורה.' }
};
var TALENT_FN = ['נועה', 'איתי', 'מאיה', 'יונתן', 'שירה', 'עומר', 'דניאל', 'ליאור', 'רותם', 'הילה',
  'Wei', 'Ji-woo', 'Hana', 'Arjun', 'Priya', 'Sofia', 'Marcus', 'Lena', 'Kenji', 'Ines'];
var TALENT_LN = ['ברקוביץ׳', 'חן', 'נאקאמורה', 'אוקונקוו', 'פארק', 'זילברמן', 'טאן', 'מוראלס',
  'אבו־חסן', 'לינדגרן', 'קומאר', 'דה־סילבה', 'וונג', 'אשכנזי', 'פטרוב', 'אוקאדה'];

function talentName(G) { return pick(G, TALENT_FN) + ' ' + pick(G, TALENT_LN); }

/* The shortlist refreshes every few months; people you did not hire move on. */
function genTalent(G) {
  G.talent = G.talent || { market: [], seq: 1 };
  var pool = [];
  var n = 3;
  for (var i = 0; i < n; i++) {
    /* a star comes from whoever is actually strong in that domain */
    var dom = pick(G, TK);
    var ids = keys(G.cos).filter(function (id) { return id !== G.me; });
    /* one slot is always a mid-tier name, so a small company has somebody it
       can actually afford to sign */
    var ranked = ids.slice().sort(function (a, b) { return (G.cos[b].tech[dom] || 0) - (G.cos[a].tech[dom] || 0); });
    var from = i === 1 ? ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * 0.8))]
      : ranked[ri(G, 0, Math.min(2, ranked.length - 1))];
    var fromCo = G.cos[from];
    var lvl = fromCo.tech[dom] || 40;
    var boost = round(clamp(lvl * rr(G, .09, 0.17), 2.5, 15), 1);
    /* a name worth having is priced off what they carry, not off your wallet */
    var fee = round(boost * rr(G, 0.18, 0.30) * (1 + lvl / 90), 3);
    pool.push({
      id: 't' + (G.talent.seq++),
      name: talentName(G), role: dom, from: from,
      lvl: Math.round(lvl), boost: boost,
      fee: fee, salary: round(fee * 0.006, 4),
      loyalty: Math.round(rr(G, 45, 92))
    });
  }
  G.talent.market = pool;
  G.talent.refreshed = G.t;
}

function talentUpkeep(G) {
  var me = G.cos[G.me];
  if (!me) return 0;
  me.staff = me.staff || [];
  var out = [];
  me.staff.forEach(function (t) {
    /* a star walks when the company stops looking like a place to build */
    var risk = 0.006 + (G.board ? Math.max(0, 42 - G.board.mood) * 0.0012 : 0) +
      Math.max(0, 60 - t.loyalty) * 0.0004;
    if (rand(G) < risk) {
      me.tech[t.role] = clamp((me.tech[t.role] || 0) - t.boost * 0.5, 0, 98);
      pushLog(G, '🚪', t.name + ' עזבה אותנו. ' + TECH[t.role].n + ' נחלש.', 'bad');
    } else out.push(t);
  });
  me.staff = out;
  return sum(me.staff.map(function (t) { return t.salary; }));
}

function hireTalent(G, id) {
  var me = G.cos[G.me];
  var t = (G.talent.market || []).filter(function (x) { return x.id === id; })[0];
  if (!t) return { ok: false, why: 'המועמד/ת כבר לא זמין/ה.' };
  if (me.cash < t.fee) return { ok: false, why: 'חבילת החתימה עולה ' + fmtM(t.fee) + ' ואין מספיק מזומן.' };
  me.cash -= t.fee;
  me.staff = me.staff || [];
  me.staff.push({ id: t.id, name: t.name, role: t.role, boost: t.boost, salary: t.salary, loyalty: t.loyalty, since: G.t });
  me.tech[t.role] = clamp((me.tech[t.role] || 0) + t.boost, 0, 98);
  me.brand = clamp(me.brand + 0.8, 5, 100);
  var from = G.cos[t.from];
  if (from) {
    from.tech[t.role] = clamp((from.tech[t.role] || 0) - t.boost * 0.6, 0, 98);
    from.brand = clamp(from.brand - 0.5, 5, 100);
  }
  G.talent.market = G.talent.market.filter(function (x) { return x.id !== id; });
  pushLog(G, '🧠', 'חתמנו עם ' + t.name + ' מ־' + (from ? from.n : '—') + '. ' +
    TECH[t.role].n + ' קפץ ב־' + t.boost.toFixed(1) + ' נקודות.', 'good');
  return { ok: true, t: t };
}

/* Rivals raid the same shortlist, so hesitating has a cost. */
function aiPoach(G) {
  if (!G.talent || !G.talent.market.length) return;
  if (rand(G) > 0.28) return;
  var t = pick(G, G.talent.market);
  var ids = keys(G.cos).filter(function (id) { return id !== G.me && id !== t.from && G.cos[id].cash > t.fee * 3; });
  if (!ids.length) return;
  var co = G.cos[pick(G, ids)];
  co.cash -= t.fee;
  co.tech[t.role] = clamp((co.tech[t.role] || 0) + t.boost, 0, 98);
  var from = G.cos[t.from];
  if (from) from.tech[t.role] = clamp((from.tech[t.role] || 0) - t.boost * 0.6, 0, 98);
  G.talent.market = G.talent.market.filter(function (x) { return x.id !== t.id; });
  pushLog(G, '🧠', co.n + ' חטפה את ' + t.name + ' מ־' + (from ? from.n : '—') + '.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §14 — world events
   ═══════════════════════════════════════════════════════════════════════════ */

/* Heat spikes come from *here* and from breakthroughs — never from a marketing
   slider. Marketing buys your product hype; it does not heat a category. */
var EVENTS = [
  { id: 'shortage', w: 8, t: 'מחסור בקיבולת ליתוגרפיה מתקדמת',
    x: 'הזמנות לצמתים המתקדמים נדחות ברבעון. מחירי השבבים קופצים לכולם.',
    eff: 'עלות ייצור +9% לכולם, חום סמארטפונים וניידים יורד 5',
    f: function (G) { G.world.costMult *= 1.09; bumpHeat(G, ['phone', 'laptop'], -5); } },
  { id: 'aiwave', w: 9, t: 'גל מכשירי בינה מלאכותית',
    x: 'הדגמות של עוזרים על־מכשיריים מציפות את הרשת. הציבור פתאום רוצה לשדרג.',
    eff: 'חום +15 בשלוש קטגוריות, והבסיס המותקן של הסמארטפונים גדל מהר יותר',
    f: function (G) { bumpHeat(G, ['phone', 'laptop', 'wearable'], 15); G.market.phone.trend += 0.0022; } },
  { id: 'recession', w: 6, t: 'האטה כלכלית עולמית',
    x: 'מחזורי ההחלפה מתארכים. הקונים דוחים שדרוג בכמה חודשים.',
    eff: 'ביקוש עולמי −10% והקונים נודדים למדף התקציבי',
    f: function (G) { G.world.demandMult *= 0.90; G.world.mood = 'מתכווץ'; bumpBands(G, 'budget', 0.06); } },
  { id: 'boom', w: 5, t: 'התאוששות בהוצאה הפרטית',
    x: 'ההכנסה הפנויה עולה והשוק חוזר לרוץ קדימה.',
    eff: 'ביקוש עולמי +9% והקונים נודדים למדף הפרימיום',
    f: function (G) { G.world.demandMult *= 1.09; G.world.mood = 'מתרחב'; bumpBands(G, 'prem', 0.05); } },
  { id: 'tariff', w: 6, t: 'מכסי סחר חדשים',
    x: 'ייבוא מכשירים מוגמרים מתייקר. חלק מהעלות עובר לצרכן.',
    eff: 'עלות ייצור +6%, ביקוש −3%',
    f: function (G) { G.world.costMult *= 1.06; G.world.demandMult *= 0.97; } },
  { id: 'usbc', w: 4, t: 'רגולציה: תקן טעינה וסוללה מתחלפת',
    x: 'רגולטורים מחייבים תקינה. עלות התאמה חד־פעמית, אבל אמון הצרכן עולה.',
    eff: 'עלות ייצור +3%, חום סמארטפונים ואודיו +6',
    f: function (G) { G.world.costMult *= 1.03; bumpHeat(G, ['phone', 'audio'], 6); } },
  { id: 'quake', w: 4, t: 'רעידת אדמה במזרח אסיה',
    x: 'קווי ייצור מושבתים. מי שקנה מספק אחד בלבד — עומד בבעיה.',
    eff: 'ספק אקראי מאבד 38% מהקיבולת ל־3 חודשים',
    f: function (G) { disruptRandomSupplier(G, 3, 0.62); } },
  { id: 'fire', w: 4, t: 'שריפה במפעל הרכבה',
    x: 'קיבולת ההרכבה של אחד הספקים יורדת לחודשיים.',
    eff: 'קבלן הרכבה מאבד 30% מהקיבולת לחודשיים',
    f: function (G) { disruptRandomSupplier(G, 2, 0.7, 'build'); } },
  { id: 'memcrash', w: 6, t: 'קריסת מחירי זיכרון',
    x: 'עודף היצע בשוק ה־DRAM. עלות רכיב הזיכרון צונחת לכולם.',
    eff: 'עלות ייצור −7% לכולם',
    f: function (G) { G.world.costMult *= 0.93; } },
  { id: 'memspike', w: 6, t: 'זינוק במחירי זיכרון',
    x: 'מרכזי נתונים בולעים את כל ההיצע. הזיכרון מתייקר בחדות.',
    eff: 'עלות ייצור +8% לכולם',
    f: function (G) { G.world.costMult *= 1.08; } },
  { id: 'viral', w: 7, t: 'טרנד ויראלי בקטגוריה',
    x: 'קליפ אחד מסובב את כל השיחה בתעשייה.',
    eff: 'חום +20 בקטגוריה אחת, והבסיס שלה גדל',
    f: function (G) { var c = pick(G, CK); bumpHeat(G, [c], 20); G.market[c].trend += 0.0028;
      pushLog(G, '🔥', 'הרשת מדברת רק על ' + CATS[c].n + ' החודש.'); } },
  { id: 'flop', w: 5, t: 'כישלון מתוקשר של מוצר מתחרה',
    x: 'סקירה הרסנית של מכשיר דגל מפרקת אמון בציבור.',
    eff: 'מותג היריבה יורד 2–5 נקודות וההיפ של הדגמים שלה נחתך ב־18%',
    f: function (G) { var ids = keys(G.cos).filter(function (i) { return i !== G.me; });
      var c = G.cos[pick(G, ids)];
      c.brand = clamp(c.brand - rr(G, 2, 5), 5, 100);
      G.prods.forEach(function (p) { if (p.co === c.id && p.live && !p.dead) p.mktStock *= 0.82; });
      pushLog(G, '💥', c.n + ' ספגה גל ביקורות שליליות. המותג וההיפ שלה נפגעו.'); } },
  { id: 'patent', w: 5, t: 'תביעת פטנטים',
    x: 'בעלת פטנטים תובעת חצי מהתעשייה על טכנולוגיית טעינה.',
    eff: 'קנס חד־פעמי לחברה הגדולה ביותר, ועלות ייצור +4% לכולם',
    f: function (G) {
      G.world.costMult *= 1.04;
      var top = null;
      keys(G.cos).forEach(function (id) { if (!top || G.cos[id].revDev > top.revDev) top = G.cos[id]; });
      if (top) { var fine = Math.min(top.cash * 0.06, Math.max(0.2, top.revDev * 0.35)); top.cash -= fine;
        pushLog(G, '⚖️', top.n + ' שילמה ' + fmtM(fine) + ' בפשרת פטנטים.'); } } },
  { id: 'recall', w: 4, t: 'ריקול על רכיב פגום',
    x: 'אצווה שלמה של סוללות מוחזרת מהמדפים.',
    eff: 'החברה שנפגעה מוחקת מלאי ומאבדת 3 נקודות מותג',
    f: function (G) {
      var ids = keys(G.cos);
      var c = G.cos[pick(G, ids)];
      c.brand = clamp(c.brand - 3, 5, 100);
      var hit = 0;
      G.prods.forEach(function (p) {
        if (p.co !== c.id || !p.live || p.dead) return;
        hit += p.inv * 0.45; p.inv *= 0.55;
      });
      pushLog(G, '🔧', c.n + ' מבצעת ריקול. ' + fmtU(hit) + ' יחידות מלאי נמחקו.',
        c.id === G.me ? 'bad' : ''); } },
  { id: 'exportban', w: 4, t: 'צו הגבלת ייצוא',
    x: 'ממשלה חוסמת מכירת רכיבים מתקדמים ליעדים מסוימים.',
    eff: 'קיבולת נחתכת אצל ספק אחד ל־3 חודשים, ועלות +5%',
    f: function (G) { G.world.costMult *= 1.05; disruptRandomSupplier(G, 3, 0.7); } },
  { id: 'talentwar', w: 5, t: 'מלחמת כישרונות',
    x: 'שלוש חברות מתחרות על אותם עשרים אנשים.',
    eff: 'חבילות החתימה של כל המועמדים מתייקרות ב־35%',
    f: function (G) {
      if (G.talent && G.talent.market) {
        G.talent.market.forEach(function (t) { t.fee = round(t.fee * 1.35, 3); t.salary = round(t.salary * 1.2, 4); });
      } } },
  { id: 'privacy', w: 5, t: 'שערוריית פרטיות',
    x: 'חשיפה על איסוף נתונים פוגעת בקטגוריה שלמה.',
    eff: 'חום לבישים ו־XR יורד 12',
    f: function (G) { bumpHeat(G, ['wearable', 'xr'], -12); } },
  { id: 'xrpush', w: 5, t: 'פריצת דרך במשקפיים קלים',
    x: 'משקל מתחת ל־70 גרם עם תצוגה מלאה. השוק מתעורר.',
    eff: 'חום XR +26 והבסיס המותקן שלו מזנק',
    f: function (G) { bumpHeat(G, ['xr'], 26); G.market.xr.trend += 0.010; } },
  { id: 'currency', w: 5, t: 'תנודה חדה במטבע',
    x: 'שערי החליפין מזיזים גם את העלות וגם את המחיר האפקטיבי בשווקים.',
    eff: 'עלות וביקוש זזים 5% בכיוונים מנוגדים',
    f: function (G) { var d = rand(G) < .5 ? 0.95 : 1.05; G.world.costMult *= d; G.world.demandMult *= (2 - d) * 0.99 + 0.01; } },
  { id: 'repair', w: 4, t: 'חוק זכות התיקון',
    x: 'חובת חלקי חילוף וזמינות. עלות קטנה, נאמנות גדולה.',
    eff: 'עלות ייצור +2%, כל המותגים +0.6',
    f: function (G) { G.world.costMult *= 1.02; keys(G.cos).forEach(function (i) { G.cos[i].brand = clamp(G.cos[i].brand + 0.6, 5, 100); }); } },
  { id: 'algo', w: 6, creatorOnly: 1, t: 'שינוי אלגוריתם בפלטפורמות הווידאו',
    x: 'מה שהיה עובד לפני חודש כבר לא נדחף. יוצרי התוכן מגלים את זה קשה.',
    eff: 'משקלי הפורמטים בפלטפורמה מתחלפים — רלוונטי למצב יוצר תוכן',
    f: function (G) { shiftAlgorithm(G); } }
];

function bumpHeat(G, cats, amt) {
  cats.forEach(function (c) { if (G.market[c]) G.market[c].heat = clamp(G.market[c].heat + amt * rr(G, .8, 1.2), 6, 100); });
}
function bumpBands(G, band, amt) {
  CK.forEach(function (c) {
    var b = CATS[c].bands, other = BANDS.filter(function (x) { return x !== band; });
    b[band] = clamp(b[band] + amt, 0.1, 0.7);
    var rest = 1 - b[band];
    var t = sum(other.map(function (x) { return b[x]; }));
    other.forEach(function (x) { b[x] = rest * b[x] / t; });
  });
}
function disruptRandomSupplier(G, months, factor, part) {
  var pool = part ? suppliersFor(part) : SUPPLIERS;
  var s = pick(G, pool);
  G.disrupt = G.disrupt || {};
  G.disrupt[s.id] = { m: months, f: factor };
  pushLog(G, '⚠️', s.n + ' מדווחת על שיבוש קיבולת ל־' + months + ' חודשים. מי שחתום עליה — יספוג.', 'warn');
}

function worldTick(G) {
  /* macro reverts toward normal so no multiplier ever compounds forever */
  G.world.demandMult = lerp(G.world.demandMult, 1, 0.10);
  G.world.costMult = lerp(G.world.costMult, 1, 0.09);
  if (G.world.demandMult > 1.03) G.world.mood = 'מתרחב';
  else if (G.world.demandMult < 0.97) G.world.mood = 'מתכווץ';
  else G.world.mood = 'יציב';

  /* supplier disruptions tick down */
  G.disrupt = G.disrupt || {};
  keys(G.disrupt).forEach(function (id) {
    G.disrupt[id].m--; if (G.disrupt[id].m <= 0) delete G.disrupt[id];
  });
  keys(G.cos).forEach(function (cid) {
    var co = G.cos[cid], ctr = contractsOf(G, co), hit = 1, any = 0;
    keys(ctr).forEach(function (part) {
      var d = G.disrupt[ctr[part]];
      if (d) { hit *= lerp(1, d.f, part === 'build' ? 1 : 0.45); any = 1; }
    });
    co.disruptM = any ? 1 : 0; co.disruptF = hit;
  });

  if (rand(G) < 0.26 && G.t > 1) {
    /* an event with no hook into the current mode is not an event, it is
       flavour — so the pool is filtered before anything is rolled */
    var pool = EVENTS.filter(function (e) { return !e.creatorOnly || G.mode === 'creator'; });
    var tot = sum(pool.map(function (e) { return e.w; })), r = rand(G) * tot, acc = 0, ev = pool[0];
    for (var i = 0; i < pool.length; i++) { acc += pool[i].w; if (r <= acc) { ev = pool[i]; break; } }
    ev.f(G);
    pushLog(G, '🌍', ev.t + ' — ' + ev.x, '', ev.eff);
    G.lastEvent = { t: ev.t, x: ev.x, eff: ev.eff };
  } else G.lastEvent = null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §15 — formatting helpers (pure strings, shared with the UI)
   ═══════════════════════════════════════════════════════════════════════════ */

function fmtM(b) {                      /* $B → readable money */
  var a = Math.abs(b), sign = b < 0 ? '-' : '';
  if (a < 0.0000005) return '$0';
  if (a >= 1000) return sign + '$' + (a / 1000).toFixed(1) + 'T';
  if (a >= 1) return sign + '$' + a.toFixed(a >= 100 ? 0 : 1) + 'B';
  if (a >= 0.001) return sign + '$' + (a * 1000).toFixed(a >= 0.1 ? 0 : 1) + 'M';
  return sign + '$' + (a * 1e6).toFixed(0) + 'K';
}
function fmtSign(b) { return (b >= 0 ? '+' : '−') + fmtM(Math.abs(b)); }
function fmtU(u) {                      /* millions of units */
  var a = Math.abs(u);
  if (a >= 1000) return (u / 1000).toFixed(2) + 'B';
  if (a >= 1) return u.toFixed(a >= 100 ? 0 : 1) + 'M';
  if (a >= 0.001) return (u * 1000).toFixed(0) + 'K';
  return Math.round(u * 1e6) + '';
}
function fmtPct(x, d) { return (x * 100).toFixed(d == null ? 1 : d) + '%'; }
function fmtSignPct(x, d) { return (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d == null ? 1 : d) + '%'; }
function fmtPrice(p) { return '$' + Math.round(p).toLocaleString('en-US'); }

function pushLog(G, ic, txt, kind, eff) {
  G.log.unshift({ t: G.t, ic: ic, x: txt, k: kind || '', e: eff || '' });
  if (G.log.length > 90) G.log.length = 90;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §16 — rival behaviour
   ═══════════════════════════════════════════════════════════════════════════ */

/* A rival refreshes where it already has standing, not uniformly at random. */
function weightedCat(G, co, def) {
  var w = def.focus.map(function (c) { return Math.pow(Math.max(6, co.catBrand[c] || 20), 1.6) * (0.7 + G.market[c].heat / 140); });
  var tot = sum(w), r = rand(G) * tot, acc = 0;
  for (var i = 0; i < def.focus.length; i++) { acc += w[i]; if (r <= acc) return def.focus[i]; }
  return def.focus[0];
}

function aiTick(G) {
  keys(G.cos).forEach(function (id) {
    if (id === G.me) return;
    var co = G.cos[id], def = CO_BY_ID[id];
    var mine = G.prods.filter(function (p) { return p.co === id && !p.dead; });

    /* price + marketing drift on live products */
    mine.forEach(function (p) {
      if (!p.live) return;
      var age = G.t - p.born, C = CATS[p.cat];
      var floor = priceFloor(G, co, p);
      if (age > 6) p.price = Math.max(floor, p.price * (0.988 - co.style.agg * 0.006));
      /* under-performers get cut, winners get fed */
      var target = (p.lastShare > 0.10 ? 1.06 : 0.92);
      p.mkt = clamp(p.mkt * target, 0, mktBudget(co) * 0.42);
      p.mktStock = p.mktStock * 0.80 + p.mkt;
    });

    /* refresh cadence — a broad line-up needs a launch far more often than a
       single-product company, or whole categories quietly go dark */
    var every = Math.max(3, Math.round(lerp(19, 11, co.style.agg) / Math.max(1, def.focus.length * 0.55)));
    co.nextLaunch = co.nextLaunch == null ? ri(G, 1, every) : co.nextLaunch;
    if (G.t >= co.nextLaunch) {
      co.nextLaunch = G.t + every + ri(G, -1, 2);
      /* a category the company has abandoned gets first call on the slot */
      var empty = def.focus.filter(function (c) {
        return !G.prods.some(function (x) { return x.co === id && x.cat === c && !x.dead; });
      });
      var cat = empty.length ? empty[0] : weightedCat(G, co, def);
      var old = mine.filter(function (p) { return p.cat === cat && p.live; })
        .sort(function (a, b) { return a.born - b.born; })[0];
      var band = old ? (old.price > CATS[cat].bandRef.prem * 0.8 ? 'prem' : (old.price > CATS[cat].bandRef.mid * 0.8 ? 'mid' : 'budget')) : 'mid';
      var tier = band === 'prem' ? 4 : (band === 'mid' ? 3 : 2);
      var np = newProduct(G, co, cat, {
        name: productName(G, CO_BY_ID[id], cat, band, ri(G, 0, 2)) + ' ' + turnY(G.t),
        tier: tier
      });
      specForBand(G, co, np, band, tier);
      np.price = Math.round(priceFor(G, co, np, band) * rr(G, .96, 1.06) / 10) * 10; np.price0 = np.price;
      np.mkt = mktBudget(co) * 0.30;
      np.mktStock = np.mkt * 3;
      G.prods.push(np);
      var r = runReviews(G, co, np);
      if (old) old.auto = 1;
      /* keep a rival's shelf to a readable four SKUs per category */
      var inCat = G.prods.filter(function (x) { return x.co === id && x.cat === cat && x.live && !x.dead; })
        .sort(function (a, b) { return a.born - b.born; });
      while (inCat.length > 4) { inCat.shift().dead = 1; }
      pushLog(G, CATS[cat].ic, co.n + ' השיקה את ' + np.name + ' ב־' + fmtPrice(np.price) +
        '. ציון ביקורות ' + (r.score / 10).toFixed(1) + '/10.');
    }

    /* rival books: rough but real enough to move brand and cash */
    var cogs = 0;
    mine.forEach(function (p) { if (p.live && !p.dead) cogs += (p.sold || 0) * (p.unitCost || 0) / 1000; });
    var opex = (co.revDev + co.otherRev) * 0.135;
    co.profit = co.revDev + co.otherRev - cogs - opex - co.rndSpend -
      sum(mine.map(function (p) { return p.mkt || 0; }));
    co.cash = Math.max(-40, co.cash + co.profit * 0.55);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §17 — brand dynamics
   ═══════════════════════════════════════════════════════════════════════════ */

function brandTick(G) {
  keys(G.cos).forEach(function (id) {
    var co = G.cos[id];
    var ps = G.prods.filter(function (p) { return p.co === id && p.live && !p.dead; });
    if (!ps.length) { co.brand = clamp(co.brand - 0.25, 5, 100); return; }

    var rw = 0, rs = 0, so = 0, dem = 0;
    ps.forEach(function (p) {
      var w = Math.max(0.01, p.sold || 0.01);
      rs += (p.review || 50) * w; rw += w;
      so += p.stockout || 0; dem += p.demand || 0;
    });
    var avgRev = rs / rw;
    /* what you shipped lately, what you are right now, and the equity the name
       already carried before you sat down — reputations move, slowly */
    var target = clamp(avgRev * 0.34 + co.brand * 0.30 + (co.brand0 || co.brand) * 0.36, 5, 100);
    co.brand = clamp(co.brand + (target - co.brand) * 0.035, 5, 100);

    /* Shelf space, carrier deals and retail presence are earned by shipping
       volume and by being a name people ask for. Reach only ever ratchets
       up: nobody loses the distribution they already built. */
    var reachTarget = clamp(0.10 + co.brand / 190 + Math.min(0.34, (co.units || 0) / 42), 0.06, 1);
    if (reachTarget > co.reach) co.reach = co.reach + (reachTarget - co.reach) * 0.025;
    /* chronic stock-outs read as incompetence, not as desirability */
    if (dem > 0 && so / dem > 0.15) co.brand = clamp(co.brand - 0.35, 5, 100);

    CK.forEach(function (cat) {
      var sh = G.market[cat].shares[id] || 0;
      var cps = ps.filter(function (p) { return p.cat === cat; });
      if (!cps.length) { co.catBrand[cat] = clamp((co.catBrand[cat] || 30) - 0.4, 5, 100); return; }
      var cr = sum(cps.map(function (p) { return p.review || 50; })) / cps.length;
      var tgt = clamp(cr * 0.5 + Math.min(60, sh * 190) * 0.5, 5, 100);
      co.catBrand[cat] = clamp((co.catBrand[cat] || 40) + (tgt - (co.catBrand[cat] || 40)) * 0.045, 5, 100);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §18 — player finance
   ═══════════════════════════════════════════════════════════════════════════ */

function financeTick(G) {
  var me = G.cos[G.me];
  var mine = G.prods.filter(function (p) { return p.co === G.me && p.live && !p.dead; });

  var revDev = G.tick.revDev;
  var revOther = me.otherRev;
  var prodCost = G.tick.prodCost;
  var holdCost = G.tick.holdCost;
  var writeoff = G.tick.writeoff || 0;
  var mkt = sum(mine.map(function (p) { return p.mkt || 0; })) + (G.plan.press || 0) * 0.012 * Math.max(1, me.otherRev + 2) * 0.1;
  var rnd = sum(TK.map(function (k) { return Math.max(0, G.plan.rnd[k] || 0); }));
  /* fixed cost of owning factory capacity, whether or not it runs */
  var salaries = talentUpkeep(G);
  var opex = (revDev + revOther) * 0.170 + me.capacity * 0.012 + salaries;

  /* capex pipeline */
  var capexPaid = 0;
  G.plan.capexQueue = (G.plan.capexQueue || []).filter(function (q) {
    capexPaid += q.perMonth;
    q.left--;
    if (q.left <= 0) {
      me.capacity += q.add;
      pushLog(G, '🏭', 'קו הייצור החדש עלה לאוויר: +' + fmtU(q.add) + ' יחידות בחודש. הקיבולת עומדת על ' + fmtU(me.capacity) + '.', 'good');
      return false;
    }
    return true;
  });

  var gross = revDev + revOther;
  var net = gross - prodCost - holdCost - writeoff - mkt - rnd - opex;
  var payout = net > 0 ? net * clamp(G.plan.payout, 0, 0.6) : 0;

  me.cash += net - payout - capexPaid;
  me.revLast = revDev;
  me.rev12 = me.rev12 || [];
  me.rev12.push(revDev);
  if (me.rev12.length > 24) me.rev12.shift();
  me.profit = net;

  /* an overdrawn balance sheet turns into debt with a real interest bill */
  if (me.cash < 0) { me.debt += -me.cash; me.overdraft = (me.overdraft || 0) + -me.cash; me.cash = 0; }
  if (me.debt > 0) {
    var interest = me.debt * 0.0045;
    me.debt += interest;
    net -= interest;
    G.fin.interest = interest;
    /* only an overdraft is swept automatically; a deliberate loan is repaid
       when the player decides to, not the moment cash appears */
    if (me.overdraft > 0) {
      var repay = Math.min(me.cash * 0.35, me.overdraft, me.debt);
      me.cash -= repay; me.debt -= repay; me.overdraft -= repay;
    }
  }

  G.fin = {
    revDev: revDev, revOther: revOther, prodCost: prodCost, hold: holdCost, writeoff: writeoff,
    mkt: mkt, rnd: rnd, opex: opex, salaries: salaries, capex: capexPaid, payout: payout, net: net,
    margin: gross > 0 ? net / gross : 0
  };
  G.fin.netTTM = (G.finPrev && G.finPrev.netTTM ? G.finPrev.netTTM : []).concat([net]).slice(-12);
  G.finPrev = { netTTM: G.fin.netTTM };
  me.lossStreak = net < 0 ? (me.lossStreak || 0) + 1 : 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §19 — the board
   ═══════════════════════════════════════════════════════════════════════════ */

function yoyGrowth(me) {
  var r = me.rev12 || [];
  if (r.length < 18) return null;
  var now = sum(r.slice(-6)) / 6;
  var then = sum(r.slice(-18, -12)) / 6;
  if (then <= 0.0001) return null;
  return now / then - 1;
}

function boardTick(G) {
  var me = G.cos[G.me], A = ARCH[me.arch], notes = [], d = 0;

  /* 1. growth — measured against what THIS board actually wants */
  var g = yoyGrowth(me);
  if (g != null) {
    var lo = A.growth * 0.45;
    var hi = A.growth + A.tol * Math.max(A.growth, 0.06) + 0.03;
    if (g < lo) { d -= clamp((lo - g) * 40, 0, 12); notes.push('צמיחה שנתית ' + fmtSignPct(g) + ' מתחת ליעד ' + fmtPct(A.growth, 0) + '.'); }
    else if (g > hi) { d -= clamp((g - hi) * 9, 0, 4); notes.push('קצב הצמיחה (' + fmtSignPct(g) + ') נקרא כאן כתנודתיות, לא כהצלחה.'); }
    else { d += 2.6; notes.push('הצמיחה בטווח שהדירקטוריון ביקש.'); }
  }

  /* 2. margin */
  var m = G.fin.margin;
  var mTarget = CO_BY_ID[G.me].marginTarget != null ? CO_BY_ID[G.me].marginTarget : A.margin;
  var md = (m - mTarget);
  d += clamp(md * (A.marginW || 26), -6, 3.4);
  if (md < -0.05) notes.push('שולי הרווח ' + fmtPct(m) + ' מול יעד ' + fmtPct(mTarget, 0) + '.');

  /* 3. capital return — only a mega-cap board counts the dividend */
  if (A.wantsPayout) {
    if (G.plan.payout < A.payoutTarget * 0.6) { d -= 2.2; notes.push('החזר ההון לבעלי המניות נמוך מהמדיניות המוצהרת.'); }
    else if (G.plan.payout > A.payoutTarget * 1.9) { d -= 1.4; notes.push('החלוקה גבוהה מדי ביחס להשקעה בעתיד.'); }
    else d += 1.4;
    var gross = G.fin.revDev + G.fin.revOther;
    if (me.cash > gross * 22) { d -= 1.5; notes.push('הררי מזומן יושבים ללא שימוש. או להשקיע, או להחזיר לבעלי המניות.'); }
  }

  /* 4. survival */
  var burn = -Math.min(0, G.fin.net);
  var runway = burn > 0.0001 ? me.cash / burn : 99;
  var rw = A.runway || 6;
  if (burn > 0 && runway < rw) { d -= 4.5 * (1 - runway / rw); notes.push('מסלול המזומן ' + runway.toFixed(1) + ' חודשים בלבד.'); }
  if ((me.lossStreak || 0) > A.lossTol) { d -= 2.6; notes.push('רצף הפסדים של ' + me.lossStreak + ' חודשים.'); }
  if (me.debt > Math.max(2, me.otherRev * 3)) { d -= 1.8; notes.push('רמת החוב מטרידה את הדירקטוריון.'); }

  /* 4b. an empty shelf is the one thing no board forgives */
  var liveMine = G.prods.filter(function (p) { return p.co === G.me && p.live && !p.dead; }).length;
  var wantSku = me.arch === 'startup' ? 1 : (me.arch === 'challenger' ? 2 : 3);
  if (liveMine === 0) { d -= 9; notes.push('אין לנו אף מוצר פעיל בשוק. הדירקטוריון שואל למה אנחנו כאן.'); }
  else if (liveMine < wantSku) { d -= 2.2; notes.push('קו המוצרים דק מדי לחברה בגודל הזה.'); }

  /* 5. relevance */
  var totShare = sum(CK.map(function (c) { return (G.market[c].shares[G.me] || 0) * G.market[c].pool * CATS[c].ref; }));
  var totAll = sum(CK.map(function (c) { return G.market[c].pool * CATS[c].ref; }));
  var sh = totAll > 0 ? totShare / totAll : 0;
  me.shareVal = sh;
  if (me.shareLast != null) {
    var ds = sh - me.shareLast;
    d += clamp(ds * 240, -2.5, 2.5);
  }
  me.shareLast = sh;

  d = clamp(d, -14, 3.2);   /* a board's goodwill has a ceiling; its patience does not */
  G.board.mood = clamp(G.board.mood + d * 0.35 + (62 - G.board.mood) * 0.06, 0, 100);
  G.board.lastNote = notes.length ? notes[0] : 'הדירקטוריון שקט החודש.';
  G.board.notes = notes;
  G.board.delta = d;

  if (G.board.mood < 22) {
    G.board.warnings++;
    G.board.mood = 34;
    if (G.board.warnings >= 3) {
      G.over = true;
      G.ending = { win: false, t: 'הודחתם', x: 'הדירקטוריון של ' + me.n + ' סיים את כהונתכם אחרי שלוש אזהרות.' };
    } else {
      pushLog(G, '🚨', 'אזהרת דירקטוריון ' + G.board.warnings + '/3: ' + G.board.lastNote, 'bad');
    }
  }
}

/* A company that grows out of one stage inherits the next stage's board.
   The 34%-a-year investors do not stay in the room forever — and neither
   does the patience that came with them. */
function archTick(G) {
  var me = G.cos[G.me];
  if (!me) return;
  /* You graduate by tripling what you started at and clearing an absolute
     floor — not by hitting a number that happens to suit a big company. */
  var grad = Math.max(0.30, (me.rev0 || 0.05) * 3);
  if (me.arch === 'startup' && me.revDev > grad && (me.rev12 || []).length > 15) {
    me.arch = 'challenger';
    pushLog(G, '📈', 'סבב הצמיחה נסגר. הדירקטוריון מתחלף: מעכשיו מודדים אותנו על נתח ועל מסלול לרווח, לא רק על קצב.', 'good');
  } else if (me.arch === 'challenger' && me.revDev > 14 && me.brand > 66) {
    me.arch = 'megacap';
    G.plan.payout = Math.max(G.plan.payout, ARCH.megacap.payoutTarget * 0.7);
    pushLog(G, '🏛️', 'נכנסנו למדד הגדולים. הדירקטוריון החדש רוצה שוליים, יציבות ודיבידנד.', 'warn');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §19b — player actions
   Every command the UI can issue lives here, so the UI never mutates G by hand.
   ═══════════════════════════════════════════════════════════════════════════ */

function avgTier(p) {
  var ks = keys(p.spec);
  return sum(ks.map(function (k) { return p.spec[k]; })) / Math.max(1, ks.length);
}

/* Non-recurring engineering: what it costs to bring a design to the line. */
function devCost(G, cat, spec) {
  var C = CATS[cat];
  var ks = keys(C.w);
  var at = sum(ks.map(function (k) { return spec[k] || 3; })) / ks.length;
  var isNew = !G.prods.some(function (p) { return p.co === G.me && p.cat === cat && !p.dead; });
  return round(0.28 * C.costF * Math.pow(at / 3, 1.7) * (isNew ? 1.9 : 1), 3);
}
function devMonths(G, cat) {
  var isNew = !G.prods.some(function (p) { return p.co === G.me && p.cat === cat && !p.dead; });
  return isNew ? 7 : 4;
}

function designProduct(G, o) {
  var me = G.cos[G.me];
  var cost = devCost(G, o.cat, o.spec);
  if (me.cash < cost) return { ok: false, why: 'אין מספיק מזומן לפיתוח (' + fmtM(cost) + ').' };
  var p = newProduct(G, me, o.cat, { name: o.name, devLeft: devMonths(G, o.cat) });
  keys(p.spec).forEach(function (k) { p.spec[k] = clamp(o.spec[k] || 3, 1, 5); });
  p.price = Math.max(1, Math.round(o.price)); p.price0 = p.price;
  p.mkt = Math.max(0, o.mkt || 0);
  p.prodPlan = Math.max(0, o.prodPlan || 0);
  p.auto = o.auto ? 1 : 0;
  me.cash -= cost;
  G.prods.push(p);
  pushLog(G, CATS[o.cat].ic, 'התחלנו פיתוח: ' + p.name + '. עלות פיתוח ' + fmtM(cost) +
    ', השקה בעוד ' + p.devLeft + ' חודשים.');
  return { ok: true, p: p, cost: cost };
}

function cancelProduct(G, id) {
  var p = G.prods.filter(function (x) { return x.id === id; })[0];
  if (!p || p.co !== G.me) return { ok: false };
  p.dead = 1;
  pushLog(G, '🗑️', (p.live ? 'הפסקנו את ' : 'ביטלנו את פיתוח ') + p.name + '.');
  return { ok: true };
}

/* Switching a supplier costs a qualification round and a month of friction. */
function setContract(G, part, supId) {
  var me = G.cos[G.me];
  if (G.contracts[part] === supId) return { ok: true, fee: 0 };
  var fee = round(0.06 * Math.max(1, me.capacity) * 0.05 + 0.05, 3);
  if (me.cash < fee) return { ok: false, why: 'אין מזומן לעלות ההסבה (' + fmtM(fee) + ').' };
  me.cash -= fee;
  G.contracts[part] = supId;
  pushLog(G, '🔗', 'עברנו ל־' + SUP_BY_ID[supId].n + ' עבור ' + PARTS[part].n + '. עלות הסבה ' + fmtM(fee) + '.');
  return { ok: true, fee: fee };
}

/* Capacity is bought in advance and arrives late — that is the whole point. */
function buildCapacity(G, addUnits) {
  var me = G.cos[G.me];
  addUnits = Math.max(0, addUnits);
  if (addUnits < 0.02) return { ok: false, why: 'הרחבה מינימלית היא 20 אלף יחידות בחודש.' };
  var q = capexQuote(addUnits);
  var perMonth = round(q.total / q.months, 4);
  if (me.cash < perMonth * 1.5) return { ok: false, why: 'אין מזומן לתשלום הראשון.' };
  G.plan.capexQueue.push({ add: addUnits, left: q.months, perMonth: perMonth, total: q.total });
  pushLog(G, '🏗️', (q.contract ? 'שכרנו קיבולת אצל קבלן: +' : 'אישרנו קו ייצור נוסף: +') +
    fmtU(addUnits) + ' יחידות בחודש בעלות ' + fmtM(q.total) + ', מוכן בעוד ' + q.months + ' חודשים.');
  return { ok: true, total: q.total, perMonth: perMonth, months: q.months };
}

/* ── Borrowing ───────────────────────────────────────────────────────────
   A credit line sized off the business you can actually show a lender.     */
/* The debt level at which the creditors, not the board, end the game. */
function insolvencyLimit(G) {
  var me = G.cos[G.me];
  return Math.max(1.2, (me.otherRev + (G.fin.revDev || 0) * 0.6 + 0.4) * 14);
}
/* A line sized off the business a lender can actually see — and deliberately
   held below the level that would bankrupt you, so borrowing alone can never
   lose the run. Spending the money still can. */
function creditLimit(G) {
  var me = G.cos[G.me];
  var gross = (G.fin.revDev || 0) + (G.fin.revOther || 0);
  var offered = Math.max(0.35, gross * 2.5 + me.capacity * 0.2) * (G.creditBoost || 1);
  return Math.min(offered, insolvencyLimit(G) * 0.8);
}
function loanHeadroom(G) { return Math.max(0, creditLimit(G) - G.cos[G.me].debt); }

function takeLoan(G, amount) {
  var me = G.cos[G.me];
  amount = Math.max(0, amount);
  if (amount < 0.01) return { ok: false, why: 'סכום מינימלי להלוואה הוא 10 מיליון דולר.' };
  if (amount > loanHeadroom(G) + 1e-9) return { ok: false, why: 'מסגרת האשראי מוגבלת ל־' + fmtM(loanHeadroom(G)) + '.' };
  me.cash += amount;
  me.debt += amount;
  pushLog(G, '🏦', 'משכנו ' + fmtM(amount) + ' מהמסגרת. החוב עומד על ' + fmtM(me.debt) + '.', 'warn');
  return { ok: true };
}
function repayLoan(G, amount) {
  var me = G.cos[G.me];
  amount = clamp(amount, 0, Math.min(me.cash, me.debt));
  if (amount < 0.01) return { ok: false, why: 'אין מה להחזיר, או שאין מזומן.' };
  me.cash -= amount;
  me.debt -= amount;
  pushLog(G, '🏦', 'החזרנו ' + fmtM(amount) + ' מהחוב.');
  return { ok: true };
}

function capacityUsed(G, co) {
  return sum(G.prods.filter(function (p) { return p.co === co.id && p.live && !p.dead; })
    .map(function (p) { return (p.co === G.me ? (p.prodPlan || 0) : (p.demand || 0)) * LINE_USE[p.cat]; }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §20 — creator mode
   ═══════════════════════════════════════════════════════════════════════════ */

var FORMATS = {
  review:  { n: 'ביקורות מכשירים', effort: 1.00, cpm: 14.5, conv: 1.00, cred: +0.5 },
  deep:    { n: 'צלילות עומק',     effort: 1.55, cpm: 18.0, conv: 1.25, cred: +1.1 },
  news:    { n: 'חדשות ודרמה',     effort: 0.62, cpm: 8.5,  conv: 0.72, cred: -0.4 },
  shorts:  { n: 'שורטס',           effort: 0.34, cpm: 2.6,  conv: 0.55, cred: -0.1 }
};
var FK = keys(FORMATS);

var CREATOR_DEFS = [
  { id: 'reviewer', n: 'ערוץ ביקורות קלאסי', subs: 0.042, cred: 62, skill: 54, bank: 14,
    mix: { review: .55, deep: .15, news: .15, shorts: .15 },
    d: 'אתם עושים מה ש־MKBHD עושה, רק עם אלף אחוז פחות מנויים. אמינות התחלתית טובה, קצב שחיקה בינוני.' },
  { id: 'teardown', n: 'ערוץ פירוקים ועמידות', subs: 0.021, cred: 71, skill: 49, bank: 9,
    mix: { review: .25, deep: .45, news: .10, shorts: .20 },
    d: 'מסלול JerryRigEverything: קהל קטן, אמון עצום, ויחסים גרועים עם מחלקות יחסי הציבור.' },
  { id: 'value', n: 'ערוץ מציאות ותקציב', subs: 0.078, cred: 48, skill: 46, bank: 21,
    mix: { review: .40, deep: .10, news: .20, shorts: .30 },
    d: 'קהל רחב שמחפש מה לקנות ב־800 שקל. הרבה צפיות, CPM נמוך, ופיתוי מתמיד לחסויות מפוקפקות.' },
  { id: 'newsroom', n: 'ערוץ חדשות טק', subs: 0.115, cred: 39, skill: 51, bank: 27,
    mix: { review: .20, deep: .10, news: .50, shorts: .20 },
    d: 'מהיר, ויראלי, ותלוי לגמרי באלגוריתם. הצמיחה מהירה — והנפילה גם.' }
];

function newCreator(G, defId) {
  var d = CREATOR_DEFS.filter(function (x) { return x.id === defId; })[0] || CREATOR_DEFS[0];
  var rel = {};
  CREATORS.forEach(function (c) { rel[c.id] = 40; });
  G.algo = { favor: 'review', strength: 1.0, since: 0 };
  return {
    def: d.id, name: d.n,
    subs: d.subs, cred: d.cred, skill: d.skill, burn: 8, bank: d.bank,
    plan: { videos: 4, mix: JSON.parse(JSON.stringify(d.mix)), rest: 0 },
    deals: [], active: [], invites: [], rel: rel,
    views: 0, viewsLast: 0, subsLast: d.subs, income: 0,
    hiatus: 0, dilemma: null, strikes: 0,
    hist: { views: [], subs: [], cred: [], burn: [] }
  };
}

/* Build the first month's offers so the opening screen is not empty. */
function primeCreator(G) {
  var C = G.creator;
  genDeals(G);
  C.hist.views.push(0); C.hist.subs.push(round(C.subs, 4));
  C.hist.cred.push(Math.round(C.cred)); C.hist.burn.push(Math.round(C.burn));
}

function shiftAlgorithm(G) {
  if (!G.algo) G.algo = { favor: 'review', strength: 1, since: 0 };
  var opts = FK.filter(function (k) { return k !== G.algo.favor; });
  G.algo.favor = pick(G, opts);
  G.algo.strength = rr(G, 1.16, 1.52);
  G.algo.since = G.t;
  pushLog(G, '📉', 'הפלטפורמה שינתה משקלים: ' + FORMATS[G.algo.favor].n + ' מקבלים דחיפה החודש.', 'warn');
}

/* Sponsorship offers. Shady money is always the easiest money on the table. */
var SHADY = [
  { n: 'ספק VPN עם הבטחות מוגזמות', mult: 2.4, cred: 5.5 },
  { n: 'בורסת קריפטו לא מפוקחת', mult: 3.4, cred: 9.0 },
  { n: 'אפליקציית הימורים', mult: 3.0, cred: 8.0 },
  { n: 'מותג דרופשיפינג של אביזרים', mult: 1.9, cred: 4.0 },
  { n: 'קורס ״הכנסה פסיבית״', mult: 2.7, cred: 7.0 }
];
var CLEAN = [
  { n: 'יצרנית מארזים ותיקה', mult: 1.0, cred: 0.2 },
  { n: 'שירות גיבוי בענן', mult: 1.15, cred: 0.3 },
  { n: 'מותג ציוד צילום', mult: 1.25, cred: -0.6 },
  { n: 'ספק אחסון SSD', mult: 1.1, cred: -0.3 }
];

function genDeals(G) {
  var C = G.creator;
  C.deals = [];
  var reach = C.subs;
  var n = 1 + (rand(G) < 0.55 ? 1 : 0) + (reach > 1.2 ? 1 : 0);
  for (var i = 0; i < n; i++) {
    var shady = rand(G) < clamp(0.55 - C.cred / 260, 0.18, 0.6);
    var src = shady ? pick(G, SHADY) : pick(G, CLEAN);
    /* a sponsor pays for the eyeballs a month of uploads is expected to reach */
    var base = Math.max(0.6, reach * rr(G, 30, 46));        /* $K, roughly CPM-scaled */
    C.deals.push({
      id: 'd' + G.t + '_' + i,
      n: src.n, shady: shady ? 1 : 0,
      pay: round(Math.max(1.4, base * src.mult), 1),
      cred: round(src.cred * (shady ? 1 : 1), 1),
      months: shady ? 1 : ri(G, 1, 3)
    });
  }
  /* device makers court creators by credibility and reach, not by cash alone */
  C.invites = [];
  var hot = CK.slice().sort(function (a, b) { return G.market[b].heat - G.market[a].heat; })[0];
  if (C.cred > 46 && reach > 0.08 && rand(G) < 0.45) {
    var ids = keys(G.cos).filter(function (i) { return CO_BY_ID[i].focus.indexOf(hot) >= 0; });
    if (ids.length) {
      var co = G.cos[pick(G, ids)];
      C.invites.push({
        id: 'inv' + G.t, co: co.id, cat: hot,
        n: co.n + ' מזמינה אתכם לחשיפה מוקדמת של מכשיר ' + CATS[hot].n,
        embargo: rand(G) < 0.45 ? 1 : 0
      });
    }
  }
}

var DILEMMAS = [
  { id: 'embargo', t: 'שברתם אמברגו?', x: 'קיבלתם מפרט מלא של מכשיר שטרם הוכרז. פרסום עכשיו יביא מיליוני צפיות — ויסגור לכם דלתות.',
    o: [{ n: 'לפרסם עכשיו', f: function (G, C) { C.viewBoost = 1.55; C.cred -= 7; C.rel && (C.blacklist = (C.blacklist || 0) + 1); return 'הסקופ עבד. מחלקות היח״צ זוכרות.'; } },
        { n: 'לחכות להכרזה', f: function (G, C) { C.cred += 3.5; return 'הפסדתם צפיות והרווחתם יחסים.'; } }] },
  { id: 'softreview', t: 'ביקורת רכה תמורת בלעדיות', x: 'יצרנית מציעה יחידה ראשונה בעולם — בתנאי שהזווית תהיה חיובית.',
    o: [{ n: 'לקבל את התנאים', f: function (G, C) { C.viewBoost = 1.35; C.cred -= 6; return 'הסרטון עף. התגובות שמו לב שלא אמרתם כלום רע.'; } },
        { n: 'לסרב ולפרסם בלי יחידה', f: function (G, C) { C.cred += 4; C.viewBoost = 0.9; return 'פחות צפיות, יותר אמון.'; } }] },
  { id: 'clickbait', t: 'התמונה הממוזערת', x: 'העורך הכין תמונה ממוזערת שמבטיחה משהו שהסרטון לא באמת מספק.',
    o: [{ n: 'לפרסם ככה', f: function (G, C) { C.viewBoost = 1.28; C.cred -= 3.2; return 'ה־CTR קפץ, זמן הצפייה צנח.'; } },
        { n: 'לרכך', f: function (G, C) { C.viewBoost = 0.97; C.cred += 1.4; return 'פחות קליקים, קהל שנשאר.'; } }] },
  { id: 'burncrew', t: 'הצוות מותש', x: 'העורך ביקש חודש חופש באמצע עונת ההשקות.',
    o: [{ n: 'לאשר', f: function (G, C) { C.burn -= 12; C.viewBoost = 0.82; return 'חודש חלש. הצוות חזר.'; } },
        { n: 'לדחוף עוד חודש', f: function (G, C) { C.burn += 11; C.viewBoost = 1.06; return 'עמדתם בלו״ז. מישהו שילם על זה.'; } }] },
  { id: 'copycat', t: 'ערוץ העתיק לכם סרטון', x: 'ערוץ גדול פרסם את אותו זווית בדיוק, שלושה ימים אחריכם.',
    o: [{ n: 'לעשות מזה סרטון', f: function (G, C) { C.viewBoost = 1.22; C.cred -= 1.6; return 'דרמה מוכרת, אבל זו לא הסיבה שנרשמו אליכם.'; } },
        { n: 'להתעלם', f: function (G, C) { C.cred += 2.2; return 'שקט. הקהל הוותיק שם לב.'; } }] },
  { id: 'affiliate', t: 'קישורי שותפים אגרסיביים', x: 'אפשר להעמיס קישורי רכישה על כל סרטון ולהכפיל את ההכנסה מהמלצות.',
    o: [{ n: 'להעמיס', f: function (G, C) { C.bank += 6 + C.subs * 9; C.cred -= 3.4; return 'הכנסה מיידית, ציניות בתגובות.'; } },
        { n: 'להשאיר מינימלי', f: function (G, C) { C.cred += 1.2; return 'הכנסה נשארה כמו שהיא.'; } }] }
];

function creatorTick(G) {
  var C = G.creator, P = C.plan;
  var boost = C.viewBoost || 1; C.viewBoost = 1;

  /* ── burnout ─────────────────────────────────────────────────────────── */
  var effort = 0;
  FK.forEach(function (k) { effort += (P.mix[k] || 0) * FORMATS[k].effort; });
  var load = P.videos * effort;
  if (C.hiatus > 0 || P.rest) {
    C.burn = clamp(C.burn - 16 - rr(G, 0, 5), 0, 100);
  } else {
    C.burn = clamp(C.burn + (load - 3.0) * 2.4 - 2.0, 0, 100);
  }
  var burnPen = clamp(1 - Math.max(0, C.burn - 34) / 118, 0.42, 1);

  /* ── skill and quality ───────────────────────────────────────────────── */
  if (!P.rest && C.hiatus <= 0) C.skill = clamp(C.skill + P.videos * 0.34 / (1 + C.skill / 40), 0, 100);
  var qual = clamp(C.skill * burnPen * (0.86 + 0.30 * (P.mix.deep || 0)) + noise(G, 3), 4, 100);
  C.quality = qual;

  /* ── the algorithm decides who gets seen ─────────────────────────────── */
  var algoFit = 0;
  FK.forEach(function (k) {
    var m = (k === G.algo.favor) ? G.algo.strength : 1 / Math.pow(G.algo.strength, 0.45);
    algoFit += (P.mix[k] || 0) * m;
  });
  var credF = clamp(0.52 + C.cred / 118, 0.4, 1.42);
  var hotF = 0.9 + 0.2 * (sum(CK.map(function (c) { return G.market[c].heat; })) / (CK.length * 100));

  var views;
  if (C.hiatus > 0 || P.rest) {
    views = C.subs * 0.42 * rr(G, .8, 1.1);
  } else {
    views = C.subs * P.videos * 0.45 * algoFit * (qual / 58) * credF * hotF * boost * rr(G, .88, 1.14);
  }
  views = Math.max(0, views);

  /* ── subscribers ─────────────────────────────────────────────────────── */
  var conv = 0;
  FK.forEach(function (k) { conv += (P.mix[k] || 0) * FORMATS[k].conv; });
  /* the tech-audience is finite: the last million subscribers are the hardest */
  var SAT = 34;
  var gained = views * 0.020 * conv * (qual / 66) * credF * clamp(1 - C.subs / SAT, 0.04, 1);
  var churn = C.subs * (0.016 + Math.max(0, (48 - C.cred)) * 0.0009 + (C.hiatus > 0 ? 0.02 : 0));
  C.subsLast = C.subs;
  C.subs = Math.max(0.001, C.subs + gained - churn);

  /* ── money ───────────────────────────────────────────────────────────── */
  var cpm = 0;
  FK.forEach(function (k) { cpm += (P.mix[k] || 0) * FORMATS[k].cpm; });
  var adRev = views * cpm;                      /* views in M × CPM = $K */
  var spons = 0;
  C.active = (C.active || []).filter(function (d) {
    spons += d.pay; d.months--; return d.months > 0;
  });
  var costs = 0.4 + P.videos * 0.28 + C.subs * 1.6;   /* gear, editors, studio */
  C.income = adRev + spons - costs;
  C.bank += C.income;

  /* ── credibility drifts toward how you actually behave ───────────────── */
  var credDrift = 0;
  FK.forEach(function (k) { credDrift += (P.mix[k] || 0) * FORMATS[k].cred; });
  credDrift *= (P.rest ? 0.3 : 1);
  /* a bigger channel is watched more closely — reputation gets harder to grow */
  credDrift *= clamp(1 - C.cred / 108, 0.06, 1) * clamp(1 - C.subs / 60, 0.45, 1);
  C.cred = clamp(C.cred + credDrift + (qual > 70 ? 0.5 : 0) - (qual < 40 ? 0.9 : 0), 0, 100);

  /* ── forced hiatus ───────────────────────────────────────────────────── */
  if (C.hiatus > 0) C.hiatus--;
  else if (C.burn > 82) {
    C.hiatus = ri(G, 1, 2);
    pushLog(G, '🛑', 'שחיקה. הערוץ יוצא להפסקה כפויה של ' + C.hiatus + ' חודשים.', 'bad');
  }

  C.views = views; C.viewsLast = views;
  C.hist.views.push(round(views, 3));
  C.hist.subs.push(round(C.subs, 4));
  C.hist.cred.push(Math.round(C.cred));
  C.hist.burn.push(Math.round(C.burn));
  ['views', 'subs', 'cred', 'burn'].forEach(function (k) { if (C.hist[k].length > 60) C.hist[k].shift(); });

  /* ── next month's offers and dilemma ─────────────────────────────────── */
  genDeals(G);
  C.dilemma = (rand(G) < 0.34 && !P.rest) ? JSON.parse(JSON.stringify({ id: pick(G, DILEMMAS).id })) : null;
  if (C.dilemma) C.dilemma = DILEMMAS.filter(function (d) { return d.id === C.dilemma.id; })[0].id;

  if (G.algo.since + ri(G, 5, 9) < G.t) shiftAlgorithm(G);
}

/* ── Crossing over ───────────────────────────────────────────────────────
   A channel big enough and trusted enough stops being an audience and starts
   being leverage: either investors will back a company you found, or a board
   somewhere decides the person the market listens to should run the thing.  */
var XOVER_SUBS = 1.2;
var XOVER_CRED = 62;

function canExpand(G) {
  if (G.mode !== 'creator' || !G.creator) return false;
  return G.creator.subs >= XOVER_SUBS && G.creator.cred >= XOVER_CRED;
}
/* What the channel is worth to a seed round, in $B. */
function raiseAmount(G) {
  var C = G.creator;
  return round(0.12 * C.subs + 0.25 * (C.cred / 100) + Math.min(0.9, C.bank / 4000), 3);
}
/* Companies that would actually take the call: weak brand, thin cash, or
   losing money — the ones with something to gain from a famous outsider. */
function strugglingCompanies(G) {
  return keys(G.cos).map(function (id) { return G.cos[id]; })
    .filter(function (co) {
      return CO_BY_ID[co.id] && CO_BY_ID[co.id].playable !== 0 &&
        (co.brand < 62 || (co.profit || 0) < 0 || co.cash < co.otherRev * 4);
    })
    .sort(function (a, b) { return a.brand - b.brand; })
    .slice(0, 3);
}

function expandToIndustry(G, path, targetId) {
  if (!canExpand(G)) return { ok: false, why: 'הערוץ עדיין לא מספיק גדול או אמין.' };
  var C = G.creator;
  /* the channel does not vanish — it keeps amplifying whatever you ship */
  var legacyMkt = 1 + clamp(C.subs / 26, 0, 0.45) + clamp((C.cred - 50) / 260, 0, 0.15);

  if (path === 'found') {
    var raise = raiseAmount(G);
    var def = makeCustomDef(C.coName || ('הסטארטאפ של ' + C.name), {
      cash: raise,
      brand: Math.round(clamp(16 + C.cred * 0.30 + Math.min(22, C.subs * 1.5), 12, 62)),
      capacity: round(clamp(0.22 + raise * 0.35, 0.2, 2.2), 2),
      reach: round(clamp(0.10 + C.subs / 44, 0.1, 0.4), 3),
      mktEff: round(1.25 * legacyMkt, 3),
      catBrand: { phone: Math.round(14 + C.cred * 0.2), laptop: 9, wearable: 13, audio: 19, xr: 10 },
      d: 'הוקמה על גב הערוץ. הקהל כבר מכיר אתכם — עכשיו הוא רוצה לראות מה תשלחו למדף.'
    });
    G.customDef = def;
    registerCustom(G);
    var co = {
      id: def.id, n: def.n, he: def.he, tag: def.tag, arch: def.arch,
      cash: def.cash, brand: def.brand, brand0: def.brand, otherRev: 0,
      capacity: def.capacity, capBuild: [], installed: {}, staff: [],
      reach: def.reach, costEff: def.costEff, mktEff: def.mktEff,
      tech: JSON.parse(JSON.stringify(def.tech)),
      catBrand: JSON.parse(JSON.stringify(def.catBrand)),
      style: def.style,
      revDev: 0, revLast: 0, rev12: [], profit: 0, share: {}, units: 0,
      rndSpend: 0, debt: 0, overdraft: 0
    };
    CK.forEach(function (k) { co.installed[k] = 0; });
    G.cos[def.id] = co;
    seedPortfolio(G, co);
    G.me = def.id;
    pushLog(G, '🚀', 'גייסנו ' + fmtM(raise) + ' והקמנו את ' + def.n + '. הערוץ נשאר באוויר ומגביר כל השקה.', 'good');
  } else {
    var target = G.cos[targetId];
    if (!target) return { ok: false, why: 'החברה הזו כבר לא על השולחן.' };
    target.mktEff = round(target.mktEff * legacyMkt, 3);
    G.me = targetId;
    G.customDef = null;
    /* inherit the seat's existing supplier book */
    G.contracts = JSON.parse(JSON.stringify(aiContracts(target)));
    pushLog(G, '💼', 'הדירקטוריון של ' + target.n + ' מינה אתכם למנכ״ל. הערוץ עובר לארכיון — וההשפעה שלו נשארת.', 'good');
  }

  var me = G.cos[G.me];
  G.mode = 'ceo';
  /* a second act needs room to actually play out */
  G.horizon = Math.max(G.horizon || HORIZON, G.t + 40);
  G.creatorPast = { name: C.name, subs: C.subs, cred: C.cred, bank: C.bank, at: G.t, path: path };
  G.creator = null;
  G.board = { mood: 60, warnings: 0, payout: ARCH[me.arch].payoutTarget, lastNote: '', notes: [], delta: 0 };
  G.plan = { rnd: {}, capexQueue: [], payout: ARCH[me.arch].payoutTarget, press: 1 };
  keys(PARTS).forEach(function (part) {
    if (!G.contracts[part]) {
      var opts = suppliersFor(part);
      if (opts.length) G.contracts[part] = opts[Math.floor(opts.length / 2)].id;
    }
  });
  var est = sum(G.prods.filter(function (p) { return p.co === G.me; })
    .map(function (p) { return (p.demand || 0) * p.price / 1000; }));
  var rndBudget = me.style.rnd * Math.max(0.015, me.otherRev * 0.6 + est * 0.9 + 0.03);
  TK.forEach(function (k) { G.plan.rnd[k] = round(rndBudget / TK.length, 4); });
  G.hist = { t: [], cash: [], rev: [], profit: [], share: [], brand: [], mood: [] };
  G.talent = null;
  primeFinancials(G);
  return { ok: true };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §21 — the turn
   ═══════════════════════════════════════════════════════════════════════════ */

function ageProducts(G) {
  G.prods.forEach(function (p) {
    if (p.dead) return;
    if (!p.live) {
      p.devLeft--;
      if (p.devLeft <= 0) {
        p.live = 1; p.born = G.t + 1;
        var co = G.cos[p.co];
        var r = runReviews(G, co, p);
        if (p.co === G.me) {
          pushLog(G, CATS[p.cat].ic, 'השקנו את ' + p.name + '. ציון ביקורות משוקלל ' + (r.score / 10).toFixed(1) +
            '/10, ' + r.top.n + ' נתן ' + (p.rev_by[r.top.id]).toFixed(1) + '.', r.score > 62 ? 'good' : (r.score < 45 ? 'bad' : ''));
        }
      }
    } else {
      p.reviewAge++;
    }
  });
}

function playerAdStock(G) {
  G.prods.forEach(function (p) {
    if (p.co !== G.me || !p.live || p.dead) return;
    p.mktStock = p.mktStock * 0.80 + Math.max(0, p.mkt || 0);
  });
}

function endTurn(G) {
  if (G.over) return;

  G.prods.forEach(function (p) { if (p.auto) autoManage(G, p); });
  playerAdStock(G);
  aiTick(G);
  aiPoach(G);
  if (!G.talent || G.t - (G.talent.refreshed || -9) >= 3) genTalent(G);
  rndTick(G);
  worldTick(G);
  marketTick(G);
  distributeAll(G);
  produceAndSell(G);
  ecosystemTick(G);
  retireProducts(G);
  brandTick(G);

  if (G.mode === 'ceo') { financeTick(G); archTick(G); boardTick(G); }
  else { creatorTick(G); }

  ageProducts(G);
  buildReport(G);
  recordHistory(G);
  G.t++;
  checkEnd(G);
}

function recordHistory(G) {
  var h = G.hist;
  h.t.push(G.t);
  if (G.mode === 'ceo') {
    var me = G.cos[G.me];
    h.cash.push(round(me.cash, 2));
    h.rev.push(round(G.fin.revDev + G.fin.revOther, 3));
    h.profit.push(round(G.fin.net, 3));
    h.share.push(round((me.shareVal || 0) * 100, 2));
    h.brand.push(Math.round(me.brand));
    h.mood.push(Math.round(G.board.mood));
  } else {
    var C = G.creator;
    h.cash.push(round(C.bank, 1));
    h.rev.push(round(C.income, 1));
    h.profit.push(round(C.views, 3));
    h.share.push(round(C.subs, 4));
    h.brand.push(Math.round(C.cred));
    h.mood.push(Math.round(100 - C.burn));
  }
  ['t', 'cash', 'rev', 'profit', 'share', 'brand', 'mood'].forEach(function (k) {
    if (h[k].length > 130) h[k].shift();
  });
}

function buildReport(G) {
  if (G.mode === 'ceo') {
    var me = G.cos[G.me];
    var mine = G.prods.filter(function (p) { return p.co === G.me && p.live && !p.dead; });
    var top = mine.slice().sort(function (a, b) { return b.rev - a.rev; }).slice(0, 3);
    G.report = {
      t: G.t, mode: 'ceo',
      fin: JSON.parse(JSON.stringify(G.fin)),
      cash: me.cash, units: G.tick.units,
      stockout: G.tick.stockoutUnits, dead: G.tick.deadUnits || 0,
      capCrunch: G.tick.capCrunch || 0,
      inv: sum(mine.map(function (p) { return p.inv; })),
      board: { mood: G.board.mood, delta: G.board.delta, notes: (G.board.notes || []).slice(0, 3) },
      top: top.map(function (p) { return { n: p.name, rev: p.rev, u: p.sold, so: p.stockout }; }),
      event: G.lastEvent
    };
  } else {
    var C = G.creator;
    G.report = {
      t: G.t, mode: 'creator',
      views: C.views, subs: C.subs, dSubs: C.subs - C.subsLast,
      income: C.income, bank: C.bank, cred: C.cred, burn: C.burn,
      hiatus: C.hiatus, quality: C.quality, favor: G.algo.favor,
      event: G.lastEvent
    };
  }
}

function checkEnd(G) {
  if (G.over) return;
  if (G.mode === 'ceo') {
    var me = G.cos[G.me];
    if (me.debt > insolvencyLimit(G)) {
      G.over = true;
      G.ending = { win: false, t: 'חדלות פירעון', x: 'החוב של ' + me.n + ' חצה את הקו. הנושים לקחו את ההגה.' };
      return;
    }
  } else {
    var C = G.creator;
    if (C.cred < 12) {
      G.over = true;
      G.ending = { win: false, t: 'הערוץ איבד את הקהל', x: 'האמינות התרסקה. אף אחד כבר לא סופר את ההמלצות שלכם.' };
      return;
    }
    if (C.bank < -40) {
      G.over = true;
      G.ending = { win: false, t: 'הפקה שקרסה', x: 'הסטודיו נסגר. אי אפשר לממן עוד חודש.' };
      return;
    }
    if (C.subs > 26) {
      G.over = true;
      G.ending = { win: true, t: 'הפכתם למוסד', x: 'הערוץ עבר את רף ה־26 מיליון. ההשקות בעולם מתוזמנות סביבכם.' };
      return;
    }
  }
  if (G.t >= (G.horizon || HORIZON)) {
    G.over = true;
    G.ending = finalScore(G);
  }
}

function finalScore(G) {
  if (G.mode === 'ceo') {
    var me = G.cos[G.me], A = ARCH[me.arch];
    var sh = (me.shareVal || 0) * 100;
    var pts = clamp(G.board.mood, 0, 100) * 0.4 + clamp(sh * 4, 0, 100) * 0.25 +
      clamp(me.brand, 0, 100) * 0.20 + clamp(50 + G.fin.margin * 200, 0, 100) * 0.15;
    var win = pts >= 58 && G.board.warnings < 3;
    return {
      win: win, pts: Math.round(pts),
      t: win ? 'עשר שנים, והכיסא עדיין שלכם' : 'עשר שנים, ומישהו כבר מחכה בחוץ',
      x: me.n + ' סוגרת את התקופה עם נתח שוק של ' + sh.toFixed(1) + '%, מותג ' + Math.round(me.brand) +
        ' ומצב רוח דירקטוריון ' + Math.round(G.board.mood) + '. ' + ARCH[me.arch].n + ' ' +
        (win ? 'מאריך את החוזה.' : 'לא מאריך את החוזה.')
    };
  }
  var C = G.creator;
  var pts = clamp(C.subs * 4, 0, 100) * 0.4 + C.cred * 0.35 + clamp(100 - C.burn, 0, 100) * 0.25;
  return {
    win: pts >= 55, pts: Math.round(pts),
    t: pts >= 55 ? 'עשר שנים על האוויר' : 'עשר שנים, וזה הספיק',
    x: 'הערוץ סוגר עשור עם ' + fmtU(C.subs) + ' מנויים, אמינות ' + Math.round(C.cred) +
      ' ורמת שחיקה ' + Math.round(C.burn) + '.'
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §21b — easter eggs
   Reachable by tapping the company badge in the top bar five times, which
   opens a code field. Each code pays out once per run.
   ═══════════════════════════════════════════════════════════════════════════ */

var CHEATS = [
  { id: 'empire', codes: ['אימפריה', 'EMPIRE'], n: 'מימון שקט',
    x: 'משקיע אנונימי העביר ' , f: function (G) {
      var amt = G.mode === 'creator' ? 0 : 25;
      if (G.mode === 'creator') { G.creator.bank += 450; return 'נכנסו $450K לחשבון הערוץ מתורם אלמוני.'; }
      G.cos[G.me].cash += amt;
      return 'נכנסו ' + fmtM(amt) + ' לקופה. אף אחד לא שואל מאיפה.';
    } },
  { id: 'prototype', codes: ['אבטיפוס', 'אב טיפוס', 'PROTOTYPE'], n: 'מעבדה חשאית',
    f: function (G) {
      if (G.mode === 'creator') { G.creator.skill = clamp(G.creator.skill + 14, 0, 100); return 'מצאתם ארגז ציוד נטוש. המיומנות קפצה.'; }
      var me = G.cos[G.me];
      TK.forEach(function (k) { me.tech[k] = clamp((me.tech[k] || 0) + 12, 0, 98); });
      return 'תיקיית מחקר שכוחה נפתחה. כל תחומי הטכנולוגיה עלו ב־12.';
    } },
  { id: 'singularity', codes: ['סינגולריות', 'SINGULARITY'], n: 'קפיצת מדרגה',
    f: function (G) {
      bumpHeat(G, ['xr', 'wearable'], 40);
      if (G.mode !== 'creator') {
        var me = G.cos[G.me];
        me.tech.ai = clamp(me.tech.ai + 20, 0, 98);
        me.catBrand.xr = clamp((me.catBrand.xr || 10) + 18, 5, 100);
      }
      return 'הדגמה אחת שינתה את השיחה. XR ולבישים בוערים.';
    } },
  { id: 'legend', codes: ['1984'], n: 'הפרסומת ההיא',
    f: function (G) {
      if (G.mode === 'creator') { G.creator.cred = clamp(G.creator.cred + 14, 0, 100); return 'סרטון ישן שלכם התגלה מחדש. האמינות עלתה.'; }
      var me = G.cos[G.me];
      me.brand = clamp(me.brand + 15, 5, 100);
      CK.forEach(function (k) { me.catBrand[k] = clamp((me.catBrand[k] || 20) + 6, 5, 100); });
      return 'קמפיין אחד, שישים שניות, והמותג זז 15 נקודות.';
    } },
  { id: 'credit', codes: ['אשראי', 'CREDIT'], n: 'בנקאי ידידותי',
    f: function (G) {
      G.creditBoost = 2.5;
      return 'מסגרת האשראי הוכפלה פי 2.5. השתמשו בזהירות.';
    } }
];

function applyCheat(G, raw) {
  var code = String(raw || '').trim().toUpperCase();
  if (!code) return { ok: false, why: 'לא הוזן קוד.' };
  G.cheats = G.cheats || {};
  for (var i = 0; i < CHEATS.length; i++) {
    var c = CHEATS[i];
    var hit = c.codes.some(function (x) { return x.toUpperCase() === code; });
    if (!hit) continue;
    if (G.cheats[c.id]) return { ok: false, why: 'הקוד הזה כבר מומש.' };
    G.cheats[c.id] = G.t + 1;   /* month 0 is falsy; store it one-based */
    var msg = c.f(G);
    pushLog(G, '🥚', c.n + ' — ' + msg, 'good');
    if (keys(G.cheats).length >= CHEATS.length) {
      pushLog(G, '🏆', 'מצאתם את כל הקודים. מי שקורא קוד מקור ראוי לזה.', 'good');
    }
    return { ok: true, msg: msg };
  }
  return { ok: false, why: 'הקוד לא מוכר.' };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE §22 — persistence & migration
   ═══════════════════════════════════════════════════════════════════════════ */

/* Saves outlive model changes. Every migration step is additive and defensive:
   a field that did not exist gets a sane default rather than crashing a load. */
function migrateSave(G) {
  if (!G || typeof G !== 'object') return null;
  var v = G.version || 1;
  registerCustom(G);

  if (v < 2) {
    G.plan = G.plan || {};
    G.plan.capexQueue = G.plan.capexQueue || [];
    G.plan.payout = G.plan.payout || 0;
    G.plan.press = G.plan.press || 0;
    G.contracts = G.contracts || {};
    v = 2;
  }
  if (v < 3) {
    G.hist = G.hist || {};
    ['t', 'cash', 'rev', 'profit', 'share', 'brand', 'mood'].forEach(function (k) {
      if (!Array.isArray(G.hist[k])) G.hist[k] = [];
    });
    G.board = G.board || { mood: 60, warnings: 0, payout: 0 };
    G.world = G.world || { demandMult: 1, costMult: 1, mood: 'יציב' };
    v = 3;
  }
  if (v < 4) {
    /* mechanics added after v3: ecosystem tracking, key talent, explicit
       borrowing and the creator crossover. All default to "none of that
       happened yet", which is exactly right for an older save. */
    keys(G.cos || {}).forEach(function (id) {
      var c = G.cos[id];
      if (!c.installed) c.installed = {};
      if (!c.staff) c.staff = [];
      if (c.overdraft == null) c.overdraft = c.debt || 0;
    });
    if (G.talent == null) G.talent = null;
    if (G.cheats == null) G.cheats = {};
    if (G.customDef === undefined) G.customDef = null;
    if (G.creatorPast === undefined) G.creatorPast = null;
    v = 4;
  }

  /* shape guards that apply to every version */
  G.version = VERSION;
  if (!G.horizon) G.horizon = HORIZON;
  G.log = G.log || [];
  G.prods = G.prods || [];
  G.disrupt = G.disrupt || {};
  G.seenTips = G.seenTips || {};
  CK.forEach(function (k) {
    G.market[k] = G.market[k] || { base: CATS[k].base, heat: 50, trend: 0, pool: 0, sold: 0, shares: {} };
    if (G.market[k].shares == null) G.market[k].shares = {};
  });
  keys(G.cos || {}).forEach(function (id) {
    var c = G.cos[id], d = CO_BY_ID[id];
    if (!d) return;
    if (!c.installed) c.installed = {};
    if (!c.staff) c.staff = [];
    if (c.overdraft == null) c.overdraft = 0;
    CK.forEach(function (k) { if (c.installed[k] == null) c.installed[k] = 0; });
    TK.forEach(function (k) { if (c.tech[k] == null) c.tech[k] = d.tech[k] != null ? d.tech[k] : 42; });
    CK.forEach(function (k) { if (c.catBrand[k] == null) c.catBrand[k] = d.catBrand[k] != null ? d.catBrand[k] : 30; });
    if (c.rev12 == null) c.rev12 = [];
    if (c.style == null) c.style = d.style;
  });
  G.prods.forEach(function (p) {
    if (p.rev_by == null) p.rev_by = {};
    if (p.peakSold == null) p.peakSold = p.sold || 0;
    if (p.auto == null) p.auto = 0;
    if (p.inv == null) p.inv = 0;
    if (p.prodPlan == null) p.prodPlan = 0;
  });
  if (G.mode === 'creator' && G.creator) {
    G.creator.hist = G.creator.hist || { views: [], subs: [], cred: [], burn: [] };
    G.creator.active = G.creator.active || [];
    G.creator.deals = G.creator.deals || [];
    G.creator.invites = G.creator.invites || [];
    G.algo = G.algo || { favor: 'review', strength: 1.2, since: 0 };
  }
  return G;
}

function saveGame(G) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(G)); return true; }
  catch (e) { return false; }
}
function loadGame() {
  try {
    var raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return migrateSave(JSON.parse(raw));
  } catch (e) { return null; }
}
function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

/* ═══════════════════════════════════════════════════════════════════════════
   UI §23 — DOM plumbing
   Everything below reads G and calls ENGINE. It never invents game state.
   ═══════════════════════════════════════════════════════════════════════════ */

var G = null;
var UI = { tab: 'dash', cat: 'phone', sheet: null, pick: null, mode: 'ceo', draft: null };
var $ = function (sel) { return document.querySelector(sel); };
var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
/* every number the player reads is monospaced, tabular and LTR-isolated */
var N = function (t, cls) { return '<span class="num' + (cls ? ' ' + cls : '') + '">' + esc(t) + '</span>'; };
var deltaCls = function (v) { return v > 0.0001 ? 'up' : (v < -0.0001 ? 'down' : 'flat'); };

var TABS = {
  ceo: [
    { id: 'dash', ic: '◈', n: 'לוח' },
    { id: 'prods', ic: '▤', n: 'מוצרים' },
    { id: 'market', ic: '◑', n: 'שוק' },
    { id: 'rnd', ic: '⌬', n: 'מו״פ' },
    { id: 'more', ic: '⋯', n: 'עוד' }
  ],
  creator: [
    { id: 'dash', ic: '◈', n: 'לוח' },
    { id: 'studio', ic: '▶', n: 'סטודיו' },
    { id: 'deals', ic: '◎', n: 'חסויות' },
    { id: 'market', ic: '◑', n: 'שוק' },
    { id: 'more', ic: '⋯', n: 'עוד' }
  ]
};

/* ── §24 SVG charts, generated as strings — no chart library, no network ── */

function svgLine(series, o) {
  o = o || {};
  var W = 320, H = o.h || 108, pad = 4, padB = 14;
  var all = [];
  series.forEach(function (s) { all = all.concat(s.data); });
  if (!all.length) return '<div class="empty">אין עדיין מספיק נתונים</div>';
  var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
  if (o.zero) lo = Math.min(0, lo);
  if (hi === lo) { hi = lo + 1; }
  var span = hi - lo;
  var n = Math.max.apply(null, series.map(function (s) { return s.data.length; }));
  var x = function (i) { return pad + (n < 2 ? 0 : (i / (n - 1)) * (W - pad * 2)); };
  var y = function (v) { return pad + (1 - (v - lo) / span) * (H - pad - padB); };

  var out = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(o.alt || 'תרשים קו') + '">';
  [0, .5, 1].forEach(function (f) {
    var yy = pad + f * (H - pad - padB);
    out += '<line x1="' + pad + '" y1="' + yy.toFixed(1) + '" x2="' + (W - pad) + '" y2="' + yy.toFixed(1) +
      '" stroke="var(--line-soft)" stroke-width="1"/>';
  });
  if (lo < 0 && hi > 0) {
    out += '<line x1="' + pad + '" y1="' + y(0).toFixed(1) + '" x2="' + (W - pad) + '" y2="' + y(0).toFixed(1) +
      '" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3"/>';
  }
  series.forEach(function (s) {
    if (s.data.length < 2) return;
    var d = s.data.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
    if (s.fill) {
      out += '<path d="' + d + ' L' + x(s.data.length - 1).toFixed(1) + ' ' + y(o.zero ? Math.max(0, lo) : lo).toFixed(1) +
        ' L' + x(0).toFixed(1) + ' ' + y(o.zero ? Math.max(0, lo) : lo).toFixed(1) + ' Z" fill="' + s.color + '" opacity=".12"/>';
    }
    out += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    var li = s.data.length - 1;
    out += '<circle cx="' + x(li).toFixed(1) + '" cy="' + y(s.data[li]).toFixed(1) + '" r="2.6" fill="' + s.color + '"/>';
  });
  out += '</svg>';
  return '<div dir="ltr">' + out + '</div>';
}

function svgDonut(parts, o) {
  o = o || {};
  var tot = sum(parts.map(function (p) { return p.v; })) || 1;
  var R = 42, C = 2 * Math.PI * R, acc = 0;
  var out = '<svg class="chart" viewBox="0 0 110 110" style="max-width:150px;margin:0 auto" role="img" aria-label="' + esc(o.alt || 'התפלגות') + '">';
  out += '<circle cx="55" cy="55" r="' + R + '" fill="none" stroke="var(--line-soft)" stroke-width="15"/>';
  parts.forEach(function (p) {
    var f = p.v / tot;
    if (f <= 0.0005) return;
    out += '<circle cx="55" cy="55" r="' + R + '" fill="none" stroke="' + p.c + '" stroke-width="15" ' +
      'stroke-dasharray="' + (f * C).toFixed(2) + ' ' + C.toFixed(2) + '" ' +
      'stroke-dashoffset="' + (-acc * C).toFixed(2) + '" transform="rotate(-90 55 55)"/>';
    acc += f;
  });
  if (o.mid) {
    out += '<text x="55" y="52" text-anchor="middle" fill="var(--ink)" font-size="17" font-family="JetBrains Mono, monospace" font-weight="700">' + esc(o.mid) + '</text>';
    out += '<text x="55" y="66" text-anchor="middle" fill="var(--ink-3)" font-size="9" font-family="Assistant, sans-serif">' + esc(o.midSub || '') + '</text>';
  }
  return out + '</svg>';
}

function svgBars(rows, o) {
  o = o || {};
  var hi = Math.max.apply(null, rows.map(function (r) { return r.v; })) || 1;
  return '<div class="stack">' + rows.map(function (r) {
    return '<div class="control"><div class="control-h"><label>' + esc(r.n) + '</label><output>' + esc(r.lab) + '</output></div>' +
      '<div class="bar ' + (r.cls || '') + '"><i style="width:' + (Math.max(0, r.v) / hi * 100).toFixed(1) + '%"></i></div></div>';
  }).join('') + '</div>';
}

function legend(items) {
  return '<div class="legend">' + items.map(function (i) {
    return '<span><i style="background:' + i.c + '"></i>' + esc(i.n) + '</span>';
  }).join('') + '</div>';
}

/* ── §25 bottom sheet ──────────────────────────────────────────────────── */

function openSheet(title, body, foot) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = body;
  var f = $('#sheetFoot');
  if (foot) { f.innerHTML = foot; f.hidden = false; } else { f.hidden = true; f.innerHTML = ''; }
  $('#scrim').hidden = false;
  $('#sheet').hidden = false;
  $('#sheetBody').scrollTop = 0;
  paintRanges($('#sheet'));
  UI.sheet = title;
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#scrim').hidden = true;
  UI.sheet = null;
  UI.draft = null;
}
var toastTimer = null;
function toast(msg) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('is-on'); }, 2600);
}

/* ── §26 shell chrome ──────────────────────────────────────────────────── */

function renderChrome() {
  var isCeo = G.mode === 'ceo';
  var me = isCeo ? G.cos[G.me] : null;
  $('#tbBadge').textContent = isCeo ? me.n.slice(0, 2).toUpperCase() : '▶';
  $('#tbName').textContent = isCeo ? me.he + ' · ' + me.n : G.creator.name;
  var hz = G.horizon || HORIZON;
  $('#tbDate').textContent = dateHe(G.t) + ' · חודש ' + (G.t + 1) + '/' + hz;
  $('#tbProg').style.width = (G.t / hz * 100).toFixed(1) + '%';

  var stats;
  if (isCeo) {
    stats = [
      { l: 'מזומן', v: fmtM(me.cash), c: me.cash > 0 ? '' : 'down' },
      { l: 'מותג', v: Math.round(me.brand), c: '' },
      { l: 'דירקטוריון', v: Math.round(G.board.mood), c: G.board.mood < 35 ? 'down' : (G.board.mood > 70 ? 'up' : '') }
    ];
  } else {
    var C = G.creator;
    stats = [
      { l: 'מנויים', v: fmtU(C.subs), c: '' },
      { l: 'אמינות', v: Math.round(C.cred), c: C.cred < 30 ? 'down' : '' },
      { l: 'שחיקה', v: Math.round(C.burn), c: C.burn > 70 ? 'down' : '' }
    ];
  }
  $('#tbStats').innerHTML = stats.map(function (s) {
    return '<span class="tb-stat"><b class="' + s.c + '">' + esc(s.v) + '</b><span>' + s.l + '</span></span>';
  }).join('');

  var tabs = TABS[G.mode];
  $('#tabs').innerHTML = tabs.map(function (t) {
    return '<button class="tab' + (UI.tab === t.id ? ' is-on' : '') + '" data-act="tab" data-v="' + t.id +
      '" role="tab" aria-selected="' + (UI.tab === t.id) + '"><i aria-hidden="true">' + t.ic + '</i><span>' + t.n + '</span></button>';
  }).join('');

  var nb = $('#nextBtn');
  if (G.over) {
    nb.querySelector('.next-lab').textContent = 'המשחק נגמר';
    $('#nextSub').textContent = '';
    nb.disabled = true;
  } else {
    nb.disabled = false;
    nb.querySelector('.next-lab').textContent = 'סיום ' + MONTHS_HE[turnM(G.t)];
    $('#nextSub').textContent = isCeo
      ? (G.fin.net != null && G.t > 0 ? fmtSign(G.fin.net) : '')
      : (G.t > 0 ? fmtU(G.creator.subs) + ' מנויים' : '');
  }
}

function render() {
  renderChrome();
  var fn = SCREENS[G.mode + ':' + UI.tab] || SCREENS[G.mode + ':dash'];
  $('#view').innerHTML = fn();
  paintRanges();
  $('#main').scrollTop = UI.keepScroll || 0;
  UI.keepScroll = 0;
}

/* Range inputs get a filled portion so the value reads at a glance. Tracks are
   laid out LTR (low → high) regardless of the RTL page. */
function paintRanges(root) {
  var list = (root || document).querySelectorAll('input[type=range]');
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    var min = +r.min || 0, max = +r.max || 100;
    var f = max > min ? (r.value - min) / (max - min) : 0;
    r.style.setProperty('--fill', (f * 100).toFixed(1) + '%');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI §27 — shared fragments
   ═══════════════════════════════════════════════════════════════════════════ */

function newsCard(limit) {
  var items = G.log.slice(0, limit || 5);
  if (!items.length) return '';
  return '<div class="card"><div class="card-h"><h3>מה קורה בתעשייה</h3>' +
    '<span class="hint">' + dateHe(G.t) + '</span></div><div class="ticker">' +
    items.map(tickRow).join('') + '</div></div>';
}

/* `sub` may mix a Hebrew label with a number; the number is isolated so a
   leading + or − never lands on the wrong side of it in an RTL line. */
/* Every world event states what it actually did — there is no flavour-only
   news in this game, so the ticker always has an effect line to show. */
function tickRow(l, withDate) {
  return '<div class="tick"><i>' + l.ic + '</i><span>' +
    (withDate ? esc(dateHe(l.t)) + ' — ' : '') + esc(l.x) +
    (l.e ? '<em>↳ ' + esc(l.e) + '</em>' : '') + '</span></div>';
}

function kpi(lab, val, sub, cls) {
  var subHtml = '';
  if (sub) {
    subHtml = esc(sub).replace(/[-+−]?[$]?[\d][\d.,]*[%A-Za-z$]*/g, function (m) { return '</span>' + N(m) + '<span>'; });
    subHtml = '<span class="k-sub ' + (cls || 'mut') + '"><span>' + subHtml + '</span></span>';
  }
  return '<div class="kpi"><span class="k-lab">' + esc(lab) + '</span>' +
    '<span class="k-val ' + (cls || '') + '">' + esc(val) + '</span>' + subHtml + '</div>';
}

var CO_COLORS = ['var(--accent)', 'var(--cyan)', 'var(--violet)', '#3FCF8E', '#F0B429', '#F2545B', '#7C8AA8', '#54B8F2'];
function coColor(id, i) { return id === G.me ? 'var(--accent)' : CO_COLORS[(i % (CO_COLORS.length - 1)) + 1]; }

/* ═══════════════════════════════════════════════════════════════════════════
   UI §28 — CEO screens
   ═══════════════════════════════════════════════════════════════════════════ */

var SCREENS = {};

SCREENS['ceo:dash'] = function () {
  var me = G.cos[G.me], A = ARCH[me.arch], h = G.hist;
  var mine = G.prods.filter(function (p) { return p.co === G.me && p.live && !p.dead; });
  var used = capacityUsed(G, me), cap = effectiveCapacity(G, me);
  var so = sum(mine.map(function (p) { return p.stockout || 0; }));
  var inv = sum(mine.map(function (p) { return p.inv || 0; }));
  var out = '';

  out += '<div class="kpis">' +
    kpi('מזומן', fmtM(me.cash), me.debt > 0 ? 'חוב ' + fmtM(me.debt) : '', me.debt > 0 ? 'down' : 'mut') +
    kpi('הכנסה חודשית', fmtM(G.fin.revDev + G.fin.revOther), 'מוצרים ' + fmtM(G.fin.revDev)) +
    kpi('רווח נקי', fmtSign(G.fin.net || 0), 'שוליים ' + fmtPct(G.fin.margin || 0, 0), deltaCls(G.fin.net || 0)) +
    kpi('נתח שוק', fmtPct(me.shareVal || 0, 1), fmtU(G.tick ? G.tick.units : 0) + ' יחידות') +
    '</div>';

  /* board */
  var mood = G.board.mood;
  var moodCls = mood < 35 ? 'b' : (mood < 55 ? 'w' : 'g');
  out += '<div class="card card-accent"><div class="card-h"><h3>' + esc(A.n) + '</h3>' +
    '<span class="hint">' + (G.board.warnings ? '⚠ ' + G.board.warnings + '/3 אזהרות' : 'ללא אזהרות') + '</span></div>' +
    '<div class="control"><div class="control-h"><label>מצב רוח</label><output>' + Math.round(mood) + '/100' +
    (G.board.delta != null ? ' (' + fmtSignPct(G.board.delta / 100, 1).replace('%', '') + ')' : '') + '</output></div>' +
    '<div class="bar ' + moodCls + '"><i style="width:' + mood.toFixed(0) + '%"></i></div></div>' +
    '<p class="note" style="margin-top:11px">' + esc(G.board.lastNote || A.d) + '</p>' +
    '<button class="btn btn-sm btn-ghost" data-act="finance" data-v="board" style="margin-top:11px;width:100%">כספים ודירקטוריון</button>' +
    '</div>';

  out += ecoCard();

  /* capacity */
  var pct = cap > 0 ? used / cap * 100 : 0;
  out += '<div class="card"><div class="card-h"><h3>קיבולת ייצור</h3>' +
    '<span class="hint">' + fmtU(cap) + ' יח׳/חודש</span></div>' +
    '<div class="control"><div class="control-h"><label>ניצול התוכנית</label><output>' + pct.toFixed(0) + '%</output></div>' +
    '<div class="bar ' + (pct > 100 ? 'b' : pct > 88 ? 'w' : 'c') + '"><i style="width:' + Math.min(100, pct).toFixed(0) + '%"></i></div></div>' +
    '<div class="facts" style="margin-top:11px">' +
    '<div class="fact"><span>מלאי</span><b>' + fmtU(inv) + '</b></div>' +
    '<div class="fact"><span>חוסר במלאי</span><b class="' + (so > 0.01 ? 'down' : '') + '">' + fmtU(so) + '</b></div>' +
    '<div class="fact"><span>קווים בבנייה</span><b>' + (G.plan.capexQueue || []).length + '</b></div>' +
    '</div>' +
    (pct > 100 ? '<p class="note note-warn" style="margin-top:10px">התוכנית חורגת מהקיבולת. הייצור ייחתך באופן יחסי בכל המוצרים.</p>' : '') +
    (so > 0.05 ? '<p class="note note-bad" style="margin-top:10px">נגמר המלאי ל־' + fmtU(so) + ' קונים שרצו לקנות מאיתנו. זו הכנסה שלא תחזור.</p>' : '') +
    '<button class="btn btn-sm btn-ghost" data-act="capexSheet" style="margin-top:10px;width:100%">הרחבת קיבולת</button>' +
    '</div>';

  /* charts */
  if (h.rev.length > 1) {
    out += '<div class="card"><div class="card-h"><h3>הכנסה ורווח</h3><span class="hint">' + h.rev.length + ' חודשים</span></div>' +
      svgLine([
        { data: h.rev, color: 'var(--cyan)', fill: 1 },
        { data: h.profit, color: 'var(--accent)' }
      ], { zero: 1, alt: 'הכנסה ורווח לאורך זמן' }) +
      legend([{ n: 'הכנסה כוללת', c: 'var(--cyan)' }, { n: 'רווח נקי', c: 'var(--accent)' }]) + '</div>';
  }
  if (h.share.length > 1) {
    out += '<div class="card"><div class="card-h"><h3>נתח שוק ומותג</h3></div>' +
      svgLine([
        { data: h.share, color: 'var(--accent)', fill: 1 },
        { data: h.brand, color: 'var(--violet)' }
      ], { alt: 'נתח שוק ומותג' }) +
      legend([{ n: 'נתח שוק (%)', c: 'var(--accent)' }, { n: 'מותג', c: 'var(--violet)' }]) + '</div>';
  }

  out += newsCard(6);
  return out;
};

/* Ecosystem lock-in, made visible: which categories are pulling for you, and
   what that pull is currently worth in the next category you enter. */
function ecoCard() {
  var me = G.cos[G.me];
  var rows = CK.map(function (k) {
    return { k: k, held: clamp((me.installed[k] || 0) / Math.max(1, G.market[k].base), 0, 1) };
  }).sort(function (a, b) { return b.held - a.held; });
  var best = rows[0];
  var pulls = CK.map(function (k) { return { k: k, v: ecoPull(G, me, k) }; })
    .sort(function (a, b) { return b.v - a.v; });

  return '<div class="card card-violet"><div class="card-h"><h3>אקוסיסטם</h3>' +
    '<span class="hint">משיכה עד ' + fmtPct(ECO_MAX, 0) + '</span></div>' +
    '<p class="note">מי שכבר מחזיק מכשיר שלנו נוטה לקנות את המכשיר הבא שלו מאיתנו. ככל שיש לנו יותר מכשירים חיים בידיים של אנשים בקטגוריות אחרות — כך קל יותר להיכנס לקטגוריה חדשה.</p>' +
    '<div class="stack" style="margin-top:12px">' + pulls.slice(0, 3).map(function (r) {
      return '<div class="control"><div class="control-h"><label>' + CATS[r.k].ic + ' ' + esc(CATS[r.k].n) +
        '</label><output>' + fmtSignPct(ECO_MAX * r.v, 0) + ' משקל</output></div>' +
        '<div class="bar v"><i style="width:' + (r.v * 100).toFixed(0) + '%"></i></div></div>';
    }).join('') + '</div>' +
    '<div class="facts" style="margin-top:12px">' + rows.slice(0, 3).map(function (r) {
      return '<div class="fact"><span>' + esc(CATS[r.k].n) + '</span><b>' + fmtU(me.installed[r.k] || 0) + '</b></div>';
    }).join('') + '</div>' +
    (best && best.held > 0.02
      ? '<p class="note note-good" style="margin-top:11px">' + fmtU(me.installed[best.k] || 0) + ' מכשירי ' +
        esc(CATS[best.k].n) + ' שלנו נמצאים בידיים של אנשים כרגע. זו הדלת לקטגוריה הבאה.</p>'
      : '<p class="note note-warn" style="margin-top:11px">כמעט אין לנו בסיס מותקן. כל כניסה לקטגוריה חדשה תהיה מאפס.</p>') +
    '</div>';
}

function prodCard(p) {
  var me = G.cos[G.me];
  var C = CATS[p.cat];
  if (!p.live) {
    return '<button class="scard" data-act="prod" data-v="' + p.id + '">' +
      '<div class="scard-h"><span>' + C.ic + '</span><b>' + esc(p.name) + '</b>' +
      '<span class="tag tag-violet">בפיתוח</span></div>' +
      '<div class="facts">' +
      '<div class="fact"><span>השקה בעוד</span><b>' + p.devLeft + ' ח׳</b></div>' +
      '<div class="fact"><span>מחיר יעד</span><b>' + fmtPrice(p.price) + '</b></div>' +
      '<div class="fact"><span>איכות צפויה</span><b>' + qualityOf(G, me, p).toFixed(0) + '</b></div>' +
      '</div></button>';
  }
  var q = qualityOf(G, me, p);
  var cost = unitCostOf(G, me, p);
  var margin = p.price > 0 ? (p.price - cost) / p.price : 0;
  var sc = scoreOf(G, me, p);
  var age = G.t - p.born;
  var tags = '';
  if (p.auto) tags += '<span class="tag tag-cyan">ניהול אוטומטי</span>';
  if (p.stockout > (p.demand || 0) * 0.08 && p.stockout > 0.01) tags += '<span class="tag tag-bad">חוסר במלאי</span>';
  if (p.inv > Math.max(0.05, (p.sold || 0) * 2.5)) tags += '<span class="tag tag-warn">מלאי מת</span>';
  if (margin < 0.08) tags += '<span class="tag tag-bad">שוליים דקים</span>';

  return '<button class="scard is-me" data-act="prod" data-v="' + p.id + '">' +
    '<div class="scard-h"><span>' + C.ic + '</span><b>' + esc(p.name) + '</b>' +
    '<span class="num" style="color:var(--accent-2)">' + fmtPrice(p.price) + '</span></div>' +
    (tags ? '<div class="chips">' + tags + '</div>' : '') +
    '<div class="facts">' +
    '<div class="fact"><span>ציון מוצר</span><b>' + sc.toFixed(0) + '</b></div>' +
    '<div class="fact"><span>נמכר</span><b>' + fmtU(p.sold || 0) + '</b></div>' +
    '<div class="fact"><span>הכנסה</span><b>' + fmtM(p.rev || 0) + '</b></div>' +
    '<div class="fact"><span>שוליים</span><b class="' + (margin < 0.1 ? 'down' : '') + '">' + fmtPct(margin, 0) + '</b></div>' +
    '<div class="fact"><span>מלאי</span><b>' + fmtU(p.inv || 0) + '</b></div>' +
    '<div class="fact"><span>גיל</span><b>' + age + ' ח׳</b></div>' +
    '</div></button>';
}

SCREENS['ceo:prods'] = function () {
  var mine = G.prods.filter(function (p) { return p.co === G.me && !p.dead; });
  var live = mine.filter(function (p) { return p.live; }).sort(function (a, b) { return (b.rev || 0) - (a.rev || 0); });
  var dev = mine.filter(function (p) { return !p.live; });
  var out = '';

  out += '<div class="card card-accent"><div class="card-h"><h3>קו המוצרים</h3>' +
    '<span class="hint">' + live.length + ' בשוק · ' + dev.length + ' בפיתוח</span></div>' +
    '<button class="btn btn-primary" data-act="newProd" style="width:100%">תכנון מוצר חדש</button>' +
    (live.length > 1 ? '<button class="btn btn-sm btn-ghost" data-act="autoAll" style="width:100%;margin-top:8px">הפעלת ניהול אוטומטי לכל המוצרים מעל שנה</button>' : '') +
    '</div>';

  if (dev.length) {
    out += '<h3 class="sec-title">בפיתוח</h3><div class="stack">' + dev.map(prodCard).join('') + '</div>';
  }
  out += '<h3 class="sec-title">בשוק</h3>';
  out += live.length ? '<div class="stack">' + live.map(prodCard).join('') + '</div>'
    : '<div class="card"><div class="empty">אין לנו אף מוצר בשוק. הדירקטוריון שם לב.</div></div>';
  return out;
};

SCREENS['ceo:market'] = function () {
  var cat = UI.cat, m = G.market[cat], C = CATS[cat];
  var out = '<div class="chips" style="margin-bottom:2px">' + CK.map(function (k) {
    return '<button class="chip' + (k === cat ? ' is-on' : '') + '" data-act="cat" data-v="' + k + '">' +
      CATS[k].ic + ' ' + CATS[k].n + '</button>';
  }).join('') + '</div>';

  var ids = keys(m.shares).sort(function (a, b) { return m.shares[b] - m.shares[a]; });
  var parts = ids.slice(0, 7).map(function (id, i) { return { v: m.shares[id], c: coColor(id, i) }; });
  var rest = sum(ids.slice(7).map(function (id) { return m.shares[id]; }));
  if (rest > 0) parts.push({ v: rest, c: 'var(--line)' });

  out += '<div class="card card-cyan"><div class="card-h"><h3>' + C.ic + ' ' + C.n + '</h3>' +
    '<span class="hint">מחזור החלפה ' + C.life + ' ח׳</span></div>' +
    '<div class="facts">' +
    '<div class="fact"><span>בסיס מותקן</span><b>' + fmtU(m.base) + '</b></div>' +
    '<div class="fact"><span>קונים החודש</span><b>' + fmtU(m.pool) + '</b></div>' +
    '<div class="fact"><span>חום קטגוריה</span><b class="' + (m.heat > 62 ? 'up' : m.heat < 40 ? 'down' : '') + '">' + Math.round(m.heat) + '</b></div>' +
    '<div class="fact"><span>נמכר בפועל</span><b>' + fmtU(m.sold) + '</b></div>' +
    '</div>' +
    '<p class="note" style="margin-top:11px">רק ' + fmtPct(m.pool / Math.max(1, m.base), 1) +
    ' מהבסיס המותקן מחליף מכשיר החודש. זו התקרה — אי אפשר למכור למי שקנה בשנה שעברה.</p>' +
    '</div>';

  out += '<div class="card"><div class="card-h"><h3>נתחי שוק</h3><span class="hint">לפי יחידות</span></div>' +
    svgDonut(parts, { mid: fmtPct(m.shares[G.me] || 0, 0), midSub: 'שלנו', alt: 'נתחי שוק' }) +
    legend(ids.slice(0, 7).map(function (id, i) {
      return { n: G.cos[id].n + ' ' + fmtPct(m.shares[id], 1), c: coColor(id, i) };
    })) + '</div>';

  out += '<h3 class="sec-title">מי מוכר כאן</h3><div class="stack">' + ids.slice(0, 8).map(function (id) {
    var co = G.cos[id];
    var ps = liveProducts(G, cat).filter(function (p) { return p.co === id; })
      .sort(function (a, b) { return b.lastShare - a.lastShare; });
    var top = ps[0];
    return '<div class="scard' + (id === G.me ? ' is-me' : '') + '">' +
      '<div class="scard-h"><b>' + esc(co.n) + '</b>' +
      '<span class="num" style="color:var(--cyan)">' + fmtPct(m.shares[id], 1) + '</span></div>' +
      '<div class="facts">' +
      '<div class="fact"><span>מותג בקטגוריה</span><b>' + Math.round(co.catBrand[cat] || 0) + '</b></div>' +
      '<div class="fact"><span>דגמים</span><b>' + ps.length + '</b></div>' +
      (top ? '<div class="fact"><span>מוביל</span><b>' + fmtPrice(top.price) + '</b></div>' : '') +
      '<div class="fact"><span>קיבולת</span><b>' + fmtU(co.capacity) + '</b></div>' +
      '</div>' +
      (top ? '<small class="mut">' + esc(top.name) + ' · ציון ' + scoreOf(G, co, top).toFixed(0) + '</small>' : '') +
      '</div>';
  }).join('') + '</div>';

  out += '<div class="card"><div class="card-h"><h3>פילוח מדפים</h3><span class="hint">איפה הקונים</span></div>' +
    svgBars(BANDS.map(function (b) {
      return { n: BAND_HE[b] + ' · סביב ' + fmtPrice(C.bandRef[b]), v: C.bands[b], lab: fmtPct(C.bands[b], 0), cls: 'c' };
    })) + '</div>';

  return out;
};

SCREENS['ceo:rnd'] = function () {
  var me = G.cos[G.me];
  var tot = sum(TK.map(function (k) { return G.plan.rnd[k] || 0; }));
  var out = '<div class="card card-violet"><div class="card-h"><h3>תקציב מו״פ</h3>' +
    '<span class="hint num">' + fmtM(tot) + ' לחודש</span></div>' +
    '<p class="note">רמות טכנולוגיה מרימות את איכות הרכיבים ואת שכבת התוכנה. חצייה של רף בחזית התעשייה מייצרת פריצת דרך — ופריצת דרך היא מה שמחמם קטגוריה שלמה, לא תקציב השיווק.</p>' +
    '</div>';

  out += '<div class="card"><div class="spec-grid">' + TK.map(function (k) {
    var T = TECH[k], lvl = me.tech[k] || 0, fr = frontier(G, k);
    var mine = Math.round(lvl), lead = Math.round(fr);
    var nextGate = Math.max(60, (Math.floor(lvl / 10) + 1) * 10);
    var gateTxt = nextGate > 98 ? 'בשיא' : N(nextGate);
    return '<div class="control">' +
      '<div class="control-h"><label>' + esc(T.n) + '</label><output>' + fmtM(G.plan.rnd[k] || 0) + '</output></div>' +
      '<div class="bar v"><i style="width:' + lvl.toFixed(0) + '%"></i></div>' +
      '<div style="display:flex;gap:8px;justify-content:space-between;font-size:11.5px;color:var(--ink-3)">' +
      '<span>רמה ' + N(mine) + (fr > lvl + 0.5 ? ' · החזית ' + N(lead) : ' · אנחנו בחזית') + '</span>' +
      '<span>רף הבא ' + gateTxt + '</span></div>' +
      '<input type="range" min="0" max="100" value="' + Math.round(rndSliderVal(k) * 100) +
      '" data-act="rnd" data-v="' + k + '" aria-label="' + esc(T.n) + '">' +
      '<small class="mut">' + esc(T.d) + '</small>' +
      '</div>';
  }).join('') + '</div></div>';

  out += talentCard();

  out += '<div class="card"><div class="card-h"><h3>חזית התעשייה</h3></div>' +
    svgBars(TK.map(function (k) {
      var top = null, tv = -1;
      keys(G.cos).forEach(function (id) { var v = G.cos[id].tech[k] || 0; if (v > tv) { tv = v; top = G.cos[id]; } });
      return { n: TECH[k].n + ' — ' + top.n, v: tv, lab: Math.round(tv) + '', cls: 'v' };
    })) + '</div>';
  return out;
};

/* Key talent: a shortcut past years of research, priced accordingly. */
function talentCard() {
  var me = G.cos[G.me];
  var staff = me.staff || [];
  var market = (G.talent && G.talent.market) || [];
  return '<div class="card"><div class="card-h"><h3>כישרונות מפתח</h3>' +
    '<span class="hint">' + (market.length ? market.length + ' זמינים' : 'אין מועמדים') + '</span></div>' +
    '<p class="note">כסף לבדו לא קונה עשור של ניסיון. חטיפה של אדם ספציפי מזיזה תחום טכנולוגי מיד, מאיצה בו את המחקר כל עוד הוא אצלנו — ומורידה את אותה יכולת אצל מי שאיבד אותו.</p>' +
    (staff.length
      ? '<div class="rows" style="margin-top:12px">' + staff.map(function (t) {
          return '<div class="row"><span class="row-main"><b>' + esc(t.name) + '</b><small>' +
            esc(ROLES[t.role].n) + ' · אצלנו ' + (G.t - t.since) + ' חודשים</small></span>' +
            '<span class="row-end"><b class="up">+' + t.boost.toFixed(1) + '</b><small>' + fmtM(t.salary) + '</small></span></div>';
        }).join('') + '</div>'
      : '') +
    '<button class="btn btn-sm ' + (market.length ? 'btn-primary' : 'btn-ghost') + '" data-act="talentSheet" style="margin-top:12px;width:100%"' +
    (market.length ? '' : ' disabled') + '>' + (market.length ? 'שוק הכישרונות' : 'אין מועמדים החודש') + '</button>' +
    '</div>';
}

/* Slider range for one R&D domain: roughly four times what a typical company
   of this size would spend there, so the default sits low on the track and
   there is real headroom to over-invest. */
function rndCeiling() {
  var me = G.cos[G.me];
  var scale = me.otherRev * 0.6 + (G.fin.revDev || 0) * 0.9 + 0.06;
  return Math.max(0.012, 0.10 * scale / TK.length * 4);
}
function rndSliderVal(k) {
  return clamp((G.plan.rnd[k] || 0) / rndCeiling(), 0, 1);
}

SCREENS['ceo:more'] = function () {
  var me = G.cos[G.me], f = G.fin;
  var out = '';

  out += '<div class="card card-accent"><div class="card-h"><h3>כספים ודירקטוריון</h3>' +
    '<span class="hint num">' + fmtSign(f.net || 0) + '</span></div>' +
    '<p class="note">דוח החודש, מסגרת האשראי וציפיות הדירקטוריון — הכול בחלון אחד.</p>' +
    '<div class="btn-row" style="margin-top:12px">' +
    '<button class="btn btn-sm btn-primary" data-act="finance" data-v="pl">דוח</button>' +
    '<button class="btn btn-sm btn-ghost" data-act="finance" data-v="credit">אשראי</button>' +
    '<button class="btn btn-sm btn-ghost" data-act="finance" data-v="board">דירקטוריון</button>' +
    '</div></div>';

  out += '<div class="card"><div class="card-h"><h3>שרשרת אספקה</h3><span class="hint">' +
    (keys(G.disrupt || {}).length ? '⚠ שיבוש פעיל' : 'תקין') + '</span></div><div class="rows">' +
    keys(PARTS).filter(function (part) { return suppliersFor(part).length; }).map(function (part) {
      var sup = SUP_BY_ID[G.contracts[part]];
      var dis = sup && (G.disrupt || {})[sup.id];
      return '<button class="row" data-act="supplier" data-v="' + part + '">' +
        '<span class="row-main"><b>' + esc(PARTS[part].n) + '</b><small>' + (sup ? esc(sup.n + ' · ' + sup.geo) : 'ללא חוזה') +
        (dis ? ' · שיבוש ' + dis.m + ' ח׳' : '') + '</small></span>' +
        '<span class="row-end"><b class="' + (dis ? 'down' : '') + '">' + (sup ? 'x' + sup.price.toFixed(2) : '—') + '</b>' +
        '<small>איכות ' + (sup ? 'x' + sup.q.toFixed(2) : '—') + '</small></span>' +
        '<span class="chev">‹</span></button>';
    }).join('') + '</div></div>';

  out += '<div class="card"><div class="card-h"><h3>חשיפה מוקדמת ליוצרים</h3>' +
    '<span class="hint num">' + (G.plan.press || 0) + '/3</span></div>' +
    '<input type="range" min="0" max="3" value="' + (G.plan.press || 0) + '" data-act="press" aria-label="חשיפה מוקדמת">' +
    '<small class="mut">יחידות ביקורת מוקדמות משפרות מעט את ציוני הפתיחה. לא מספיק כדי להציל מכשיר גרוע.</small>' +
    '</div>';

  out += '<div class="card"><div class="card-h"><h3>יוצרי התוכן</h3><span class="hint">מי קובע את הטון</span></div><div class="rows">' +
    CREATORS.map(function (cr) {
      var last = null;
      G.prods.forEach(function (p) {
        if (p.co === G.me && p.rev_by && p.rev_by[cr.id] && (!last || p.born > last.born)) last = p;
      });
      return '<div class="row"><span class="row-main"><b>' + esc(cr.n) + '</b><small>' + esc(cr.d) + '</small></span>' +
        '<span class="row-end"><b>' + (last ? last.rev_by[cr.id].toFixed(1) : '—') + '</b><small>' + fmtU(cr.reach) + '</small></span></div>';
    }).join('') + '</div></div>';

  out += '<div class="card"><div class="card-h"><h3>יומן</h3></div><div class="ticker">' +
    G.log.slice(0, 24).map(function (l) { return tickRow(l, 1); }).join('') + '</div></div>';

  out += settingsCard();
  return out;
};

function ledRow(n, v) {
  return '<div class="led"><span>' + esc(n) + '</span><b class="' + deltaCls(v) + '">' + fmtSign(v) + '</b></div>';
}

function settingsCard() {
  return '<div class="card"><div class="card-h"><h3>המשחק</h3><span class="hint">גרסה ' + VERSION + '</span></div>' +
    '<p class="note">זרע העולם: ' + N(G.seed) + '. שמירה אוטומטית בכל סוף חודש.</p>' +
    '<div class="btn-row" style="margin-top:10px">' +
    '<button class="btn btn-sm btn-ghost" data-act="save">שמירה עכשיו</button>' +
    '<button class="btn btn-sm btn-danger" data-act="reset">משחק חדש</button>' +
    '</div></div>';
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI §29 — creator screens
   ═══════════════════════════════════════════════════════════════════════════ */

function fmtK(k) {
  var a = Math.abs(k), sign = k < 0 ? '-' : '';
  if (a >= 1000) return sign + '$' + (a / 1000).toFixed(1) + 'M';
  return sign + '$' + a.toFixed(a >= 100 ? 0 : 1) + 'K';
}
function fmtSignK(k) { return (k >= 0 ? '+' : '−') + fmtK(Math.abs(k)); }

SCREENS['creator:dash'] = function () {
  var C = G.creator, h = G.hist, out = '';
  var dSubs = C.subs - (C.subsLast || C.subs);

  out += '<div class="kpis">' +
    kpi('מנויים', fmtU(C.subs), (dSubs >= 0 ? '+' : '−') + fmtU(Math.abs(dSubs)), deltaCls(dSubs)) +
    kpi('צפיות בחודש', fmtU(C.views || 0), C.hiatus > 0 ? 'בהפסקה' : (G.algo ? 'דחיפה: ' + FORMATS[G.algo.favor].n : '')) +
    kpi('בבנק', fmtK(C.bank), fmtSignK(C.income || 0), deltaCls(C.income || 0)) +
    kpi('אמינות', Math.round(C.cred), 'שחיקה ' + Math.round(C.burn), C.cred < 32 ? 'down' : '') +
    '</div>';

  var bCls = C.burn > 78 ? 'b' : C.burn > 55 ? 'w' : 'g';
  out += '<div class="card card-accent"><div class="card-h"><h3>מצב הערוץ</h3>' +
    '<span class="hint">' + (C.hiatus > 0 ? 'הפסקה כפויה · ' + C.hiatus + ' ח׳' : 'באוויר') + '</span></div>' +
    '<div class="control"><div class="control-h"><label>שחיקה</label><output>' + Math.round(C.burn) + '/100</output></div>' +
    '<div class="bar ' + bCls + '"><i style="width:' + C.burn.toFixed(0) + '%"></i></div></div>' +
    '<div class="control" style="margin-top:10px"><div class="control-h"><label>אמינות</label><output>' + Math.round(C.cred) + '/100</output></div>' +
    '<div class="bar ' + (C.cred < 32 ? 'b' : 'c') + '"><i style="width:' + C.cred.toFixed(0) + '%"></i></div></div>' +
    '<p class="note ' + (C.burn > 78 ? 'note-bad' : C.burn > 55 ? 'note-warn' : '') + '" style="margin-top:11px">' +
    (C.burn > 78 ? 'עוד חודש בקצב הזה והערוץ יוצא להפסקה כפויה.'
      : C.burn > 55 ? 'הקצב מתחיל להיות בלתי אפשרי. חודש רגוע יחזיר את האיכות.'
        : 'הקצב בר־קיימא. אפשר להעלות הילוך אם יש סיבה.') + '</p></div>';

  out += '<div class="card card-violet"><div class="card-h"><h3>האלגוריתם</h3>' +
    '<span class="hint">מאז ' + dateHe(G.algo.since) + '</span></div>' +
    '<p class="note">הפלטפורמה דוחפת כרגע <b>' + esc(FORMATS[G.algo.favor].n) + '</b> במכפיל ' +
    N('×' + G.algo.strength.toFixed(2)) + '. כל שאר הפורמטים סופגים את ההפרש. זה ישתנה שוב בלי הודעה מראש.</p>' +
    svgBars(FK.map(function (k) {
      var mult = k === G.algo.favor ? G.algo.strength : 1 / Math.pow(G.algo.strength, 0.45);
      return { n: FORMATS[k].n, v: mult, lab: '×' + mult.toFixed(2), cls: k === G.algo.favor ? 'v' : '' };
    })) + '</div>';

  if (h.share.length > 1) {
    out += '<div class="card"><div class="card-h"><h3>מנויים וצפיות</h3></div>' +
      svgLine([{ data: h.share, color: 'var(--accent)', fill: 1 }, { data: h.profit, color: 'var(--cyan)' }], { zero: 1, alt: 'מנויים וצפיות' }) +
      legend([{ n: 'מנויים (מיליונים)', c: 'var(--accent)' }, { n: 'צפיות בחודש', c: 'var(--cyan)' }]) + '</div>';
  }
  if (h.brand.length > 1) {
    out += '<div class="card"><div class="card-h"><h3>אמינות מול שחיקה</h3></div>' +
      svgLine([{ data: h.brand, color: 'var(--cyan)' }, { data: h.mood, color: 'var(--good)' }], { alt: 'אמינות מול שחיקה' }) +
      legend([{ n: 'אמינות', c: 'var(--cyan)' }, { n: 'אנרגיה (100 פחות שחיקה)', c: 'var(--good)' }]) + '</div>';
  }

  out += crossoverCard();
  out += newsCard(6);
  return out;
};

/* The moment a channel becomes leverage. Shown as a locked goal until the
   thresholds are met, so the player can steer toward it deliberately. */
function crossoverCard() {
  var C = G.creator;
  var subsOk = C.subs >= XOVER_SUBS, credOk = C.cred >= XOVER_CRED;
  if (subsOk && credOk) {
    return '<div class="card card-accent"><div class="card-h"><h3>הרחבה לתעשייה</h3>' +
      '<span class="tag tag-accent">נפתח</span></div>' +
      '<p class="note">הקהל והאמינות מספיקים כדי לגייס הון — או כדי שדירקטוריון יציע לכם כיסא. אפשר להקים חברה משלכם בהון של ' +
      N(fmtM(raiseAmount(G))) + ', או לקחת פיקוד על חברה קיימת שמדשדשת.</p>' +
      '<button class="btn btn-primary" data-act="expand" style="width:100%;margin-top:12px">לבחון את המעבר</button></div>';
  }
  return '<div class="card"><div class="card-h"><h3>הרחבה לתעשייה</h3>' +
    '<span class="hint">נעול</span></div>' +
    '<p class="note">ערוץ מספיק גדול ומספיק אמין יכול להפסיק לסקר את התעשייה ולהתחיל להיות חלק ממנה — להקים חברה או לקבל כיסא מנכ״ל.</p>' +
    '<div class="stack" style="margin-top:12px">' +
    '<div class="control"><div class="control-h"><label>מנויים</label><output class="' + (subsOk ? 'up' : '') + '">' +
    fmtU(C.subs) + ' / ' + fmtU(XOVER_SUBS) + '</output></div>' +
    '<div class="bar ' + (subsOk ? 'g' : '') + '"><i style="width:' + clamp(C.subs / XOVER_SUBS * 100, 0, 100).toFixed(0) + '%"></i></div></div>' +
    '<div class="control"><div class="control-h"><label>אמינות</label><output class="' + (credOk ? 'up' : '') + '">' +
    Math.round(C.cred) + ' / ' + XOVER_CRED + '</output></div>' +
    '<div class="bar c"><i style="width:' + clamp(C.cred / XOVER_CRED * 100, 0, 100).toFixed(0) + '%"></i></div></div>' +
    '</div></div>';
}

SCREENS['creator:studio'] = function () {
  var C = G.creator, P = C.plan;
  var effort = 0;
  FK.forEach(function (k) { effort += (P.mix[k] || 0) * FORMATS[k].effort; });
  var load = P.videos * effort;
  var proj = clamp(C.burn + (load - 3.0) * 2.4 - 2.0, 0, 100);
  var out = '';

  out += '<div class="card card-accent"><div class="card-h"><h3>לוח ההפקה</h3>' +
    '<span class="hint">' + dateHe(G.t) + '</span></div>' +
    '<div class="control"><div class="control-h"><label>סרטונים החודש</label><output>' + P.videos + '</output></div>' +
    '<input type="range" min="0" max="12" value="' + P.videos + '" data-act="vids" aria-label="מספר סרטונים"' +
    (P.rest ? ' disabled' : '') + '></div>' +
    '<button class="switch' + (P.rest ? ' is-on' : '') + '" data-act="rest" aria-pressed="' + !!P.rest + '">' +
    '<span class="switch-txt"><b>חודש הפסקה</b><small>השחיקה יורדת בחדות, הצפיות והמנויים נופלים. לפעמים זו ההחלטה היחידה שנשארה.</small></span>' +
    '<span class="switch-box"></span></button>' +
    '<div class="control" style="margin-top:6px"><div class="control-h"><label>עומס צפוי</label>' +
    '<output class="' + (proj > 78 ? 'down' : proj > 55 ? '' : 'up') + '">שחיקה ' + N(Math.round(C.burn) + ' → ' + Math.round(proj)) + '</output></div>' +
    '<div class="bar ' + (proj > 78 ? 'b' : proj > 55 ? 'w' : 'g') + '"><i style="width:' + proj.toFixed(0) + '%"></i></div></div>' +
    '</div>';

  out += '<div class="card"><div class="card-h"><h3>תמהיל הפורמטים</h3><span class="hint">מסתכם ל־100%</span></div>' +
    '<div class="spec-grid">' + FK.map(function (k) {
      var F = FORMATS[k];
      return '<div class="control"><div class="control-h"><label>' + esc(F.n) +
        (G.algo.favor === k ? ' <span class="tag tag-violet">נדחף</span>' : '') + '</label>' +
        '<output>' + fmtPct(P.mix[k] || 0, 0) + '</output></div>' +
        '<input type="range" min="0" max="100" value="' + Math.round((P.mix[k] || 0) * 100) + '" data-act="mix" data-v="' + k + '" aria-label="' + esc(F.n) + '">' +
        '<small class="mut">מאמץ ' + N('×' + F.effort.toFixed(2)) + ' · CPM ' + N('$' + F.cpm.toFixed(1)) +
        ' · אמינות ' + N((F.cred >= 0 ? '+' : '−') + Math.abs(F.cred).toFixed(1)) + '</small></div>';
    }).join('') + '</div></div>';

  out += '<div class="card"><div class="card-h"><h3>הקטגוריות החמות</h3><span class="hint">על מה כדאי לדבר</span></div>' +
    svgBars(CK.slice().sort(function (a, b) { return G.market[b].heat - G.market[a].heat; }).map(function (c) {
      return { n: CATS[c].ic + ' ' + CATS[c].n, v: G.market[c].heat, lab: Math.round(G.market[c].heat) + '', cls: 'c' };
    })) +
    '<p class="note" style="margin-top:11px">חום גבוה מגיע מאירועי עולם ומפריצות דרך — לא מתקציבי שיווק. סרטון בקטגוריה חמה מקבל יותר צפיות בלי שעשיתם דבר.</p>' +
    '</div>';
  return out;
};

SCREENS['creator:deals'] = function () {
  var C = G.creator, out = '';

  if (C.dilemma) {
    var D = DILEMMAS.filter(function (d) { return d.id === C.dilemma; })[0];
    if (D) {
      out += '<div class="card card-accent"><div class="card-h"><h3>' + esc(D.t) + '</h3>' +
        '<span class="tag tag-warn">החלטה</span></div>' +
        '<p class="note">' + esc(D.x) + '</p>' +
        '<div class="btn-row" style="margin-top:11px">' + D.o.map(function (o, i) {
          return '<button class="btn btn-sm" data-act="dilemma" data-v="' + i + '">' + esc(o.n) + '</button>';
        }).join('') + '</div></div>';
    }
  }

  if (C.invites && C.invites.length) {
    out += '<h3 class="sec-title">הזמנות מיצרניות</h3><div class="stack">' + C.invites.map(function (iv, i) {
      return '<div class="scard"><div class="scard-h"><b>' + esc(iv.n) + '</b>' +
        (iv.embargo ? '<span class="tag tag-warn">אמברגו</span>' : '<span class="tag tag-good">חופשי</span>') + '</div>' +
        '<small class="mut">חשיפה מוקדמת מביאה צפיות. ' +
        (iv.embargo ? 'האמברגו מגביל מתי אפשר לפרסם — ומי שפורץ אותו לא מוזמן שוב.' : 'בלי תנאים מגבילים.') + '</small>' +
        '<div class="btn-row"><button class="btn btn-sm btn-primary" data-act="invite" data-v="' + i + '">לקבל</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="declineInvite" data-v="' + i + '">לוותר</button></div></div>';
    }).join('') + '</div>';
  }

  out += '<h3 class="sec-title">הצעות חסות</h3>';
  if (!C.deals || !C.deals.length) {
    out += '<div class="card"><div class="empty">אין הצעות החודש. תגדילו הישג או תמתינו.</div></div>';
  } else {
    out += '<div class="stack">' + C.deals.map(function (d, i) {
      return '<div class="scard"><div class="scard-h"><b>' + esc(d.n) + '</b>' +
        (d.shady ? '<span class="tag tag-bad">מפוקפק</span>' : '<span class="tag tag-good">תקין</span>') + '</div>' +
        '<div class="facts">' +
        '<div class="fact"><span>תשלום לחודש</span><b>' + fmtK(d.pay) + '</b></div>' +
        '<div class="fact"><span>משך</span><b>' + d.months + ' ח׳</b></div>' +
        '<div class="fact"><span>אמינות</span><b class="' + (d.cred > 1 ? 'down' : '') + '">−' + d.cred.toFixed(1) + '</b></div>' +
        '</div>' +
        '<button class="btn btn-sm ' + (d.shady ? 'btn-danger' : 'btn-primary') + '" data-act="deal" data-v="' + i + '">' +
        (d.shady ? 'לקחת את הכסף' : 'לחתום') + '</button></div>';
    }).join('') + '</div>';
  }

  var act = C.active || [];
  out += '<h3 class="sec-title">חסויות פעילות</h3>';
  out += act.length
    ? '<div class="rows">' + act.map(function (d) {
      return '<div class="row"><span class="row-main"><b>' + esc(d.n || 'חסות') + '</b><small>' + d.months + ' חודשים נותרו</small></span>' +
        '<span class="row-end"><b class="up">' + fmtK(d.pay) + '</b><small>לחודש</small></span></div>';
    }).join('') + '</div>'
    : '<div class="card"><div class="empty">אין חסויות פעילות. כל ההכנסה מגיעה מהפרסומות של הפלטפורמה.</div></div>';

  out += '<div class="card" style="margin-top:14px"><div class="card-h"><h3>למה זה חשוב</h3></div>' +
    '<p class="note">אמינות היא הנכס היחיד שלא קונים בחזרה. חסות מפוקפקת אחת עולה כמה נקודות; שלוש כאלה משנות את מי שנרשם אליכם ואת מי שמזמין אתכם להשקות.</p></div>';
  return out;
};

SCREENS['creator:market'] = SCREENS['ceo:market'];

SCREENS['creator:more'] = function () {
  var C = G.creator, out = '';

  out += '<div class="card"><div class="card-h"><h3>הכנסות החודש</h3><span class="hint">' + dateHe(G.t - 1) + '</span></div>' +
    '<div class="ledger">' +
    '<div class="led"><span>צפיות</span><b>' + fmtU(C.views || 0) + '</b></div>' +
    '<div class="led"><span>מנויים</span><b>' + fmtU(C.subs) + '</b></div>' +
    '<div class="led"><span>איכות הפקה</span><b>' + Math.round(C.quality || 0) + '</b></div>' +
    '<div class="led led-total"><span>תזרים חודשי</span><b class="' + deltaCls(C.income || 0) + '">' + fmtSignK(C.income || 0) + '</b></div>' +
    '</div></div>';

  out += '<div class="card"><div class="card-h"><h3>הזירה</h3><span class="hint">מי עוד מסקר</span></div><div class="rows">' +
    CREATORS.map(function (cr) {
      return '<div class="row"><span class="row-main"><b>' + esc(cr.n) + '</b><small>' + esc(cr.d) + '</small></span>' +
        '<span class="row-end"><b>' + fmtU(cr.reach) + '</b><small>מנויים</small></span></div>';
    }).join('') + '</div>' +
    '<p class="note" style="margin-top:11px">אלה הערוצים שאתם מתחרים בהם על אותה שעת צפייה — ועל אותן יחידות ביקורת.</p></div>';

  out += '<div class="card"><div class="card-h"><h3>יומן</h3></div><div class="ticker">' +
    G.log.slice(0, 24).map(function (l) { return tickRow(l, 1); }).join('') + '</div></div>';

  out += settingsCard();
  return out;
};

/* ═══════════════════════════════════════════════════════════════════════════
   UI §30 — bottom sheets
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── live product ───────────────────────────────────────────────────────── */
function sheetProduct(id) {
  var p = G.prods.filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  UI.pick = id;
  openSheet(p.name, renderProductSheet(p), productFoot(p));
}
function productFoot(p) {
  return '<div class="btn-row">' +
    '<button class="btn btn-primary" data-act="closeSheet">סיום</button>' +
    '<button class="btn btn-danger btn-sm" data-act="killProd" data-v="' + p.id + '">' +
    (p.live ? 'הפסקת ייצור' : 'ביטול פיתוח') + '</button></div>';
}
function renderProductSheet(p) {
  var me = G.cos[G.me], C = CATS[p.cat];
  var q = qualityOf(G, me, p), cost = unitCostOf(G, me, p);
  var fair = fairPrice(G, p, q);
  var margin = p.price > 0 ? (p.price - cost) / p.price : 0;
  var out = '';

  out += '<div class="facts">' +
    '<div class="fact"><span>איכות</span><b>' + q.toFixed(0) + '</b></div>' +
    '<div class="fact"><span>עלות יחידה</span><b>' + fmtPrice(cost) + '</b></div>' +
    '<div class="fact"><span>מחיר הוגן</span><b>' + fmtPrice(fair) + '</b></div>' +
    '<div class="fact"><span>שוליים</span><b class="' + (margin < 0.1 ? 'down' : 'up') + '">' + fmtPct(margin, 0) + '</b></div>' +
    (p.live ? '<div class="fact"><span>ציון מוצר</span><b>' + scoreOf(G, me, p).toFixed(0) + '</b></div>' +
      '<div class="fact"><span>רעננות</span><b>' + fmtPct(freshnessOf(G, p) / 1.12, 0) + '</b></div>' : '') +
    '</div>';

  if (!p.live) {
    out += '<p class="note note-warn">בפיתוח. השקה בעוד ' + p.devLeft + ' חודשים. אפשר עדיין לשנות מחיר ותוכנית, אבל לא את המפרט.</p>';
  }

  var maxPrice = Math.max(p.price * 2, fair * 2.2, cost * 3);
  out += '<div class="control"><div class="control-h"><label>מחיר לצרכן</label>' +
    '<output>' + fmtPrice(p.price) + '</output></div>' +
    '<input type="range" min="' + Math.round(cost * 0.9) + '" max="' + Math.round(maxPrice) + '" step="5" value="' + p.price +
    '" data-act="pPrice" data-v="' + p.id + '" aria-label="מחיר">' +
    '<small class="mut">' + (p.price > fair * 1.15 ? 'יקר ביחס לאיכות. הביקורות והציון ייענשו.'
      : p.price < fair * 0.72 ? 'זול מאוד ביחס לאיכות — נפח גדול, שוליים דקים.'
        : 'תמחור בטווח שהשוק מקבל כהוגן.') + '</small></div>';

  var wallet = mktBudget(me);
  out += '<div class="control"><div class="control-h"><label>שיווק חודשי</label>' +
    '<output>' + fmtM(p.mkt || 0) + '</output></div>' +
    '<input type="range" min="0" max="100" value="' + Math.round(clamp((p.mkt || 0) / Math.max(0.02, wallet), 0, 1) * 100) +
    '" data-act="pMkt" data-v="' + p.id + '" aria-label="שיווק">' +
    '<small class="mut">תשואה פוחתת. שיווק בונה היפ למוצר הזה — הוא לא מחמם את הקטגוריה.</small></div>';

  if (p.live) {
    var cap = effectiveCapacity(G, me);
    var maxPlan = Math.max(0.2, cap / LINE_USE[p.cat]);
    out += '<div class="control"><div class="control-h"><label>תוכנית ייצור חודשית</label>' +
      '<output>' + fmtU(p.prodPlan || 0) + '</output></div>' +
      '<input type="range" min="0" max="1000" value="' + Math.round(clamp((p.prodPlan || 0) / maxPlan, 0, 1) * 1000) +
      '" data-act="pPlan" data-v="' + p.id + '" aria-label="תוכנית ייצור"' + (p.auto ? ' disabled' : '') + '>' +
      '<small class="mut">ביקוש אחרון ' + N(fmtU(p.demand || 0)) + ' · מלאי ' + N(fmtU(p.inv || 0)) +
      ' · צריכת קו ' + N('×' + LINE_USE[p.cat].toFixed(2)) + '</small></div>';

    out += '<button class="switch' + (p.auto ? ' is-on' : '') + '" data-act="pAuto" data-v="' + p.id + '" aria-pressed="' + !!p.auto + '">' +
      '<span class="switch-txt"><b>ניהול אוטומטי</b><small>מוריד מחיר בהדרגה, חותך שיווק ומתאים את הייצור לביקוש. מפסיק את הדגם כשהוא כבר לא רלוונטי.</small></span>' +
      '<span class="switch-box"></span></button>';

    if (p.stockout > 0.005) {
      out += '<p class="note note-bad">נגמר המלאי ל־' + fmtU(p.stockout) + ' קונים בחודש האחרון — ' +
        fmtM(p.stockout * p.price / 1000) + ' הכנסה שלא נרשמה.</p>';
    }
    if (p.inv > Math.max(0.05, (p.sold || 0) * 2.5)) {
      out += '<p class="note note-warn">מלאי של ' + fmtU(p.inv) + ' יחידות מול מכירה חודשית של ' + fmtU(p.sold || 0) +
        '. עלות ההחזקה נאכלת כל חודש, והמחיקה בסוף החיים תכאב.</p>';
    }
  }

  out += '<h3 class="sec-title">חבילות טכנולוגיה</h3><div class="stack">' +
    pkgsFor(p.cat).map(function (k) {
      var t = pkgTier(p, k);
      return '<div class="control"><div class="control-h"><label>' + esc(PKGS[k].n) + '</label>' +
        '<output>' + esc(GEN_NAME[t - 1]) + '</output></div>' +
        '<div class="bar v"><i style="width:' + (t / 5 * 100) + '%"></i></div>' +
        '<small class="mut">' + esc(pkgSuppliers(p.cat, k)) + ' · משקל ' + N(fmtPct(pkgWeight(p.cat, k), 0)) + '</small></div>';
    }).join('') + '</div>';

  if (p.rev_by && keys(p.rev_by).length) {
    out += '<h3 class="sec-title">ביקורות</h3><div class="rows">' +
      CREATORS.filter(function (cr) { return p.rev_by[cr.id] != null; }).map(function (cr) {
        var s = p.rev_by[cr.id];
        return '<div class="row"><span class="row-main"><b>' + esc(cr.n) + '</b><small>' + fmtU(cr.reach) + ' מנויים</small></span>' +
          '<span class="row-end"><b class="' + (s >= 8 ? 'up' : s < 5.5 ? 'down' : '') + '">' + s.toFixed(1) + '</b><small>מתוך 10</small></span></div>';
      }).join('') + '</div>';
  }
  return out;
}

/* ── new product designer ───────────────────────────────────────────────── */
function sheetDesign() {
  var me = G.cos[G.me];
  var cat = CO_BY_ID[G.me].focus[0];
  var spec = {};
  keys(CATS[cat].w).forEach(function (k) { spec[k] = 3; });
  UI.draft = { cat: cat, band: 'mid', spec: spec, price: 0, name: '' };
  syncDraftPrice();
  openSheet('תכנון מוצר חדש', renderDesign(), designFoot());
}
function syncDraftPrice() {
  var d = UI.draft, me = G.cos[G.me];
  var tmp = { cat: d.cat, spec: d.spec, price: 0, born: G.t };
  var cost = unitCostOf(G, me, tmp);
  var q = qualityOf(G, me, tmp);
  if (!d.touched) d.price = Math.round(Math.max(cost * 1.25, fairPrice(G, tmp, q) * 0.92) / 5) * 5;
  d.cost = cost; d.q = q; d.fair = fairPrice(G, tmp, q);
}
function designFoot() {
  var d = UI.draft, me = G.cos[G.me];
  var cost = devCost(G, d.cat, d.spec);
  var can = me.cash >= cost;
  return '<div class="btn-row"><button class="btn btn-primary" data-act="commitDesign"' + (can ? '' : ' disabled') + '>' +
    (can ? 'אישור פיתוח · ' + fmtM(cost) : 'אין מזומן (' + fmtM(cost) + ')') + '</button>' +
    '<button class="btn btn-ghost btn-sm" data-act="closeSheet">ביטול</button></div>';
}
function renderDesign() {
  var d = UI.draft, me = G.cos[G.me], C = CATS[d.cat];
  syncDraftPrice();
  var out = '';

  out += '<div class="control"><div class="control-h"><label>קטגוריה</label></div>' +
    '<div class="chips">' + CK.map(function (k) {
      return '<button class="chip' + (k === d.cat ? ' is-on' : '') + '" data-act="dCat" data-v="' + k + '">' +
        CATS[k].ic + ' ' + CATS[k].n + '</button>';
    }).join('') + '</div>' +
    '<small class="mut">מחזור החלפה ' + N(C.life) + ' חודשים · צריכת קו ' + N('×' + LINE_USE[d.cat].toFixed(2)) +
    ' · ' + N(fmtU(G.market[d.cat].pool)) + ' קונים בחודש</small></div>';

  out += '<div class="control"><div class="control-h"><label>מדף יעד</label></div>' +
    '<div class="chips">' + BANDS.map(function (b) {
      return '<button class="chip' + (b === d.band ? ' is-on' : '') + '" data-act="dBand" data-v="' + b + '">' +
        BAND_HE[b] + ' · ' + fmtPrice(C.bandRef[b]) + '</button>';
    }).join('') + '</div>' +
    '<small class="mut">' + fmtPct(C.bands[d.band], 0) + ' מהקונים בקטגוריה מחפשים במדף הזה.</small></div>';

  /* Four packages instead of nine parts: the same engine underneath, a
     decision a person can actually make on a phone screen. */
  out += '<h3 class="sec-title">חבילות טכנולוגיה</h3><div class="spec-grid">' + pkgsFor(d.cat).map(function (k) {
    var tier = pkgTier({ spec: d.spec, cat: d.cat }, k);
    return '<div class="control"><div class="control-h"><label>' + esc(PKGS[k].n) + '</label>' +
      '<output>' + esc(GEN_NAME[tier - 1]) + '</output></div>' +
      '<div class="tierbar">' + [1, 2, 3, 4, 5].map(function (t) {
        return '<button class="' + (tier === t ? 'is-on' : '') + '" data-act="dPkg" data-v="' + k + ':' + t + '">' + t + '</button>';
      }).join('') + '</div>' +
      '<small class="mut">' + esc(PKGS[k].d) + ' · ' + esc(pkgSuppliers(d.cat, k)) +
      ' · משקל ' + N(fmtPct(pkgWeight(d.cat, k), 0)) + '</small></div>';
  }).join('') + '</div>';

  var margin = d.price > 0 ? (d.price - d.cost) / d.price : 0;
  out += '<div class="card card-cyan"><div class="facts">' +
    '<div class="fact"><span>איכות צפויה</span><b>' + d.q.toFixed(0) + '</b></div>' +
    '<div class="fact"><span>עלות יחידה</span><b>' + fmtPrice(d.cost) + '</b></div>' +
    '<div class="fact"><span>מחיר הוגן</span><b>' + fmtPrice(d.fair) + '</b></div>' +
    '<div class="fact"><span>שוליים</span><b class="' + (margin < 0.1 ? 'down' : 'up') + '">' + fmtPct(margin, 0) + '</b></div>' +
    '<div class="fact"><span>זמן פיתוח</span><b>' + devMonths(G, d.cat) + ' ח׳</b></div>' +
    '<div class="fact"><span>עלות פיתוח</span><b>' + fmtM(devCost(G, d.cat, d.spec)) + '</b></div>' +
    '</div></div>';

  out += '<div class="control"><div class="control-h"><label>מחיר לצרכן</label><output>' + fmtPrice(d.price) + '</output></div>' +
    '<input type="range" min="' + Math.round(d.cost * 0.95) + '" max="' + Math.round(Math.max(d.fair * 2.2, d.cost * 3)) +
    '" step="5" value="' + d.price + '" data-act="dPrice" aria-label="מחיר"></div>';

  out += '<label class="field"><span class="field-lab">שם המוצר</span>' +
    '<input type="text" value="' + esc(d.name || suggestName(d)) + '" data-act="dName" maxlength="34" autocomplete="off"></label>';

  return out;
}
/* Which of your supplier contracts a package actually draws on. */
function pkgSuppliers(cat, k) {
  var w = CATS[cat].w;
  var names = [];
  PKGS[k].parts.forEach(function (part) {
    if (w[part] == null) return;
    var sup = SUP_BY_ID[G.contracts[part]];
    if (sup && names.indexOf(sup.n) < 0) names.push(sup.n);
  });
  return names.length ? names.join(' + ') : '—';
}

function suggestName(d) {
  return productName(G, CO_BY_ID[G.me], d.cat, d.band, 0) + ' ' + turnY(G.t);
}

/* ── suppliers ──────────────────────────────────────────────────────────── */
function sheetSupplier(part) {
  var cur = G.contracts[part];
  var body = '<p class="note">ספק אחד לכל רכיב. מעבר עולה סבב הסמכה ומשפיע מיד על עלות היחידה ועל האיכות של כל המוצרים שמשתמשים בו.</p>' +
    '<div class="stack">' + suppliersFor(part).map(function (s) {
      var dis = (G.disrupt || {})[s.id];
      return '<div class="scard' + (s.id === cur ? ' is-me' : '') + '">' +
        '<div class="scard-h"><b>' + esc(s.n) + '</b>' +
        (s.id === cur ? '<span class="tag tag-accent">בחוזה</span>' : '') +
        (dis ? '<span class="tag tag-bad">שיבוש ' + dis.m + ' ח׳</span>' : '') + '</div>' +
        '<small class="mut">' + esc(s.geo) + ' — ' + esc(s.d) + '</small>' +
        '<div class="facts">' +
        '<div class="fact"><span>מחיר</span><b class="' + (s.price > 1.05 ? 'down' : s.price < 0.95 ? 'up' : '') + '">×' + s.price.toFixed(2) + '</b></div>' +
        '<div class="fact"><span>איכות</span><b class="' + (s.q > 1.04 ? 'up' : s.q < 0.95 ? 'down' : '') + '">×' + s.q.toFixed(2) + '</b></div>' +
        '<div class="fact"><span>אמינות</span><b>' + fmtPct(s.rel, 0) + '</b></div>' +
        '<div class="fact"><span>קיבולת</span><b>×' + s.cap.toFixed(2) + '</b></div>' +
        '</div>' +
        (s.id === cur ? '' : '<button class="btn btn-sm btn-primary" data-act="pickSup" data-v="' + part + ':' + s.id + '">מעבר לספק הזה</button>') +
        '</div>';
    }).join('') + '</div>';
  openSheet(PARTS[part].n, body, '<button class="btn btn-ghost" data-act="closeSheet" style="width:100%">סגירה</button>');
}

/* ── capacity ───────────────────────────────────────────────────────────── */
function sheetCapex() {
  UI.draft = { add: Math.max(0.2, effectiveCapacity(G, G.cos[G.me]) * 0.12) };
  openSheet('הרחבת קיבולת', renderCapex(), capexFoot());
}
function renderCapex() {
  var me = G.cos[G.me], add = UI.draft.add;
  var q = capexQuote(add);
  var cap = effectiveCapacity(G, me);
  var maxAdd = Math.max(1, cap * 0.8);
  return '<p class="note">קיבולת קטנה נשכרת אצל קבלן הרכבה: זולה ליחידה ומגיעה תוך רבעון. קו משלנו עולה את המחיר המלא ולוקח חצי שנה. בשני המקרים משלמים מראש, והקיבולת נכנסת לשירות רק בסוף — ואחזקת קיבולת פנויה עולה כסף כל חודש.</p>' +
    '<div class="control"><div class="control-h"><label>תוספת קיבולת</label><output>' + fmtU(add) + ' יח׳/חודש</output></div>' +
    '<input type="range" min="5" max="1000" value="' + Math.round(add / maxAdd * 1000) + '" data-act="capexAmt" aria-label="תוספת קיבולת"></div>' +
    '<p class="note ' + (q.contract ? 'note-good' : '') + '">' +
    (q.contract ? 'בהיקף הזה זו <b>קיבולת קבלן</b>: תעריף מוזל ומוכן תוך שלושה חודשים.'
                : 'בהיקף הזה זה <b>קו ייצור משלנו</b>: תעריף מלא ושישה חודשי בנייה.') + '</p>' +
    '<div class="facts">' +
    '<div class="fact"><span>קיבולת היום</span><b>' + fmtU(cap) + '</b></div>' +
    '<div class="fact"><span>אחרי הבנייה</span><b>' + fmtU(cap + add) + '</b></div>' +
    '<div class="fact"><span>עלות כוללת</span><b>' + fmtM(q.total) + '</b></div>' +
    '<div class="fact"><span>תשלום חודשי</span><b>' + fmtM(q.total / q.months) + '</b></div>' +
    '<div class="fact"><span>מוכן בעוד</span><b>' + q.months + ' ח׳</b></div>' +
    '<div class="fact"><span>מזומן</span><b class="' + (me.cash < q.total / q.months * 1.5 ? 'down' : '') + '">' + fmtM(me.cash) + '</b></div>' +
    '</div>' +
    ((G.plan.capexQueue || []).length ? '<p class="note note-warn">כבר יש ' + G.plan.capexQueue.length +
      ' קווים בבנייה. כל אחד ממשיך לגבות תשלום חודשי.</p>' : '');
}
function capexFoot() {
  var me = G.cos[G.me], q = capexQuote(UI.draft.add);
  var can = me.cash >= q.total / q.months * 1.5;
  return '<div class="btn-row"><button class="btn btn-primary" data-act="commitCapex"' + (can ? '' : ' disabled') + '>' +
    (can ? 'אישור בנייה' : 'אין מזומן לתשלום הראשון') + '</button>' +
    '<button class="btn btn-ghost btn-sm" data-act="closeSheet">ביטול</button></div>';
}

/* ── Finance & Board: one window for every number that costs money ──────
   Report, credit line and board expectations used to be three separate
   places. On a phone that is three round trips to answer one question.  */
function sheetFinance(tab) {
  UI.finTab = tab || UI.finTab || 'pl';
  openSheet('כספים ודירקטוריון', renderFinance(), financeFoot());
}
function financeFoot() {
  return '<button class="btn btn-ghost" data-act="closeSheet" style="width:100%">סגירה</button>';
}
function renderFinance() {
  var t = UI.finTab;
  var head = '<div class="sheet-tabs">' +
    [['pl', 'דוח החודש'], ['credit', 'אשראי'], ['board', 'דירקטוריון']].map(function (x) {
      return '<button class="' + (t === x[0] ? 'is-on' : '') + '" data-act="finTab" data-v="' + x[0] + '">' + x[1] + '</button>';
    }).join('') + '</div>';
  return head + (t === 'credit' ? renderCredit() : t === 'board' ? renderBoard() : renderPL());
}

function renderPL() {
  var me = G.cos[G.me], f = G.fin;
  var gross = (f.revDev || 0) + (f.revOther || 0);
  return '<div class="kpis">' +
    kpi('מזומן', fmtM(me.cash), me.debt > 0 ? 'חוב ' + fmtM(me.debt) : 'ללא חוב', me.debt > 0 ? 'down' : 'mut') +
    kpi('הכנסה', fmtM(gross), 'מוצרים ' + fmtM(f.revDev || 0)) +
    kpi('רווח נקי', fmtSign(f.net || 0), 'שוליים ' + fmtPct(f.margin || 0, 0), deltaCls(f.net || 0)) +
    kpi('שלב', ARCH[me.arch].n.replace('דירקטוריון של ', '').replace('משקיעי ה', ''), 'יעד ' + fmtPct(ARCH[me.arch].growth, 0)) +
    '</div>' +
    '<div class="ledger">' +
    ledRow('הכנסות ממוצרים', f.revDev || 0) +
    ledRow('הכנסות אחרות (שירותים, פרסום, B2B)', f.revOther || 0) +
    ledRow('עלות ייצור', -(f.prodCost || 0)) +
    ledRow('החזקת מלאי', -(f.hold || 0)) +
    ((f.writeoff || 0) ? ledRow('מחיקת מלאי מת', -f.writeoff) : '') +
    ledRow('שיווק', -(f.mkt || 0)) +
    ledRow('מו״פ', -(f.rnd || 0)) +
    ((f.salaries || 0) ? ledRow('שכר כישרונות מפתח', -f.salaries) : '') +
    ledRow('תפעול', -((f.opex || 0) - (f.salaries || 0))) +
    ((f.interest || 0) ? ledRow('ריבית על חוב', -f.interest) : '') +
    ((f.capex || 0) ? ledRow('השקעות הון', -f.capex) : '') +
    ((f.payout || 0) ? ledRow('חלוקה לבעלי מניות', -f.payout) : '') +
    '<div class="led led-total"><span>רווח נקי</span><b class="' + deltaCls(f.net || 0) + '">' + fmtSign(f.net || 0) + '</b></div>' +
    '</div>' +
    '<div class="control"><div class="control-h"><label>החזר הון לבעלי המניות</label><output>' + fmtPct(G.plan.payout, 0) + '</output></div>' +
    '<input type="range" min="0" max="60" value="' + Math.round(G.plan.payout * 100) + '" data-act="payout" aria-label="החזר הון">' +
    '<small class="mut">יעד הדירקטוריון: ' + N(fmtPct(ARCH[me.arch].payoutTarget, 0)) + '. ' +
    (ARCH[me.arch].wantsPayout ? 'ענקית שלא מחלקת נראית כמי שאין לה מה לעשות עם הכסף.'
      : 'בשלב הזה עדיף להשקיע כל שקל בחזרה בצמיחה.') + '</small></div>';
}

function renderCredit() {
  var me = G.cos[G.me];
  var limit = creditLimit(G), head = loanHeadroom(G);
  var d = UI.draft && UI.draft.loan != null ? UI.draft.loan : Math.min(head, Math.max(0.05, head * 0.3));
  UI.draft = UI.draft || {}; UI.draft.loan = d;
  return '<p class="note">מסגרת אשראי נמדדת מול העסק שאפשר להראות למלווה. הריבית נצברת כל חודש, וחוב שגדל מעבר לכושר ההחזר מסיים את המשחק — לא הדירקטוריון עושה את זה, אלא הנושים.</p>' +
    '<div class="facts">' +
    '<div class="fact"><span>מזומן</span><b>' + fmtM(me.cash) + '</b></div>' +
    '<div class="fact"><span>חוב</span><b class="' + (me.debt > 0 ? 'down' : '') + '">' + fmtM(me.debt) + '</b></div>' +
    '<div class="fact"><span>מסגרת</span><b>' + fmtM(limit) + '</b></div>' +
    '<div class="fact"><span>פנוי למשיכה</span><b>' + fmtM(head) + '</b></div>' +
    '<div class="fact"><span>ריבית חודשית</span><b>' + N('0.45%') + '</b></div>' +
    '<div class="fact"><span>תשלום ריבית</span><b>' + fmtM(me.debt * 0.0045) + '</b></div>' +
    '</div>' +
    '<div class="control"><div class="control-h"><label>סכום</label><output>' + fmtM(d) + '</output></div>' +
    '<input type="range" min="0" max="1000" value="' + Math.round(head > 0 ? clamp(d / head, 0, 1) * 1000 : 0) +
    '" data-act="loanAmt" aria-label="סכום הלוואה"' + (head <= 0.01 ? ' disabled' : '') + '></div>' +
    '<div class="btn-row">' +
    '<button class="btn btn-sm btn-primary" data-act="loanTake"' + (head <= 0.01 ? ' disabled' : '') + '>משיכה</button>' +
    '<button class="btn btn-sm btn-ghost" data-act="loanRepay"' + (me.debt <= 0.01 || me.cash <= 0.01 ? ' disabled' : '') + '>החזר</button>' +
    '</div>' +
    '<p class="note">המסגרת נעצרת מתחת לרף חדלות הפירעון (' + N(fmtM(insolvencyLimit(G))) +
    '), כך שמשיכה לבדה לא יכולה לסיים את המשחק. מה שעושים עם הכסף — כן.</p>' +
    (me.debt > limit * 0.75 ? '<p class="note note-bad">החוב מתקרב לגבול המסגרת. עוד משיכה אחת ואין יותר חבל הצלה.</p>' : '');
}

function renderBoard() {
  var me = G.cos[G.me], A = ARCH[me.arch];
  var mt = CO_BY_ID[G.me] && CO_BY_ID[G.me].marginTarget != null ? CO_BY_ID[G.me].marginTarget : A.margin;
  var g = yoyGrowth(me);
  var out = '<p class="note">' + esc(A.d) + '</p>' +
    '<div class="control"><div class="control-h"><label>מצב רוח</label><output>' + Math.round(G.board.mood) + '/100</output></div>' +
    '<div class="bar ' + (G.board.mood < 35 ? 'b' : G.board.mood < 55 ? 'w' : 'g') + '"><i style="width:' + G.board.mood.toFixed(0) + '%"></i></div></div>' +
    '<div class="rows">' +
    '<div class="row"><span class="row-main"><b>צמיחה שנתית</b><small>יעד ' + fmtPct(A.growth, 0) +
    (A.tol < 1 ? ' · חריגה גדולה נקראת כתנודתיות' : ' · אין תקרה') + '</small></span>' +
    '<span class="row-end"><b class="' + (g == null ? 'flat' : deltaCls(g - A.growth * 0.45)) + '">' +
    (g == null ? '—' : fmtSignPct(g, 0)) + '</b></span></div>' +
    '<div class="row"><span class="row-main"><b>שולי רווח</b><small>יעד ' + fmtPct(mt, 0) + '</small></span>' +
    '<span class="row-end"><b class="' + deltaCls((G.fin.margin || 0) - mt) + '">' + fmtPct(G.fin.margin || 0, 0) + '</b></span></div>' +
    '<div class="row"><span class="row-main"><b>החזר הון</b><small>' +
    (A.wantsPayout ? 'יעד ' + fmtPct(A.payoutTarget, 0) : 'לא נמדד בשלב הזה') + '</small></span>' +
    '<span class="row-end"><b>' + fmtPct(G.plan.payout, 0) + '</b></span></div>' +
    '<div class="row"><span class="row-main"><b>סבילות להפסד</b><small>עד ' + A.lossTol + ' חודשים ברצף</small></span>' +
    '<span class="row-end"><b class="' + ((me.lossStreak || 0) > A.lossTol ? 'down' : '') + '">' + (me.lossStreak || 0) + '</b></span></div>' +
    '<div class="row"><span class="row-main"><b>אזהרות</b><small>שלוש אזהרות = סוף הכהונה</small></span>' +
    '<span class="row-end"><b class="' + (G.board.warnings ? 'down' : '') + '">' + G.board.warnings + '/3</b></span></div>' +
    '</div>';
  if ((G.board.notes || []).length) {
    out += '<h3 class="sec-title">מה נאמר בישיבה</h3><div class="ticker">' +
      G.board.notes.map(function (n) { return '<div class="tick"><i>•</i><span>' + esc(n) + '</span></div>'; }).join('') + '</div>';
  }
  if (G.creatorPast) {
    out += '<p class="note note-good">הגעתם לכאן מערוץ עם ' + N(fmtU(G.creatorPast.subs)) +
      ' מנויים. הקהל הזה עדיין מגביר כל השקה שלנו.</p>';
  }
  return out;
}

/* ── talent market ──────────────────────────────────────────────────────── */
function sheetTalent() {
  openSheet('שוק הכישרונות', renderTalent(),
    '<button class="btn btn-ghost" data-act="closeSheet" style="width:100%">סגירה</button>');
}
function renderTalent() {
  var me = G.cos[G.me];
  var market = (G.talent && G.talent.market) || [];
  if (!market.length) return '<div class="empty">אף אחד לא זמין החודש. הרשימה מתרעננת כל שלושה חודשים.</div>';
  return '<p class="note">חטיפה מזיזה את התחום מיד — ומורידה אותו אצל מי שאיבד את האדם. יש עלות חתימה חד־פעמית ושכר חודשי, ומי שלא מרוצה מהחברה עלול לעזוב.</p>' +
    '<div class="stack">' + market.map(function (t) {
      var from = G.cos[t.from];
      var can = me.cash >= t.fee;
      return '<div class="scard"><div class="scard-h"><b>' + esc(t.name) + '</b>' +
        '<span class="tag tag-violet">' + esc(TECH[t.role].n) + '</span></div>' +
        '<small class="mut">' + esc(ROLES[t.role].n) + ' · ' + esc(from ? from.n : '—') + ' · ' + esc(ROLES[t.role].d) + '</small>' +
        '<div class="facts">' +
        '<div class="fact"><span>קפיצה מיידית</span><b class="up">+' + t.boost.toFixed(1) + '</b></div>' +
        '<div class="fact"><span>הרמה שלנו</span><b>' + Math.round(me.tech[t.role] || 0) + '</b></div>' +
        '<div class="fact"><span>נאמנות</span><b>' + t.loyalty + '</b></div>' +
        '<div class="fact"><span>חתימה</span><b>' + fmtM(t.fee) + '</b></div>' +
        '<div class="fact"><span>שכר חודשי</span><b>' + fmtM(t.salary) + '</b></div>' +
        '<div class="fact"><span>מזומן</span><b class="' + (can ? '' : 'down') + '">' + fmtM(me.cash) + '</b></div>' +
        '</div>' +
        '<button class="btn btn-sm ' + (can ? 'btn-primary' : 'btn-ghost') + '" data-act="hire" data-v="' + t.id + '"' +
        (can ? '' : ' disabled') + '>' + (can ? 'חתימה' : 'אין מספיק מזומן') + '</button></div>';
    }).join('') + '</div>';
}

/* ── crossing over from a channel to a company ──────────────────────────── */
function sheetExpand() {
  var C = G.creator;
  var raise = raiseAmount(G);
  var targets = strugglingCompanies(G);
  UI.draft = { coName: C.coName || '' };
  var body = '<p class="note">' + N(fmtU(C.subs)) + ' מנויים ואמינות ' + N(Math.round(C.cred)) +
    ' זה כבר לא קהל — זו מנוף. אפשר לגייס הון ולהקים חברה, או לקחת כיסא מנכ״ל בחברה שצריכה בדיוק את מי שהשוק מקשיב לו. בשני המקרים הערוץ נשאר באוויר ומגביר כל השקה, והמשחק מתארך כדי שיהיה זמן לבנות משהו.</p>';

  body += '<div class="card card-accent"><div class="card-h"><h3>להקים חברה משלנו</h3>' +
    '<span class="hint num">' + fmtM(raise) + '</span></div>' +
    '<p class="note">גיוס הסיד נגזר מגודל הערוץ, מהאמינות ומהמזומן שצברתם. מתחילים קטן — אבל הכול שלכם.</p>' +
    '<label class="field" style="margin-top:11px"><span class="field-lab">שם החברה</span>' +
    '<input type="text" value="' + esc(UI.draft.coName) + '" placeholder="' + esc('הסטארטאפ של ' + C.name) +
    '" maxlength="22" data-act="xName" autocomplete="off"></label>' +
    '<button class="btn btn-primary" data-act="xFound" style="width:100%;margin-top:11px">לגייס ' + fmtM(raise) + ' ולהקים</button>' +
    '</div>';

  body += '<h3 class="sec-title">או לקחת כיסא קיים</h3><div class="stack">' + targets.map(function (co) {
    return '<div class="scard"><div class="scard-h"><b>' + esc(co.he || co.n) + ' · ' + esc(co.n) + '</b>' +
      '<span class="tag ' + (co.profit < 0 ? 'tag-bad' : 'tag-warn') + '">' + (co.profit < 0 ? 'מפסידה' : 'מדשדשת') + '</span></div>' +
      '<div class="facts">' +
      '<div class="fact"><span>מותג</span><b>' + Math.round(co.brand) + '</b></div>' +
      '<div class="fact"><span>מזומן</span><b>' + fmtM(co.cash) + '</b></div>' +
      '<div class="fact"><span>הכנסה</span><b>' + fmtM(co.revDev || 0) + '</b></div>' +
      '<div class="fact"><span>קיבולת</span><b>' + fmtU(co.capacity) + '</b></div>' +
      '<div class="fact"><span>הכנסה אחרת</span><b>' + fmtM(co.otherRev) + '</b></div>' +
      '<div class="fact"><span>שלב</span><b>' + (co.arch === 'megacap' ? 'ענקית' : co.arch === 'challenger' ? 'מאתגרת' : 'סטארטאפ') + '</b></div>' +
      '</div>' +
      '<button class="btn btn-sm btn-primary" data-act="xHire" data-v="' + co.id + '">לקבל את התפקיד</button></div>';
  }).join('') + '</div>';

  openSheet('הרחבה לתעשייה', body, '<button class="btn btn-ghost" data-act="closeSheet" style="width:100%">עוד לא</button>');
}

/* ── easter eggs ────────────────────────────────────────────────────────── */
function sheetCheat() {
  var found = keys(G.cheats || {}).length;
  var body = '<p class="note">מצאתם את הדלת האחורית. יש כאן חמישה קודים; כל אחד עובד פעם אחת בכל משחק. הרמזים פזורים בין הקוד למקור לבין ההיסטוריה של התעשייה.</p>' +
    '<label class="field"><span class="field-lab">קוד</span>' +
    '<input type="text" id="cheatIn" placeholder="הקלידו קוד" maxlength="24" autocomplete="off" spellcheck="false"></label>' +
    '<button class="btn btn-primary" data-act="cheatGo" style="width:100%">הפעלה</button>' +
    '<div class="facts" style="margin-top:6px">' +
    '<div class="fact"><span>נמצאו</span><b>' + found + '/' + CHEATS.length + '</b></div>' +
    '</div>';
  if (found) {
    body += '<h3 class="sec-title">מה כבר מומש</h3><div class="rows">' +
      CHEATS.filter(function (c) { return G.cheats[c.id]; }).map(function (c) {
        return '<div class="row"><span class="row-main"><b>' + esc(c.n) + '</b><small>חודש ' + (G.cheats[c.id]) + '</small></span>' +
          '<span class="row-end"><b class="up">✓</b></span></div>';
      }).join('') + '</div>';
  }
  openSheet('קודים', body, '<button class="btn btn-ghost" data-act="closeSheet" style="width:100%">סגירה</button>');
}

/* ── month-end report ───────────────────────────────────────────────────── */
function sheetReport() {
  var r = G.report;
  if (!r) return;
  var body = '';
  if (r.event) {
    body += '<div class="card card-cyan"><div class="card-h"><h3>' + esc(r.event.t) + '</h3></div>' +
      '<p class="note">' + esc(r.event.x) + '</p></div>';
  }

  if (r.mode === 'ceo') {
    body += '<div class="kpis">' +
      kpi('הכנסה', fmtM(r.fin.revDev + r.fin.revOther), 'מוצרים ' + fmtM(r.fin.revDev)) +
      kpi('רווח נקי', fmtSign(r.fin.net), fmtPct(r.fin.margin, 0), deltaCls(r.fin.net)) +
      kpi('יחידות', fmtU(r.units), 'מלאי ' + fmtU(r.inv)) +
      kpi('מזומן', fmtM(r.cash), '', r.cash > 0 ? '' : 'down') +
      '</div>';

    var items = [];
    if (r.stockout > 0.01) items.push({ i: '⚠️', t: 'נגמר המלאי ל־' + fmtU(r.stockout) + ' קונים. זו הכנסה שלא תחזור.', k: 'bad' });
    if (r.capCrunch > 0.01) items.push({ i: '🏭', t: 'תוכנית הייצור נחתכה ב־' + fmtPct(r.capCrunch, 0) + ' בגלל מחסור בקיבולת.', k: 'warn' });
    if (r.dead > 0.005) items.push({ i: '📦', t: 'נמחקו ' + fmtU(r.dead) + ' יחידות מלאי מת.', k: 'warn' });
    if (r.fin.hold > 0.02) items.push({ i: '🧊', t: 'החזקת המלאי עלתה ' + fmtM(r.fin.hold) + ' החודש.', k: '' });
    if (!items.length) items.push({ i: '✅', t: 'החודש עבר בלי תקלות תפעוליות.', k: 'good' });

    body += '<div class="card"><div class="card-h"><h3>תפעול</h3></div><div class="report">' +
      items.map(function (x) { return '<div class="rep-item"><i>' + x.i + '</i><span>' + esc(x.t) + '</span></div>'; }).join('') +
      '</div></div>';

    if (r.top.length) {
      body += '<div class="card"><div class="card-h"><h3>המוצרים המובילים</h3></div><div class="rows">' +
        r.top.map(function (t) {
          return '<div class="row"><span class="row-main"><b>' + esc(t.n) + '</b><small>' + fmtU(t.u) + ' יחידות' +
            (t.so > 0.005 ? ' · חוסר ' + fmtU(t.so) : '') + '</small></span>' +
            '<span class="row-end"><b>' + fmtM(t.rev) + '</b></span></div>';
        }).join('') + '</div></div>';
    }

    var mc = r.board.mood < 35 ? 'note-bad' : r.board.mood < 55 ? 'note-warn' : 'note-good';
    body += '<div class="card"><div class="card-h"><h3>הדירקטוריון</h3>' +
      '<span class="hint num">' + Math.round(r.board.mood) + '/100</span></div>' +
      '<p class="note ' + mc + '">' + esc(r.board.notes.length ? r.board.notes.join(' ') : 'שקט. אין הערות החודש.') + '</p></div>';
  } else {
    body += '<div class="kpis">' +
      kpi('צפיות', fmtU(r.views), r.hiatus > 0 ? 'בהפסקה' : 'איכות ' + Math.round(r.quality)) +
      kpi('מנויים', fmtU(r.subs), (r.dSubs >= 0 ? '+' : '−') + fmtU(Math.abs(r.dSubs)), deltaCls(r.dSubs)) +
      kpi('תזרים', fmtSignK(r.income), 'בבנק ' + fmtK(r.bank), deltaCls(r.income)) +
      kpi('אמינות', Math.round(r.cred), 'שחיקה ' + Math.round(r.burn), r.cred < 32 ? 'down' : '') +
      '</div>';
    var ci = [];
    if (r.hiatus > 0) ci.push({ i: '🛑', t: 'הערוץ בהפסקה כפויה. הצפיות נופלות עד שחוזרים.' });
    if (r.burn > 70) ci.push({ i: '😵', t: 'רמת השחיקה מסוכנת. האיכות כבר משלמת על זה.' });
    if (r.cred < 35) ci.push({ i: '📉', t: 'האמינות נמוכה. הקהל מסנן, והיצרניות מפסיקות לשלוח יחידות.' });
    ci.push({ i: '📱', t: 'האלגוריתם דוחף כרגע ' + FORMATS[r.favor].n + '.' });
    body += '<div class="card"><div class="report">' +
      ci.map(function (x) { return '<div class="rep-item"><i>' + x.i + '</i><span>' + esc(x.t) + '</span></div>'; }).join('') + '</div></div>';
  }

  var news = G.log.filter(function (l) { return l.t === G.t - 1; }).slice(0, 6);
  if (news.length) {
    body += '<div class="card"><div class="card-h"><h3>מהיומן</h3></div><div class="ticker">' +
      news.map(function (l) { return tickRow(l); }).join('') + '</div></div>';
  }

  openSheet('סיכום ' + dateHe(G.t - 1), body,
    '<button class="btn btn-primary" data-act="closeSheet" style="width:100%">קדימה ל' + MONTHS_HE[turnM(G.t)] + '</button>');
}

function sheetEnd() {
  var e = G.ending || { t: 'סוף', x: '' };
  var body = '<div class="card ' + (e.win ? 'card-accent' : '') + '">' +
    '<p class="note ' + (e.win ? 'note-good' : 'note-bad') + '">' + esc(e.x) + '</p>' +
    (e.pts != null ? '<div class="facts" style="margin-top:11px"><div class="fact"><span>ניקוד</span><b>' + e.pts + '/100</b></div>' +
      '<div class="fact"><span>חודשים</span><b>' + G.t + '</b></div></div>' : '') +
    '</div>';
  if (G.hist.rev.length > 2) {
    body += '<div class="card"><div class="card-h"><h3>הקריירה</h3></div>' +
      svgLine([{ data: G.hist.rev, color: 'var(--cyan)', fill: 1 }, { data: G.hist.share, color: 'var(--accent)' }], { zero: 1, alt: 'סיכום קריירה' }) +
      legend([{ n: G.mode === 'ceo' ? 'הכנסה' : 'תזרים', c: 'var(--cyan)' }, { n: G.mode === 'ceo' ? 'נתח שוק' : 'מנויים', c: 'var(--accent)' }]) + '</div>';
  }
  openSheet(e.t, body, '<button class="btn btn-primary" data-act="reset" style="width:100%">משחק חדש</button>');
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI §31 — actions
   ═══════════════════════════════════════════════════════════════════════════ */

var ACTIONS = {
  tab: function (v) { UI.tab = v; render(); },
  cat: function (v) { UI.cat = v; UI.keepScroll = $('#main').scrollTop; render(); },
  closeSheet: function () { closeSheet(); render(); },

  /* products */
  prod: function (v) { sheetProduct(v); },
  newProd: function () { sheetDesign(); },
  autoAll: function () {
    var n = 0;
    G.prods.forEach(function (p) {
      if (p.co === G.me && p.live && !p.dead && !p.auto && (G.t - p.born) > 12) { p.auto = 1; n++; }
    });
    toast(n ? n + ' מוצרים עברו לניהול אוטומטי' : 'אין מוצרים מעל שנה');
    render();
  },
  pAuto: function (v) {
    var p = byId(v); if (!p) return;
    p.auto = p.auto ? 0 : 1;
    $('#sheetBody').innerHTML = renderProductSheet(p); paintRanges($('#sheetBody'));
    render();
  },
  killProd: function (v) {
    var p = byId(v); if (!p) return;
    cancelProduct(G, v);
    closeSheet(); render(); toast('הופסק: ' + p.name);
  },
  dCat: function (v) {
    var d = UI.draft; d.cat = v; d.spec = {};
    keys(CATS[v].w).forEach(function (k) { d.spec[k] = d.band === 'prem' ? 4 : d.band === 'mid' ? 3 : 2; });
    d.touched = 0; d.name = '';
    refreshDesign();
  },
  dBand: function (v) {
    var d = UI.draft; d.band = v;
    var t = v === 'prem' ? 4 : v === 'mid' ? 3 : 2;
    keys(d.spec).forEach(function (k) { d.spec[k] = t; });
    d.touched = 0; d.name = '';
    refreshDesign();
  },
  dSpec: function (v) {
    var parts = v.split(':');
    UI.draft.spec[parts[0]] = +parts[1];
    UI.draft.touched = 0;
    refreshDesign();
  },
  commitDesign: function () {
    var d = UI.draft;
    var r = designProduct(G, { cat: d.cat, spec: d.spec, price: d.price, name: (d.name || suggestName(d)).slice(0, 34), mkt: 0, prodPlan: 0 });
    if (!r.ok) { toast(r.why); return; }
    closeSheet(); render(); toast('הפיתוח יצא לדרך');
  },

  /* suppliers, capacity, board */
  supplier: function (v) { sheetSupplier(v); },
  pickSup: function (v) {
    var parts = v.split(':');
    var r = setContract(G, parts[0], parts[1]);
    if (!r.ok) { toast(r.why); return; }
    sheetSupplier(parts[0]); render(); toast('החוזה הוחלף');
  },
  capexSheet: function () { sheetCapex(); },
  commitCapex: function () {
    var r = buildCapacity(G, UI.draft.add);
    if (!r.ok) { toast(r.why); return; }
    closeSheet(); render(); toast('הקו נכנס לבנייה');
  },
  finance: function (v) { sheetFinance(v); },
  finTab: function (v) {
    UI.finTab = v;
    $('#sheetBody').innerHTML = renderFinance();
    paintRanges($('#sheetBody'));
  },
  loanTake: function () {
    var r = takeLoan(G, UI.draft.loan || 0);
    if (!r.ok) { toast(r.why); return; }
    UI.draft.loan = Math.min(UI.draft.loan || 0, loanHeadroom(G));
    ACTIONS.finTab('credit'); render(); toast('המשיכה בוצעה');
  },
  loanRepay: function () {
    var r = repayLoan(G, UI.draft.loan || 0);
    if (!r.ok) { toast(r.why); return; }
    ACTIONS.finTab('credit'); render(); toast('החוב קטן');
  },

  talentSheet: function () { sheetTalent(); },
  hire: function (v) {
    var r = hireTalent(G, v);
    if (!r.ok) { toast(r.why); return; }
    $('#sheetBody').innerHTML = renderTalent();
    render(); toast('חתמנו עם ' + r.t.name);
  },

  cheatSheet: function () { sheetCheat(); },
  cheatGo: function () {
    var el = document.getElementById('cheatIn');
    var r = applyCheat(G, el ? el.value : '');
    if (!r.ok) { toast(r.why); return; }
    saveGame(G); sheetCheat(); render(); toast(r.msg);
  },

  expand: function () { sheetExpand(); },
  xFound: function () {
    if (UI.draft && UI.draft.coName) G.creator.coName = UI.draft.coName.slice(0, 22);
    var r = expandToIndustry(G, 'found');
    if (!r.ok) { toast(r.why); return; }
    UI.tab = 'dash'; UI.cat = CO_BY_ID[G.me].focus[0];
    closeSheet(); saveGame(G); render(); toast('החברה קמה');
  },
  xHire: function (v) {
    var r = expandToIndustry(G, 'hire', v);
    if (!r.ok) { toast(r.why); return; }
    UI.tab = 'dash'; UI.cat = (CO_BY_ID[G.me] || { focus: ['phone'] }).focus[0];
    closeSheet(); saveGame(G); render(); toast('התפקיד שלכם');
  },

  dPkg: function (v) {
    var parts = v.split(':');
    setPkgTier({ spec: UI.draft.spec, cat: UI.draft.cat }, parts[0], +parts[1]);
    UI.draft.touched = 0;
    refreshDesign();
  },

  /* creator */
  rest: function () { G.creator.plan.rest = G.creator.plan.rest ? 0 : 1; render(); },
  deal: function (v) {
    var C = G.creator, d = C.deals[+v];
    if (!d) return;
    C.active.push({ n: d.n, pay: d.pay, months: d.months + 1, shady: d.shady });
    C.cred = clamp(C.cred - d.cred, 0, 100);
    C.deals.splice(+v, 1);
    toast(d.shady ? 'הכסף נכנס. האמינות ירדה ב־' + d.cred.toFixed(1) : 'נחתם');
    render();
  },
  invite: function (v) {
    var C = G.creator, iv = C.invites[+v];
    if (!iv) return;
    C.viewBoost = (C.viewBoost || 1) * 1.22;
    C.rel[iv.co] = (C.rel[iv.co] || 40) + 6;
    C.invites.splice(+v, 1);
    pushLog(G, '🎬', 'קיבלנו יחידת חשיפה מוקדמת מ־' + G.cos[iv.co].n + '.');
    toast('החשיפה המוקדמת שלנו');
    render();
  },
  declineInvite: function (v) {
    var C = G.creator;
    C.cred = clamp(C.cred + 1.4, 0, 100);
    C.invites.splice(+v, 1);
    toast('ויתרנו. האמינות עלתה קצת.');
    render();
  },
  dilemma: function (v) {
    var C = G.creator;
    var D = DILEMMAS.filter(function (d) { return d.id === C.dilemma; })[0];
    if (!D) return;
    var msg = D.o[+v].f(G, C);
    C.dilemma = null;
    pushLog(G, '🎲', D.t + ' — ' + msg);
    toast(msg);
    render();
  },

  /* shell */
  save: function () { toast(saveGame(G) ? 'נשמר' : 'השמירה נכשלה'); },
  reset: function () {
    if (!confirm('להתחיל משחק חדש? המשחק הנוכחי יימחק.')) return;
    clearSave(); closeSheet();
    G = null;
    $('#shell').hidden = true;
    $('#boot').hidden = false;
    bootInit();
  },
  menu: function () {
    UI.tab = 'more'; render();
  }
};

function byId(id) { return G.prods.filter(function (p) { return p.id === id; })[0]; }
function refreshDesign() {
  $('#sheetBody').innerHTML = renderDesign();
  $('#sheetFoot').innerHTML = designFoot();
  paintRanges($('#sheetBody'));
}

/* range/text inputs — continuous, so they are handled separately from clicks */
var INPUTS = {
  rnd: function (v, k) { G.plan.rnd[k] = round(v / 100 * rndCeiling(), 4); render(); },
  payout: function (v) { G.plan.payout = v / 100; render(); },
  press: function (v) { G.plan.press = +v; render(); },
  pPrice: function (v, id) {
    var p = byId(id); if (!p) return;
    p.price = +v;
    $('#sheetBody').innerHTML = renderProductSheet(p); paintRanges($('#sheetBody'));
  },
  pMkt: function (v, id) {
    var p = byId(id); if (!p) return;
    p.mkt = round(v / 100 * mktBudget(G.cos[G.me]), 4);
    $('#sheetBody').innerHTML = renderProductSheet(p); paintRanges($('#sheetBody'));
  },
  pPlan: function (v, id) {
    var p = byId(id); if (!p) return;
    var maxPlan = Math.max(0.2, effectiveCapacity(G, G.cos[G.me]) / LINE_USE[p.cat]);
    p.prodPlan = round(v / 1000 * maxPlan, 4);
    $('#sheetBody').innerHTML = renderProductSheet(p); paintRanges($('#sheetBody'));
  },
  dPrice: function (v) { UI.draft.price = +v; UI.draft.touched = 1; refreshDesign(); },
  xName: function (v) { UI.draft = UI.draft || {}; UI.draft.coName = v; },
  loanAmt: function (v) {
    UI.draft = UI.draft || {};
    UI.draft.loan = round(v / 1000 * loanHeadroom(G), 3);
    $('#sheetBody').innerHTML = renderFinance();
    paintRanges($('#sheetBody'));
  },
  dName: function (v) { UI.draft.name = v; },
  capexAmt: function (v) {
    var maxAdd = Math.max(1, effectiveCapacity(G, G.cos[G.me]) * 0.8);
    UI.draft.add = round(v / 1000 * maxAdd, 3);
    $('#sheetBody').innerHTML = renderCapex();
    $('#sheetFoot').innerHTML = capexFoot();
    paintRanges($('#sheetBody'));
  },
  vids: function (v) { G.creator.plan.videos = +v; render(); },
  mix: function (v, k) {
    var P = G.creator.plan, want = clamp(v / 100, 0, 1);
    var others = FK.filter(function (x) { return x !== k; });
    var rest = sum(others.map(function (x) { return P.mix[x] || 0; }));
    P.mix[k] = want;
    var left = 1 - want;
    if (rest > 0.0001) others.forEach(function (x) { P.mix[x] = (P.mix[x] || 0) / rest * left; });
    else others.forEach(function (x) { P.mix[x] = left / others.length; });
    render();
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   UI §32 — boot screen
   ═══════════════════════════════════════════════════════════════════════════ */

function bootInit() {
  UI.mode = 'ceo';
  UI.pick = null;
  renderPickers();
  var saved = loadGame();
  $('#resumeBtn').hidden = !saved;
  if (saved) {
    $('#resumeBtn').textContent = 'המשך: ' +
      (saved.mode === 'ceo' ? (CO_BY_ID[saved.me] ? CO_BY_ID[saved.me].he : '—') : (saved.creator ? saved.creator.name : 'ערוץ')) +
      ' · ' + dateHe(saved.t);
  }
  syncStart();
}

function renderPickers() {
  var customCard =
    '<button class="co-card' + (UI.mode === 'ceo' && UI.pick === CUSTOM_ID ? ' is-on' : '') + '" data-pick="' + CUSTOM_ID + '">' +
    '<span class="co-top">' +
    '<span class="co-mark" style="color:var(--accent)">+</span>' +
    '<span class="co-h"><strong>הסטארטאפ שלכם</strong><small>' + esc(ARCH.startup.n) + '</small></span>' +
    '</span>' +
    '<span class="co-desc">להתחיל מאפס: לתת שם, מוצר אחד, קו ייצור זעיר ומסלול מזומן קצר. אין מותג ואין ערוץ הפצה — אבל גם אף אחד לא מצפה מכם לדיבידנד ברבעון הבא.</span>' +
    '<span class="co-stats">' +
    '<span class="tag">מזומן ' + N(fmtM(0.55)) + '</span>' +
    '<span class="tag">מותג ' + N(14) + '</span>' +
    '<span class="tag tag-cyan">קיבולת ' + N(fmtU(0.42)) + '</span>' +
    '<span class="tag tag-accent">המסלול הקשה</span>' +
    '</span></button>';

  $('#coList').innerHTML = customCard + CO_DEFS.filter(function (d) { return d.playable; }).map(function (d) {
    var A = ARCH[d.arch];
    return '<button class="co-card' + (UI.mode === 'ceo' && UI.pick === d.id ? ' is-on' : '') + '" data-pick="' + d.id + '">' +
      '<span class="co-top">' +
      '<span class="co-mark" style="color:' + (d.arch === 'startup' ? 'var(--accent)' : d.arch === 'challenger' ? 'var(--cyan)' : 'var(--violet)') + '">' +
      esc(d.n.slice(0, 2).toUpperCase()) + '</span>' +
      '<span class="co-h"><strong>' + esc(d.he) + ' · ' + esc(d.n) + '</strong><small>' + esc(A.n) + '</small></span>' +
      '</span>' +
      '<span class="co-desc">' + esc(d.d) + '</span>' +
      '<span class="co-stats">' +
      '<span class="tag">מזומן ' + N(fmtM(d.cash)) + '</span>' +
      '<span class="tag">מותג ' + N(d.brand) + '</span>' +
      '<span class="tag tag-cyan">קיבולת ' + N(fmtU(d.capacity)) + '</span>' +
      '<span class="tag tag-violet">הכנסה אחרת ' + N(fmtM(d.otherRev)) + '</span>' +
      '<span class="tag' + (d.arch === 'startup' ? ' tag-accent' : '') + '">יעד צמיחה ' + N(fmtPct(A.growth, 0)) + '</span>' +
      '</span></button>';
  }).join('');

  $('#crList').innerHTML = CREATOR_DEFS.map(function (d) {
    return '<button class="co-card' + (UI.mode === 'creator' && UI.pick === d.id ? ' is-on' : '') + '" data-pick="' + d.id + '">' +
      '<span class="co-top">' +
      '<span class="co-mark" style="color:var(--accent)">▶</span>' +
      '<span class="co-h"><strong>' + esc(d.n) + '</strong><small>' + N(fmtU(d.subs)) + ' מנויים בפתיחה</small></span>' +
      '</span>' +
      '<span class="co-desc">' + esc(d.d) + '</span>' +
      '<span class="co-stats">' +
      '<span class="tag tag-cyan">אמינות ' + N(d.cred) + '</span>' +
      '<span class="tag tag-violet">מיומנות ' + N(d.skill) + '</span>' +
      '<span class="tag">בבנק ' + N(fmtK(d.bank)) + '</span>' +
      '</span></button>';
  }).join('');
}

function syncStart() {
  var b = $('#startBtn');
  var custom = UI.mode === 'ceo' && UI.pick === CUSTOM_ID;
  $('#customFields').hidden = !custom;
  b.disabled = !UI.pick;
  b.textContent = !UI.pick ? 'בחרו כיסא כדי להתחיל'
    : custom ? 'להקים את החברה'
      : UI.mode === 'ceo' ? 'להיכנס לתפקיד ב' + CO_BY_ID[UI.pick].he
        : 'להעלות את הערוץ לאוויר';
}

function startGame() {
  if (!UI.pick) return;
  var seed = ($('#seedIn').value || '').trim();
  var opts = null;
  if (UI.mode === 'ceo' && UI.pick === CUSTOM_ID) {
    var nm = ($('#coNameIn').value || '').trim().slice(0, 22);
    opts = { custom: { name: nm || 'החברה שלנו' } };
  }
  G = newGame(UI.pick, seed, UI.mode, opts);
  UI.tab = 'dash';
  UI.cat = G.mode === 'ceo' && CO_BY_ID[G.me] ? CO_BY_ID[G.me].focus[0] : 'phone';
  enterShell();
}

function enterShell() {
  $('#boot').hidden = true;
  $('#shell').hidden = false;
  saveGame(G);
  render();
  if (G.over) sheetEnd();
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI §33 — turn button and global wiring
   ═══════════════════════════════════════════════════════════════════════════ */

function doNextMonth() {
  if (!G || G.over) return;
  closeSheet();
  endTurn(G);
  saveGame(G);
  UI.keepScroll = 0;
  render();
  if (G.over) sheetEnd(); else sheetReport();
}

/* The engine above runs anywhere; everything from here down needs a DOM.
   Guarding it keeps `require('app.js')` usable for balance testing in Node. */
if (typeof document !== 'undefined') {

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act],[data-pick],#nextBtn,#sheetClose,#scrim,#startBtn,#resumeBtn,.seg-btn') : null;
    if (!t) return;

    if (t.id === 'nextBtn') { doNextMonth(); return; }
    if (t.id === 'sheetClose' || t.id === 'scrim') { closeSheet(); return; }
    if (t.id === 'startBtn') { startGame(); return; }
    if (t.id === 'resumeBtn') {
      var saved = loadGame();
      if (!saved) { toast('אין משחק שמור'); return; }
      G = saved;
      UI.tab = 'dash';
      UI.cat = G.mode === 'ceo' && CO_BY_ID[G.me] ? CO_BY_ID[G.me].focus[0] : 'phone';
      enterShell();
      return;
    }
    if (t.classList.contains('seg-btn')) {
      UI.mode = t.dataset.mode;
      UI.pick = null;
      document.querySelectorAll('.seg-btn').forEach(function (b) {
        var on = b === t;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', String(on));
      });
      $('#pickCeo').hidden = UI.mode !== 'ceo';
      $('#pickCreator').hidden = UI.mode !== 'creator';
      renderPickers();
      syncStart();
      return;
    }
    if (t.dataset.pick) {
      UI.pick = t.dataset.pick;
      renderPickers();
      syncStart();
      return;
    }
    var act = t.dataset.act;
    if (act && ACTIONS[act]) { e.preventDefault(); ACTIONS[act](t.dataset.v); }
  }, false);

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t.dataset || !t.dataset.act) return;
    if (t.type === 'range') paintRanges(t.parentNode);
    var fn = INPUTS[t.dataset.act];
    if (fn) fn(t.type === 'text' ? t.value : +t.value, t.dataset.v);
  }, false);

  $('#menuBtn').addEventListener('click', function () { UI.tab = 'more'; render(); });

  /* Five taps on the company badge opens the code field. Nothing announces
     it; the count resets if you dawdle. */
  var badgeTaps = 0, badgeTimer = null;
  $('#tbBadge').addEventListener('click', function () {
    badgeTaps++;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(function () { badgeTaps = 0; }, 1400);
    if (badgeTaps >= 5) { badgeTaps = 0; sheetCheat(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && UI.sheet) closeSheet();
  });

  /* boot */
  (function () {
    var saved = loadGame();
    bootInit();
    if (saved && !saved.over) {
      /* an unfinished run resumes straight away — the picker is one tap behind */
      G = saved;
      UI.tab = 'dash';
      UI.cat = G.mode === 'ceo' && CO_BY_ID[G.me] ? CO_BY_ID[G.me].focus[0] : 'phone';
      enterShell();
    }
  })();

  /* keep the shell honest when the on-screen keyboard or browser bars resize it */
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      document.documentElement.style.setProperty('--vvh', window.visualViewport.height + 'px');
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache is optional */ });
    });
  }

}

/* Node can require this file for balance testing; the browser gets the UI. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    newGame: newGame, endTurn: endTurn, migrateSave: migrateSave,
    hireTalent: hireTalent, genTalent: genTalent, takeLoan: takeLoan, repayLoan: repayLoan,
    creditLimit: creditLimit, loanHeadroom: loanHeadroom, insolvencyLimit: insolvencyLimit,
    applyCheat: applyCheat,
    canExpand: canExpand, expandToIndustry: expandToIndustry, raiseAmount: raiseAmount,
    strugglingCompanies: strugglingCompanies, ecoPull: ecoPull,
    PKGS: PKGS, pkgsFor: pkgsFor, pkgTier: pkgTier, setPkgTier: setPkgTier, makeCustomDef: makeCustomDef,
    designProduct: designProduct, cancelProduct: cancelProduct, setContract: setContract,
    buildCapacity: buildCapacity, devCost: devCost, devMonths: devMonths,
    capacityUsed: capacityUsed, effectiveCapacity: effectiveCapacity, capexQuote: capexQuote,
    fairPrice: fairPrice, hypeOf: hypeOf, freshnessOf: freshnessOf,
    LINE_USE: LINE_USE, CAPEX_PER_LINE: CAPEX_PER_LINE, CAPEX_MONTHS: CAPEX_MONTHS,
    scoreOf: scoreOf, qualityOf: qualityOf, unitCostOf: unitCostOf,
    CATS: CATS, CO_DEFS: CO_DEFS, SUPPLIERS: SUPPLIERS, CREATORS: CREATORS,
    ARCH: ARCH, TECH: TECH, PARTS: PARTS, VERSION: VERSION,
    FORMATS: FORMATS, CREATOR_DEFS: CREATOR_DEFS, DILEMMAS: DILEMMAS,
    EVENTS: EVENTS, CHEATS: CHEATS, ROLES: ROLES, CUSTOM_ID: CUSTOM_ID
  };
}
