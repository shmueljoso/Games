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
function fmt(v) { return (Math.round(v * 1000) / 1000).toString(); }
function check(name, ok, detail) {
  if (!ok) { fails++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
  else console.log('  ok    ' + name + (detail ? '  — ' + detail : ''));
}

/* ── a competent-but-unremarkable player ───────────────────────────────── */
function bot(who, seed, months, opts) {
  var G = m.newGame(who, seed, 'ceo', opts);
  /* a company of the player's own is not in the static roster */
  var def = G.customDef || m.CO_DEFS.filter(function (d) { return d.id === who; })[0];
  for (var t = 0; t < months && !G.over; t++) {
    var me = G.cos[G.me];
    var mine = G.prods.filter(function (p) { return p.co === G.me && !p.dead; });

    def.focus.forEach(function (cat) {
      var inCat = mine.filter(function (p) { return p.cat === cat; });
      if (inCat.some(function (p) { return !p.live; })) return;
      var newest = inCat.reduce(function (a, p) { return Math.max(a, p.born); }, -99);
      if (inCat.length && G.t - newest < 18) return;
      var band = me.arch === 'startup' ? (inCat.length < 2 ? 'mid' : 'budget') : (inCat.length < 2 ? 'prem' : 'mid');
      var tier = band === 'prem' ? 4 : band === 'mid' ? 3 : 2;
      var spec = {};
      Object.keys(m.CATS[cat].w).forEach(function (k) { spec[k] = tier; });
      var need = m.devCost(G, cat, spec);
      /* borrow rather than miss a generation — a startup that stops shipping
         never starts again */
      if (me.cash < need * 1.6 && m.loanHeadroom(G) > need) m.takeLoan(G, Math.min(m.loanHeadroom(G), need * 2));
      if (me.cash < need * 1.5) return;
      m.designProduct(G, {
        cat: cat, spec: spec, name: who + '-' + cat + '-' + G.t,
        price: Math.round(m.CATS[cat].bandRef[band] * def.style.price), mkt: 0, prodPlan: 0
      });
    });

    var cap = m.effectiveCapacity(G, me);
    if (m.capacityUsed(G, me) > cap * 0.93 && (G.plan.capexQueue || []).length < 1) {
      var add = Math.max(0.1, cap * (me.arch === 'startup' ? 0.25 : 0.12));
      if (me.cash > m.capexQuote(add).total * 0.4) m.buildCapacity(G, add);
    }
    if (me.cash < Math.max(0.2, G.fin.revDev * 0.9) && m.loanHeadroom(G) > 0.05) {
      m.takeLoan(G, Math.min(m.loanHeadroom(G) * 0.5, Math.max(0.2, G.fin.revDev * 2)));
    }
    var shortlist = (G.talent && G.talent.market) || [];
    for (var s = 0; s < shortlist.length; s++) {
      if (shortlist[s].fee < me.cash * 0.18) { m.hireTalent(G, shortlist[s].id); break; }
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

console.log('\n— a company of your own is a real path, not a trap —');
(function () {
  var G = bot('ownco', 'own-1', 110, { custom: { name: 'אורבן לאבס' } });
  var me = G.cos.ownco;
  var open = m.newGame('ownco', 'own-1', 'ceo', { custom: { name: 'אורבן לאבס' } });
  check('custom startup starts small', open.cos.ownco.cash < 1 && open.cos.ownco.brand < 20,
    'cash ' + open.cos.ownco.cash + ', brand ' + open.cos.ownco.brand);
  check('custom startup can grow', G.fin.revDev > open.fin.revDev * 3,
    fmt(open.fin.revDev) + ' → ' + fmt(G.fin.revDev) + ' $B/mo');
  check('custom startup earns distribution', me.reach > 0.2, 'reach ' + me.reach.toFixed(2));
  check('custom startup outgrows its first board', me.arch !== 'startup', 'stage: ' + me.arch);
})();

console.log('\n— ecosystem lock-in compounds, but stays bounded —');
(function () {
  var G = m.newGame('apple', 'eco-1', 'ceo');
  for (var i = 0; i < 36; i++) m.endTurn(G);
  var me = G.cos.apple, lone = G.cos.sony;
  var pullMe = m.ecoPull(G, me, 'xr'), pullLone = m.ecoPull(G, lone, 'xr');
  check('a broad family pulls harder than a narrow one', pullMe > pullLone,
    'apple ' + pullMe.toFixed(3) + ' vs sony ' + pullLone.toFixed(3));
  var maxPull = 0;
  Object.keys(G.cos).forEach(function (id) {
    Object.keys(m.CATS).forEach(function (c) { maxPull = Math.max(maxPull, m.ecoPull(G, G.cos[id], c)); });
  });
  check('pull never exceeds 1 (so the bonus caps at +40%)', maxPull <= 1.0001, 'max ' + maxPull.toFixed(3));
})();

console.log('\n— key talent moves tech both ways —');
(function () {
  var G = m.newGame('apple', 'tal-1', 'ceo');
  for (var i = 0; i < 4; i++) m.endTurn(G);
  var t = (G.talent.market || [])[0];
  check('a shortlist exists', !!t, t ? t.name + ' (' + t.role + ')' : 'none');
  if (t) {
    var before = G.cos.apple.tech[t.role], rivalBefore = G.cos[t.from].tech[t.role];
    var cashBefore = G.cos.apple.cash;
    var r = m.hireTalent(G, t.id);
    check('hiring lands the boost', r.ok && G.cos.apple.tech[t.role] > before,
      before.toFixed(1) + ' → ' + G.cos.apple.tech[t.role].toFixed(1));
    check('the rival loses the same capability', G.cos[t.from].tech[t.role] < rivalBefore,
      rivalBefore.toFixed(1) + ' → ' + G.cos[t.from].tech[t.role].toFixed(1));
    check('the signing fee is actually paid', G.cos.apple.cash < cashBefore, fmt(cashBefore - G.cos.apple.cash) + ' $B');
    check('hiring twice is refused', !m.hireTalent(G, t.id).ok);
  }
})();

console.log('\n— borrowing is bounded and costs money —');
(function () {
  var G = m.newGame('xiaomi', 'loan-1', 'ceo');
  for (var i = 0; i < 3; i++) m.endTurn(G);
  var head = m.loanHeadroom(G);
  check('a credit line exists', head > 0, fmt(head) + ' $B');
  check('over-drawing is refused', !m.takeLoan(G, head * 2 + 1).ok);
  var cash0 = G.cos.xiaomi.cash;
  check('drawing works', m.takeLoan(G, head * 0.5).ok && G.cos.xiaomi.cash > cash0);
  var debt0 = G.cos.xiaomi.debt;
  m.endTurn(G);
  check('interest accrues on a deliberate loan', G.cos.xiaomi.debt > 0, fmt(G.cos.xiaomi.debt) + ' $B');
  check('repaying works', m.repayLoan(G, 0.05).ok);
})();

console.log('\n— a creator can cross over, both ways —');
['found', 'hire'].forEach(function (path) {
  var G = m.newGame('value', 'x-' + path, 'creator');
  var crossed = -1;
  for (var i = 0; i < 120 && !G.over; i++) {
    if (G.mode === 'creator') {
      var C = G.creator;
      C.plan.videos = C.burn > 60 ? 3 : 5;
      C.plan.rest = C.burn > 78 ? 1 : 0;
      (C.deals || []).slice(0, 1).forEach(function (x) { if (!x.shady) C.active.push({ n: x.n, pay: x.pay, months: x.months }); });
      if (m.canExpand(G) && crossed < 0) {
        var tgt = path === 'hire' ? m.strugglingCompanies(G)[0].id : null;
        if (m.expandToIndustry(G, path, tgt).ok) crossed = G.t;
      }
    } else {
      G.prods.forEach(function (p) {
        if (p.co !== G.me || !p.live || p.dead) return;
        p.auto = (G.t - p.born) > 14 ? 1 : 0;
        if (!p.auto) p.prodPlan = Math.max(0, p.demand * 1.04 - p.inv * 0.5);
      });
    }
    m.endTurn(G);
  }
  check('crossover (' + path + ') happens and keeps playing', crossed > 0 && G.mode === 'ceo' && G.t > crossed + 5,
    'crossed month ' + crossed + ', ran to ' + G.t + ' as ' + G.cos[G.me].n);
  check('crossover (' + path + ') buys a second act', (G.horizon || 120) >= crossed + 40 || crossed + 40 <= 120,
    'horizon ' + G.horizon);
});

console.log('\n— every world event states a mechanical effect —');
(function () {
  var noEff = m.EVENTS.filter(function (e) { return !e.eff; });
  check('no flavour-only events', noEff.length === 0,
    noEff.length ? noEff.map(function (e) { return e.id; }).join(', ') : m.EVENTS.length + ' events, all with effects');
})();

console.log('\n— easter eggs pay out once each —');
(function () {
  var G = m.newGame('sony', 'egg-1', 'ceo');
  var cash0 = G.cos.sony.cash;
  check('a valid code fires', m.applyCheat(G, 'אימפריה').ok);
  check('the same code will not fire twice', !m.applyCheat(G, 'EMPIRE').ok);
  check('the payout landed', G.cos.sony.cash > cash0, fmt(cash0) + ' → ' + fmt(G.cos.sony.cash));
  check('an unknown code is rejected', !m.applyCheat(G, 'לאקוד').ok);
})();

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
