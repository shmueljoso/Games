/* Headless balance + regression harness. No build step, no dependencies:
 *
 *     node tech-empire/test/balance.js
 *
 * It plays every company twice — once doing nothing at all, once with a
 * deliberately mediocre bot — and asserts the sim stays inside believable
 * bounds. Doing nothing must be punished; playing competently must be
 * survivable for every seat on the roster.
 */
var m = require('../app.js');

var fails = 0;
function check(name, ok, detail) {
  if (!ok) { fails++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
  else console.log('  ok    ' + name + (detail ? '  — ' + detail : ''));
}

/* ── a competent-but-unremarkable player ───────────────────────────────── */
function bot(who, seed, months) {
  var G = m.newGame(who, seed, 'ceo');
  var def = m.CO_DEFS.filter(function (d) { return d.id === who; })[0];
  for (var t = 0; t < months && !G.over; t++) {
    var me = G.cos[G.me];
    var mine = G.prods.filter(function (p) { return p.co === G.me && !p.dead; });

    def.focus.forEach(function (cat) {
      var inCat = mine.filter(function (p) { return p.cat === cat; });
      if (inCat.some(function (p) { return !p.live; })) return;
      var newest = inCat.reduce(function (a, p) { return Math.max(a, p.born); }, -99);
      if (inCat.length && G.t - newest < 18) return;
      var band = inCat.length < 2 ? 'prem' : 'mid';
      var spec = {};
      Object.keys(m.CATS[cat].w).forEach(function (k) { spec[k] = band === 'prem' ? 4 : 3; });
      if (me.cash < m.devCost(G, cat, spec) * 3) return;
      m.designProduct(G, {
        cat: cat, spec: spec, name: who + '-' + cat + '-' + G.t,
        price: Math.round(m.CATS[cat].bandRef[band] * def.style.price), mkt: 0, prodPlan: 0
      });
    });

    var cap = m.effectiveCapacity(G, me);
    if (m.capacityUsed(G, me) > cap * 0.94 && (G.plan.capexQueue || []).length < 1) {
      var add = Math.max(0.15, cap * 0.12);
      if (me.cash > add * m.CAPEX_PER_LINE * 1.5) m.buildCapacity(G, add);
    }

    var wallet = def.style.mkt * Math.max(0.06, me.otherRev * 0.5 + G.fin.revDev * 0.7 + 0.2);
    var live = mine.filter(function (p) { return p.live; });
    live.forEach(function (p) {
      p.auto = (G.t - p.born) > 14 ? 1 : 0;
      if (!p.auto) {
        p.prodPlan = Math.max(0, p.demand * 1.04 - p.inv * 0.5);
        p.mkt = wallet / Math.max(1, live.length);
      }
    });
    m.endTurn(G);
  }
  return G;
}

function idle(who, seed, months, mode) {
  var G = m.newGame(who, seed, mode || 'ceo');
  for (var t = 0; t < months && !G.over; t++) m.endTurn(G);
  return G;
}

console.log('\n— active play must be survivable for every playable seat —');
m.CO_DEFS.filter(function (d) { return d.playable; }).forEach(function (d) {
  var G = bot(d.id, 'bal-' + d.id, 72);
  var me = G.cos[d.id];
  check(d.id + ' survives 72 months', !G.over,
    'mood ' + G.board.mood.toFixed(0) + ', margin ' + (G.fin.margin * 100).toFixed(0) + '%, cash ' + me.cash.toFixed(0));
});

console.log('\n— doing nothing must cost you the chair —');
['apple', 'xiaomi', 'nothing'].forEach(function (id) {
  var G = idle(id, 'idle-' + id, 90);
  check(id + ' idle is punished', G.over || G.board.warnings >= 1 || G.board.mood < 45,
    'warnings ' + G.board.warnings + ', mood ' + G.board.mood.toFixed(0));
});

console.log('\n— the market must stay a market —');
(function () {
  var G = idle('apple', 'mkt', 96);
  Object.keys(m.CATS).forEach(function (k) {
    var base0 = m.CATS[k].base, base = G.market[k].base;
    var ratio = base / base0;
    check(k + ' installed base stays believable', ratio > 0.6 && ratio < (k === 'xr' ? 8 : 1.5),
      '×' + ratio.toFixed(2));
    var shares = Object.keys(G.market[k].shares).map(function (i) { return G.market[k].shares[i]; });
    var top = shares.length ? Math.max.apply(null, shares) : 0;
    check(k + ' no runaway monopoly', top < 0.90, 'top share ' + (top * 100).toFixed(0) + '%');
    var tot = shares.reduce(function (a, b) { return a + b; }, 0);
    check(k + ' shares sum to 1', Math.abs(tot - 1) < 0.01 || shares.length === 0, tot.toFixed(3));
  });
})();

console.log('\n— every creator archetype must be playable —');
m.CREATOR_DEFS.forEach(function (d) {
  var G = m.newGame(d.id, 'cr-' + d.id, 'creator');
  var C = G.creator;
  for (var i = 0; i < 120 && !G.over; i++) {
    C.plan.videos = C.burn > 60 ? 3 : 5;
    C.plan.rest = C.burn > 78 ? 1 : 0;
    (C.deals || []).slice(0, 1).forEach(function (x) {
      if (!x.shady) C.active.push({ n: x.n, pay: x.pay, months: x.months });
    });
    m.endTurn(G);
  }
  check(d.id + ' reaches the horizon', G.t >= 100 || (G.ending && G.ending.win),
    'subs ' + C.subs.toFixed(2) + 'M, cred ' + C.cred.toFixed(0) + ', bank $' + C.bank.toFixed(0) + 'K');
});

console.log('\n— saves survive a version change —');
(function () {
  var G = bot('samsung', 'save', 18);
  var round = JSON.parse(JSON.stringify(G));
  check('a save round-trips through JSON', m.migrateSave(round) !== null);

  /* simulate a save written by an older build: strip fields added since */
  var old = JSON.parse(JSON.stringify(G));
  old.version = 1;
  delete old.hist; delete old.board; delete old.world;
  delete old.plan.capexQueue; delete old.plan.payout;
  old.prods.forEach(function (p) { delete p.auto; delete p.rev_by; delete p.inv; });
  Object.keys(old.cos).forEach(function (id) { delete old.cos[id].rev12; });
  var migrated = m.migrateSave(old);
  check('a v1 save migrates', migrated && migrated.version === m.VERSION);
  var ok = true;
  try { for (var i = 0; i < 12; i++) m.endTurn(migrated); } catch (e) { ok = false; console.log('   ' + e.message); }
  check('a migrated save keeps playing', ok, 'reached month ' + migrated.t);
})();

console.log(fails ? '\n' + fails + ' check(s) failed\n' : '\nall checks passed\n');
process.exit(fails ? 1 : 0);
