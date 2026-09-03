/*
 * בדיקות ל-engine.js: יחידה (לוגיקת התאמה/הכנסה/ניצחון-הפסד) + סימולציית
 * "בוט" חמדן שמשחק כל שלב, לתפוס באגים (NaN, ערכים שליליים, קריסות) ולוודא
 * שהשלבים הראשונים ניתנים למעבר סביר. מריצים עם: node test-balance.js
 */
'use strict';
const assert = require('assert');
const engine = require('./engine.js');
const { buildLevels } = require('./levels.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (err) {
    console.error('  ✗', name);
    console.error('   ', err.message);
    process.exitCode = 1;
  }
}

console.log('בדיקות יחידה — מנוע');

test('שלושה כדורים נוגעים באותו צבע נפלטים', () => {
  const state = engine.createLevel({ colorCount: 3, initialTrain: 0, ballCount: 0, speed: 50, spawnInterval: 99 }, 1);
  state.chain.push({ id: 'a', color: 0, pos: 0 });
  state.chain.push({ id: 'b', color: 0, pos: 40 });
  state.chain.push({ id: 'c', color: 0, pos: 80 });
  engine.resolveMatches(state);
  assert.strictEqual(state.chain.length, 0);
  assert.ok(state.score > 0);
  assert.strictEqual(state.combo, 1);
});

test('שני כדורים בלבד לא נפלטים', () => {
  const state = engine.createLevel({ colorCount: 3, initialTrain: 0, ballCount: 0, speed: 50, spawnInterval: 99 }, 2);
  state.chain.push({ id: 'a', color: 1, pos: 0 });
  state.chain.push({ id: 'b', color: 1, pos: 40 });
  engine.resolveMatches(state);
  assert.strictEqual(state.chain.length, 2);
});

test('הכנסת כדור באמצע שלישייה יוצרת פליטה מיידית', () => {
  const state = engine.createLevel({ colorCount: 3, initialTrain: 0, ballCount: 0, speed: 50, spawnInterval: 99 }, 3);
  state.chain.push({ id: 'a', color: 2, pos: 0 });
  state.chain.push({ id: 'b', color: 2, pos: 40 });
  engine.insertBall(state, 2, 20);
  assert.strictEqual(state.chain.length, 0);
});

test('הכנסה דוחקת שכנים ולא יוצרת חפיפה', () => {
  const state = engine.createLevel({ colorCount: 3, initialTrain: 0, ballCount: 0, speed: 50, spawnInterval: 99 }, 4);
  state.chain.push({ id: 'a', color: 0, pos: 0 });
  state.chain.push({ id: 'b', color: 1, pos: 40 });
  engine.insertBall(state, 2, 20);
  assert.strictEqual(state.chain.length, 3);
  for (let i = 1; i < state.chain.length; i++) {
    const gap = state.chain[i].pos - state.chain[i - 1].pos;
    assert.ok(gap >= state.cfg.ballWidth - 1e-6, 'gap too small: ' + gap);
  }
});

test('שרשרת תגובה: סגירת רווח יוצרת פליטה נוספת', () => {
  const state = engine.createLevel({ colorCount: 3, initialTrain: 0, ballCount: 0, speed: 1000, spawnInterval: 99 }, 5);
  // AA _ AA, מסירים משהו באמצע כדי לדמות מצב שבו שני מקטעים מאותו צבע
  // מתקרבים ונוגעים — צריך שיפלטו יחד ברגע שהרווח נסגר.
  state.chain.push({ id: 'a1', color: 0, pos: 0 });
  state.chain.push({ id: 'a2', color: 0, pos: 40 });
  state.chain.push({ id: 'gap1', color: 1, pos: 500 });
  state.chain.push({ id: 'a3', color: 0, pos: 540 });
  state.chain.push({ id: 'a4', color: 0, pos: 580 });
  engine.insertBall(state, 1, 500); // פוגע ב-gap1 => שלישיית 1 לא נוצרת (רק כדור בודד), אין פליטה כאן
  // עכשיו נסיר ידנית את חוצץ הצבע האחר ונריץ טיקים כדי לוודא שההתקרבות מפעילה פליטה
  state.chain = state.chain.filter(b => b.color === 0);
  for (let i = 0; i < 200 && state.chain.length > 0; i++) engine.tick(state, 0.05);
  assert.strictEqual(state.chain.length, 0, 'ארבעה כדורים מאותו צבע היו אמורים להיפלט אחרי שהרווח נסגר');
});

test('הראש שמגיע לסוף המסלול גורם להפסד', () => {
  const state = engine.createLevel({ colorCount: 3, initialTrain: 1, ballCount: 1, speed: 10000, spawnInterval: 99, trackLength: 100 }, 6);
  engine.tick(state, 1);
  assert.strictEqual(state.status, 'lost');
});

test('שרשרת ריקה ותור ריק => ניצחון', () => {
  const state = engine.createLevel({ colorCount: 3, initialTrain: 0, ballCount: 0, speed: 50, spawnInterval: 99 }, 7);
  engine.tick(state, 0.016);
  assert.strictEqual(state.status, 'won');
});

console.log('\nבדיקות איזון — סימולציית בוט על כל השלבים');

function pickTarget(state) {
  // בוט חמדן: קודם כול מחפש זוג נוגע באותו צבע (הצמדה אליו משלימה
  // שלישייה ופולטת מיד) — עדיף הזוג הכי קרוב לבור, כדי לקנות הכי הרבה
  // זמן. אם אין זוג, מצמיד ליד כדור בודד תואם (הכנה למשך הזה). ורק אם
  // הצבע לא קיים בכלל (מקרה קצה נדיר), יורה ליד ראש השרשרת בלי מטרה.
  const { chain, cfg } = state;
  const color = state.shooter.current;
  const eps = 0.001;
  for (let i = chain.length - 1; i > 0; i--) {
    if (
      chain[i].color === color &&
      chain[i - 1].color === color &&
      chain[i].pos - chain[i - 1].pos <= cfg.ballWidth + eps
    ) {
      return chain[i].pos;
    }
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].color === color) return chain[i].pos;
  }
  return chain.length ? chain[chain.length - 1].pos : 0;
}

function simulateLevel(level, maxSeconds) {
  const state = engine.createLevel(level, level.seed);
  const dt = 1 / 30;
  let sinceShot = 0;
  const shotInterval = 0.28;
  let maxCombo = 0;
  for (let t = 0; t < maxSeconds && state.status === 'playing'; t += dt) {
    engine.tick(state, dt);
    if (state.status !== 'playing') break;
    sinceShot += dt;
    if (sinceShot >= shotInterval) {
      sinceShot = 0;
      engine.shoot(state, pickTarget(state));
    }
    maxCombo = Math.max(maxCombo, state.combo);
    assert.ok(Number.isFinite(state.score), 'score not finite at level ' + level.id);
    assert.ok(state.score >= 0, 'negative score at level ' + level.id);
    for (const b of state.chain) assert.ok(Number.isFinite(b.pos), 'ball pos not finite at level ' + level.id);
  }
  return { won: state.status === 'won', score: state.score, maxCombo, elapsed: state.elapsed };
}

const levels = buildLevels();
assert.strictEqual(levels.length, 24);

let earlyWins = 0;
for (const level of levels) {
  const result = simulateLevel(level, 240);
  if (level.id <= 5 && result.won) earlyWins++;
  console.log(`  שלב ${level.id}: ${result.won ? 'ניצחון' : 'הפסד/לא הושלם'} | ניקוד ${result.score} | שילוב מקס ${result.maxCombo}`);
}

test('חמשת השלבים הראשונים ניתנים למעבר ע"י בוט חמדן פשוט', () => {
  assert.ok(earlyWins >= 4, `רק ${earlyWins}/5 שלבים ראשונים עברו — ייתכן שהאיזון קשה מדי בהתחלה`);
});

console.log(`\n${passed} בדיקות עברו.`);
if (process.exitCode) {
  console.error('יש בדיקות שנכשלו.');
} else {
  console.log('הכול תקין.');
}
