/*
 * בדיקות ל-engine.js: יחידה (עלויות, שרשרת ייצור, פריסטייג') + סימולציית
 * "בוט" חמדן שמשחק שעות של זמן-משחק, לתפוס באגים (NaN, ערכים שליליים,
 * צווארי-בקבוק שחוסמים את השרשרת) ולוודא שפריסטייג' ראשון בר-השגה בזמן
 * סביר. מריצים עם: node test-balance.js
 */
'use strict';
const assert = require('assert');
const engine = require('./engine.js');

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

test('קניית בניין מורידה כסף ומעלה כמות, ומחיר עולה גיאומטרית', () => {
  const state = engine.createState(1);
  state.resources.money = 1000;
  const cost1 = engine.currentBuildingCost(state, 'lumberjack');
  assert.ok(engine.buyBuilding(state, 'lumberjack'));
  assert.strictEqual(state.buildings.lumberjack, 1);
  assert.strictEqual(state.resources.money, 1000 - cost1);
  const cost2 = engine.currentBuildingCost(state, 'lumberjack');
  assert.ok(cost2 > cost1, 'המחיר הבא צריך להיות גבוה יותר');
});

test('אי אפשר לקנות בלי מספיק כסף', () => {
  const state = engine.createState(2);
  state.resources.money = 1;
  assert.strictEqual(engine.buyBuilding(state, 'lumberjack'), false);
  assert.strictEqual(state.buildings.lumberjack, 0);
});

test('לחיצה ידנית מוסיפה עצים לפי עוצמת הגרזן', () => {
  const state = engine.createState(3);
  engine.chopWood(state);
  assert.strictEqual(state.resources.wood, engine.clickPower(state));
});

test('חוטב עצים מייצר עצים בטיק בלי שום קלט', () => {
  const state = engine.createState(4);
  state.buildings.lumberjack = 5;
  engine.tick(state, 1);
  assert.ok(state.resources.wood > 0);
});

test('מסור לא מייצר קורות בלי עצים זמינים', () => {
  const state = engine.createState(5);
  state.buildings.sawmill = 10;
  engine.tick(state, 1);
  assert.strictEqual(state.resources.planks, 0);
  assert.strictEqual(state.resources.wood, 0);
});

test('שרשרת מלאה: עצים -> קורות -> עיסה -> נייר -> כסף', () => {
  const state = engine.createState(6);
  state.resources.wood = 1000;
  state.buildings.sawmill = 5;
  state.buildings.pulpMill = 5;
  state.buildings.paperPress = 5;
  state.buildings.salesTeam = 5;
  for (let i = 0; i < 200; i++) engine.tick(state, 1);
  assert.ok(state.resources.money > 0, 'אמור להיות כסף אחרי שהשרשרת רצה');
  assert.ok(state.lifetimeMoney >= state.resources.money);
});

test('שום משאב לא הופך שלילי או NaN אחרי הרבה טיקים', () => {
  const state = engine.createState(7);
  state.buildings = { lumberjack: 3, sawmill: 2, pulpMill: 2, paperPress: 1, salesTeam: 1 };
  for (let i = 0; i < 5000; i++) {
    engine.tick(state, 0.1);
    for (const k in state.resources) {
      assert.ok(Number.isFinite(state.resources[k]), k + ' not finite');
      assert.ok(state.resources[k] >= -1e-9, k + ' negative: ' + state.resources[k]);
    }
  }
});

test('פריסטייג׳ בלי כסף שהורווח בסבב הנוכחי לא נותן זרעים', () => {
  const state = engine.createState(8);
  assert.strictEqual(engine.prestige(state), 0);
  assert.strictEqual(state.prestige.seeds, 0);
});

test('פריסטייג׳ מאפס משאבים ובניינים אבל שומר זרעים ומכפיל תפוקה', () => {
  const state = engine.createState(9);
  state.moneyThisRun = 10000;
  state.buildings.lumberjack = 7;
  state.resources.wood = 500;
  const before = engine.globalMult(state);
  const gained = engine.prestige(state);
  assert.ok(gained > 0);
  assert.strictEqual(state.buildings.lumberjack, 0);
  assert.strictEqual(state.resources.wood, 0);
  assert.strictEqual(state.moneyThisRun, 0);
  assert.strictEqual(state.prestige.seeds, gained);
  assert.ok(engine.globalMult(state) > before);
});

test('formatNumber מציג יחידות גדולות בקריאות', () => {
  assert.strictEqual(engine.formatNumber(999), '999');
  assert.ok(engine.formatNumber(1500).endsWith('K'));
  assert.ok(engine.formatNumber(2_500_000).endsWith('M'));
});

test('fastForward (התקדמות אופליין) מייצר תוצאה זהה בסדר גודל לריצת טיקים רגילה', () => {
  const a = engine.createState(10);
  a.buildings = { lumberjack: 5, sawmill: 4, pulpMill: 3, paperPress: 2, salesTeam: 2 };
  const b = engine.createState(10);
  b.buildings = { lumberjack: 5, sawmill: 4, pulpMill: 3, paperPress: 2, salesTeam: 2 };
  for (let i = 0; i < 600; i++) engine.tick(a, 1); // 600 שניות רגילות
  engine.fastForward(b, 600); // אותם 600 שניות בקפיצה
  const diff = Math.abs(a.resources.money - b.resources.money) / Math.max(1, a.resources.money);
  assert.ok(diff < 0.05, 'סטייה גדולה מדי בין ריצה רגילה לקפיצה: ' + diff);
});

console.log('\nסימולציית בוט — כמה שעות משחק');

function pickCheapestAffordable(state) {
  let best = null, bestCost = Infinity;
  for (const key of engine.BUILDING_ORDER) {
    const cost = engine.currentBuildingCost(state, key);
    if (cost <= state.resources.money && cost < bestCost) { best = key; bestCost = cost; }
  }
  const axC = engine.axCost(state);
  if (axC <= state.resources.money && axC < bestCost) { best = 'ax'; bestCost = axC; }
  return best;
}

function runBotHours(hours) {
  const state = engine.createState(42);
  const totalSeconds = hours * 3600;
  const built = new Set();
  let firstPrestigeAt = null;
  for (let t = 0; t < totalSeconds; t++) {
    engine.tick(state, 1);
    if (t < 90) engine.chopWood(state); // דחיפת התחלה ידנית, כמו שחקן אמיתי היה עושה
    let guard = 0;
    while (guard++ < 20) {
      const choice = pickCheapestAffordable(state);
      if (!choice) break;
      if (choice === 'ax') engine.buyAx(state); else { engine.buyBuilding(state, choice); built.add(choice); }
    }
    for (const k in state.resources) {
      if (!Number.isFinite(state.resources[k])) throw new Error(`${k} not finite at t=${t}`);
      if (state.resources[k] < -1e-6) throw new Error(`${k} negative at t=${t}: ${state.resources[k]}`);
    }
    if (firstPrestigeAt === null && engine.seedsAvailable(state) >= 1) firstPrestigeAt = t;
  }
  return { state, built, firstPrestigeAt };
}

const { state: finalState, built, firstPrestigeAt } = runBotHours(4);
console.log('  אחרי 4 שעות סימולציה: כסף =', engine.formatNumber(finalState.resources.money),
  '| הורווח בסבב =', engine.formatNumber(finalState.moneyThisRun),
  '| נייר =', engine.formatNumber(finalState.resources.paper),
  '| בניינים =', JSON.stringify(finalState.buildings),
  '| פריסטייג׳ ראשון אפשרי אחרי', firstPrestigeAt, 'שניות (' + (firstPrestigeAt ? (firstPrestigeAt / 60).toFixed(1) : '—') + ' דקות)');

test('כל סוגי הבניינים בשרשרת נבנים בפועל (אין צוואר בקבוק שחוסם קניה)', () => {
  for (const key of engine.BUILDING_ORDER) {
    assert.ok(built.has(key), `${key} מעולם לא נקנה — כנראה צוואר בקבוק`);
  }
});

test('פריסטייג׳ ראשון אפשרי תוך פחות משעה של משחק', () => {
  assert.ok(firstPrestigeAt !== null && firstPrestigeAt < 3600,
    'פריסטייג׳ ראשון לקח יותר מדי זמן: ' + firstPrestigeAt);
});

test('פריסטייג׳ בפועל בסוף הסימולציה נותן זרעים ומאפס נכון', () => {
  const seedsBefore = finalState.prestige.seeds;
  const gained = engine.prestige(finalState);
  assert.ok(gained > 0);
  assert.strictEqual(finalState.prestige.seeds, seedsBefore + gained);
  assert.strictEqual(finalState.resources.money, 0);
  assert.strictEqual(finalState.buildings.lumberjack, 0);
});

console.log(`\n${passed} בדיקות עברו.`);
if (process.exitCode) {
  console.error('יש בדיקות שנכשלו.');
} else {
  console.log('הכול תקין.');
}
