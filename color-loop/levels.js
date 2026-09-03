/*
 * הגדרת 24 השלבים של "מעגל הצבעים". כל שלב נגזר מנוסחה חלקה (יותר צבעים,
 * יותר כדורים, יותר מהירות, פחות זמן בין הופעות) כדי לקבל עקומת קושי
 * מדורגת. הזרע (seed) קבוע לכל שלב כך שהמשחק דטרמיניסטי וניתן לבדיקה
 * ב-Node (ראו test-balance.js) — לא פאזל עם "פתרון יחיד", אלא איזון של
 * מהירות/כדורים/צבעים שנבדק בסימולציה שהוא בר-מעבר.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ColorLoopLevels = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TOTAL_LEVELS = 24;

  function lerp(a, b, t) { return a + (b - a) * t; }

  function buildLevel(n) {
    // n: 1..TOTAL_LEVELS
    const t = (n - 1) / (TOTAL_LEVELS - 1);
    const colorCount = Math.min(6, 3 + Math.floor(t * 3.999));
    const initialTrain = 5 + Math.floor(t * 3);
    const ballCount = Math.round(lerp(20, 70, t));
    const speed = Math.round(lerp(40, 95, t));
    const spawnInterval = Number(lerp(1.7, 0.85, t).toFixed(2));
    return {
      id: n,
      name: `שלב ${n}`,
      colorCount,
      initialTrain,
      ballCount,
      speed,
      spawnInterval,
      seed: n * 104729, // ראשוני, כדי שהשלבים לא יתחילו דומים זה לזה
    };
  }

  function buildLevels() {
    const levels = [];
    for (let n = 1; n <= TOTAL_LEVELS; n++) levels.push(buildLevel(n));
    return levels;
  }

  function starsFor(level, result) {
    // result: {won, elapsed, maxCombo}
    if (!result.won) return 0;
    let stars = 1;
    const parScore = level.ballCount * 10;
    if (result.score >= parScore * 1.4) stars++;
    if (result.maxCombo >= 3) stars++;
    return Math.min(3, stars);
  }

  return { TOTAL_LEVELS, buildLevel, buildLevels, starsFor };
}));
