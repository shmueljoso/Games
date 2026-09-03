/*
 * מנוע המשחק "מעגל הצבעים" — מופרד לגמרי מה-DOM כדי שאפשר להריץ אותו
 * ב-Node לבדיקות איזון (ראו test-balance.js), וגם ב-דפדפן דרך <script>.
 *
 * מודל: מסלול קו ישר (לא באמת עיגול) לאורך trackLength יחידות. 0 = נקודת
 * ההופעה, trackLength = "הבור" שבו מפסידים. הרינדור ממפה את זה לקשת של
 * מעגל. שרשרת הכדורים ("הרכבת") נעה קדימה לבד; השחקן יורה כדורים משלו
 * (shooter) כדי להכניס אותם לשרשרת וליצור רצף של 3+ מאותו צבע שנפלט.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ColorLoopEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────── PRNG זרעי, כדי שאפשר לשחזר מצב בבדיקות ─────────
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return function rng() {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEFAULTS = {
    ballWidth: 40,
    trackLength: 2600,
    catchUpMultiplier: 3.2,
    comboWindow: 1.4, // שניות שבהן פליטה נוספת עדיין נחשבת לאותו שילוב
  };

  function randColor(rng, colorCount) {
    return Math.floor(rng() * colorCount);
  }

  // רק צבעים שעדיין קיימים איפשהו במשחק (בשרשרת או בתור ההופעה) — כדי
  // שהשחקן לעולם לא יקבל כדור שאין לו שום שימוש אפשרי, כמו בבועות-יריות
  // אמיתיות. בלי זה, שאריות אחרונות של צבע נדיר עלולות להשאיר שלב שאי
  // אפשר לנצח בו בגלל מזל רע בלבד.
  function availableColors(state) {
    const set = new Set();
    for (const b of state.chain) set.add(b.color);
    for (const c of state.spawnQueue) set.add(c);
    if (set.size === 0) {
      for (let i = 0; i < state.cfg.colorCount; i++) set.add(i);
    }
    return Array.from(set);
  }

  function randAvailableColor(state) {
    const avail = availableColors(state);
    return avail[Math.floor(state.rng() * avail.length)];
  }

  function createLevel(config, seed) {
    const rng = makeRng(seed == null ? Date.now() : seed);
    const cfg = Object.assign({}, DEFAULTS, config);
    const chain = [];
    for (let i = 0; i < cfg.initialTrain; i++) {
      chain.push({ id: 'b' + i, color: randColor(rng, cfg.colorCount), pos: i * cfg.ballWidth });
    }
    const spawnQueue = [];
    for (let i = cfg.initialTrain; i < cfg.ballCount; i++) {
      spawnQueue.push(randColor(rng, cfg.colorCount));
    }
    const state = {
      cfg,
      rng,
      chain,
      spawnQueue,
      spawnTimer: cfg.spawnInterval,
      shooter: { current: 0, next: 0 },
      score: 0,
      combo: 0,
      comboTimer: 0,
      status: 'playing', // playing | won | lost
      elapsed: 0,
      nextId: cfg.initialTrain,
      lastEvents: [], // אירועים מהטיק/ירייה האחרונה, לצריכת ה-UI (פליטה, אפקטים)
    };
    state.shooter.current = randAvailableColor(state);
    state.shooter.next = randAvailableColor(state);
    return state;
  }

  function resolveMatches(state) {
    const { chain, cfg } = state;
    const eps = 0.001;
    let removedAny = false;
    let guard = 0;
    while (guard++ < 1000) {
      let found = false;
      for (let i = 0; i < chain.length; i++) {
        // מרחיבים ריצה של אותו צבע שכולה "נוגעת" (אין רווח בין הכדורים)
        let hi = i;
        while (
          hi + 1 < chain.length &&
          chain[hi + 1].color === chain[i].color &&
          chain[hi + 1].pos - chain[hi].pos <= cfg.ballWidth + eps
        ) {
          hi++;
        }
        const runLen = hi - i + 1;
        if (runLen >= 3) {
          const removed = chain.splice(i, runLen);
          state.combo += 1;
          state.comboTimer = cfg.comboWindow;
          const multiplier = 1 + 0.5 * (state.combo - 1);
          const gained = Math.round(runLen * 10 * multiplier);
          state.score += gained;
          state.lastEvents.push({ type: 'pop', color: removed[0].color, count: runLen, pos: removed[0].pos, score: gained, combo: state.combo });
          removedAny = true;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return removedAny;
  }

  function tick(state, dt) {
    const { chain, cfg } = state;
    state.lastEvents = [];
    if (state.status !== 'playing') return state;
    state.elapsed += dt;

    // ספירה לאחור לירידת השילוב אם לא נוספה פליטה חדשה בזמן
    if (state.comboTimer > 0) {
      state.comboTimer -= dt;
      if (state.comboTimer <= 0) state.combo = 0;
    }

    // הופעת כדור חדש בסוף התור
    if (state.spawnQueue.length > 0) {
      state.spawnTimer -= dt;
      if (state.spawnTimer <= 0) {
        state.spawnTimer += cfg.spawnInterval;
        const color = state.spawnQueue.shift();
        const back = chain.length ? chain[0].pos : 0;
        const pos = chain.length ? Math.min(0, back - cfg.ballWidth) : 0;
        chain.unshift({ id: 'b' + (state.nextId++), color, pos });
      }
    }

    // תנועת הראש (הכדור הכי קרוב לבור)
    if (chain.length > 0) {
      const front = chain[chain.length - 1];
      front.pos += cfg.speed * dt;
      // שאר השרשרת: "תופסת" מהר יותר כשיש רווח, ונעצרת כדי לשמור מרחק מינימלי
      for (let i = chain.length - 2; i >= 0; i--) {
        const gap = chain[i + 1].pos - chain[i].pos;
        const catchUp = gap > cfg.ballWidth * 1.5 ? cfg.catchUpMultiplier : 1;
        const maxAllowed = chain[i + 1].pos - cfg.ballWidth;
        chain[i].pos = Math.min(chain[i].pos + cfg.speed * dt * catchUp, maxAllowed);
      }
    }

    resolveMatches(state);

    if (chain.length > 0 && chain[chain.length - 1].pos >= cfg.trackLength) {
      state.status = 'lost';
      return state;
    }
    if (state.chain.length === 0 && state.spawnQueue.length === 0) {
      state.status = 'won';
    }
    return state;
  }

  // מכניסים כדור צבע בנקודה targetPos (ביחידות מסלול). כמו ברכבת אמיתית:
  // הכדור החדש דוחק אחורה (הרחק מהבור) את מה שמאחוריו כדי לפנות מקום, אבל
  // אף פעם לא דוחף קדימה את מה שכבר לפניו — אחרת כל ירייה הייתה מקרבת
  // את ראש השרשרת לבור, גם כשהיא פוגעת בול ויוצרת פליטה.
  function insertBall(state, color, targetPos) {
    if (state.status !== 'playing') return state;
    const { chain, cfg } = state;
    // אין רצפת-0 מכוונת: כדורים פנימיים בשרשרת יכולים לגיטימית לשבת
    // בעמדה שלילית (עוד לא "נכנסו" חזותית למסלול), וצריך לדייק אליהם.
    let clamped = Math.min(targetPos, cfg.trackLength);
    if (chain.length > 0) clamped = Math.min(clamped, chain[chain.length - 1].pos);
    let idx = 0;
    while (idx < chain.length && chain[idx].pos < clamped) idx++;

    const frontPos = idx < chain.length ? chain[idx].pos : cfg.trackLength;
    let insertPos = Math.min(clamped, frontPos - cfg.ballWidth);

    if (idx > 0 && chain[idx - 1].pos > insertPos - cfg.ballWidth) {
      const shift = chain[idx - 1].pos - (insertPos - cfg.ballWidth);
      for (let j = idx - 1; j >= 0; j--) chain[j].pos -= shift;
    }

    const ball = { id: 'b' + (state.nextId++), color, pos: insertPos };
    chain.splice(idx, 0, ball);
    resolveMatches(state);

    if (chain.length > 0 && chain[chain.length - 1].pos >= cfg.trackLength) {
      state.status = 'lost';
    } else if (state.chain.length === 0 && state.spawnQueue.length === 0) {
      state.status = 'won';
    }
    return state;
  }

  // השחקן יורה: מכניס את הכדור ה"נוכחי" ומגלגל את התור (current/next)
  function shoot(state, targetPos) {
    if (state.status !== 'playing') return state;
    const color = state.shooter.current;
    insertBall(state, color, targetPos);
    state.shooter.current = state.shooter.next;
    state.shooter.next = randAvailableColor(state);
    return state;
  }

  return { createLevel, tick, insertBall, shoot, resolveMatches, availableColors, makeRng, DEFAULTS };
}));
