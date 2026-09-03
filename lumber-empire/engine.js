/*
 * מנוע המשחק "אימפריית העצים" — מופרד לגמרי מה-DOM כדי שאפשר להריץ אותו
 * ב-Node לבדיקות איזון (ראו test-balance.js), וגם ב-דפדפן דרך <script>.
 *
 * שרשרת ייצור: עצים → קורות (מסור) → עיסת נייר (טחנת עיסה) → נייר (מכבש)
 * → כסף (צוות מכירות). כל שלב הוא "בניין" שאפשר לקנות עוד יחידות ממנו;
 * המחיר עולה גיאומטרית עם הכמות. לחיצה ידנית מוסיפה עצים ישירות, כדי
 * שיהיה מה לעשות גם לפני שיש אוטומציה.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LumberEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BUILDINGS = {
    lumberjack: { name: 'חוטב עצים', baseCost: 15, growth: 1.14, rate: 0.6, produces: 'wood' },
    sawmill: { name: 'מסור', baseCost: 60, growth: 1.15, rate: 0.5, consumes: 'wood', produces: 'planks', ratio: 2 },
    pulpMill: { name: 'טחנת עיסה', baseCost: 300, growth: 1.16, rate: 0.4, consumes: 'planks', produces: 'pulp', ratio: 2 },
    paperPress: { name: 'מכבש נייר', baseCost: 1500, growth: 1.17, rate: 0.32, consumes: 'pulp', produces: 'paper', ratio: 2 },
    salesTeam: { name: 'צוות מכירות', baseCost: 6000, growth: 1.18, rate: 0.25, consumes: 'paper', produces: 'money', ratio: 1, price: 8 },
  };
  const BUILDING_ORDER = ['lumberjack', 'sawmill', 'pulpMill', 'paperPress', 'salesTeam'];

  const AX = { name: 'השחזת גרזן', baseCost: 20, growth: 1.6, powerPerLevel: 1 };
  const BASE_CLICK_POWER = 1;

  const SEEDS_K = 3.2; // כמה זרעי זהב מקבלים ביחס ל-sqrt(הכסף שהורווח מאז הפריסטייג' הקודם)
  const SEEDS_MIN_MONEY = 3000; // מתחת לסכום הזה, פריסטייג' לא נותן שום זרע — כדי שהאיפוס הראשון יהיה החלטה משמעותית, לא רפלקס אחרי כמה שניות
  const SEED_BONUS = 0.02; // כל זרע = 2% תפוקה קבועה לתמיד

  const EVENTS = [
    { type: 'sale', label: 'יום מכירות! מחיר הנייר כפול', duration: 30, multiplier: 2 },
    { type: 'discount', label: 'משלוח מוזל! 20% הנחה על בניינים', duration: 25, multiplier: 0.8 },
  ];
  const EVENT_MIN_GAP = 75, EVENT_MAX_GAP = 160;

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

  function createState(seed) {
    const rng = makeRng(seed == null ? Date.now() : seed);
    return {
      rng,
      resources: { wood: 0, planks: 0, pulp: 0, paper: 0, money: 0 },
      buildings: { lumberjack: 0, sawmill: 0, pulpMill: 0, paperPress: 0, salesTeam: 0 },
      axLevel: 0,
      lifetimeMoney: 0,
      moneyThisRun: 0,
      prestige: { seeds: 0, count: 0 },
      elapsed: 0,
      activeEvent: null,
      nextEventAt: EVENT_MIN_GAP + rng() * (EVENT_MAX_GAP - EVENT_MIN_GAP),
      lastEvents: [],
    };
  }

  function globalMult(state) {
    return 1 + state.prestige.seeds * SEED_BONUS;
  }

  function isEventActive(state, type) {
    return !!(state.activeEvent && state.activeEvent.type === type && state.elapsed < state.activeEvent.endsAt);
  }

  function buildingCost(key, count) {
    const def = BUILDINGS[key];
    return Math.ceil(def.baseCost * Math.pow(def.growth, count));
  }
  function currentBuildingCost(state, key) {
    let cost = buildingCost(key, state.buildings[key]);
    if (isEventActive(state, 'discount')) cost = Math.ceil(cost * state.activeEvent.multiplier);
    return cost;
  }
  function axCost(state) {
    let cost = Math.ceil(AX.baseCost * Math.pow(AX.growth, state.axLevel));
    if (isEventActive(state, 'discount')) cost = Math.ceil(cost * state.activeEvent.multiplier);
    return cost;
  }

  function buyBuilding(state, key) {
    if (!BUILDINGS[key]) return false;
    const cost = currentBuildingCost(state, key);
    if (state.resources.money < cost) return false;
    state.resources.money -= cost;
    state.buildings[key] += 1;
    return true;
  }

  function buyAx(state) {
    const cost = axCost(state);
    if (state.resources.money < cost) return false;
    state.resources.money -= cost;
    state.axLevel += 1;
    return true;
  }

  function clickPower(state) {
    return (BASE_CLICK_POWER + state.axLevel * AX.powerPerLevel) * globalMult(state);
  }

  function chopWood(state) {
    state.resources.wood += clickPower(state);
  }

  // מחיר בסיס לק"ג/יחידה בשוק הפתוח — לא תלוי בשום בניין. בלי זה, לפני
  // שיש "צוות מכירות" (השלב האחרון בשרשרת), שום עץ/קורה/עיסה/נייר לא
  // שווים כלום ואי אפשר בכלל להתחיל לצבור כסף לבניין הראשון. השוליים כאן
  // נמוכים בהרבה ממה שבניין ייעודי נותן — הרעיון הוא שכדאי להקים את
  // השרשרת המלאה, לא לחיות על הטפטוף.
  const MARKET_PRICE = { wood: 0.3, planks: 1, pulp: 3, paper: 8 };
  const MARKET_TRICKLE_RATE = 0.06; // חלק מהמלאי שנמכר "ממילא" בכל שנייה

  function applyMarketTrickle(state, dt) {
    for (const res in MARKET_PRICE) {
      const stock = state.resources[res];
      if (stock <= 0) continue;
      const sold = stock * MARKET_TRICKLE_RATE * dt;
      state.resources[res] -= sold;
      const earned = sold * MARKET_PRICE[res];
      state.resources.money += earned;
      state.lifetimeMoney += earned;
      state.moneyThisRun += earned;
    }
  }

  // כמה זרעי זהב פריסטייג' עכשיו היה נותן, לפי הכסף שהורווח בסבב הנוכחי
  function seedsAvailable(state) {
    if (state.moneyThisRun < SEEDS_MIN_MONEY) return 0;
    return Math.floor(SEEDS_K * Math.sqrt(state.moneyThisRun - SEEDS_MIN_MONEY));
  }

  function prestige(state) {
    const gained = seedsAvailable(state);
    if (gained < 1) return 0;
    state.prestige.seeds += gained;
    state.prestige.count += 1;
    state.resources = { wood: 0, planks: 0, pulp: 0, paper: 0, money: 0 };
    state.buildings = { lumberjack: 0, sawmill: 0, pulpMill: 0, paperPress: 0, salesTeam: 0 };
    state.axLevel = 0;
    state.moneyThisRun = 0;
    return gained;
  }

  function maybeTriggerEvent(state) {
    if (state.activeEvent && state.elapsed >= state.activeEvent.endsAt) {
      state.lastEvents.push({ type: 'eventEnd', eventType: state.activeEvent.type });
      state.activeEvent = null;
    }
    if (!state.activeEvent && state.elapsed >= state.nextEventAt) {
      const pick = EVENTS[Math.floor(state.rng() * EVENTS.length)];
      state.activeEvent = { type: pick.type, label: pick.label, multiplier: pick.multiplier, endsAt: state.elapsed + pick.duration };
      state.nextEventAt = state.elapsed + pick.duration + EVENT_MIN_GAP + state.rng() * (EVENT_MAX_GAP - EVENT_MIN_GAP);
      state.lastEvents.push({ type: 'eventStart', eventType: pick.type, label: pick.label });
    }
  }

  // מריץ שלב אחד בשרשרת: צורך עד קיבולת מהמשאב שלפניו, מייצר את הבא.
  function runStage(state, key, dt, mult) {
    const def = BUILDINGS[key];
    const count = state.buildings[key];
    if (count <= 0) return 0;
    const maxOutput = count * def.rate * mult * dt;
    let output = maxOutput;
    if (def.consumes) {
      const ratio = def.ratio || 1;
      const available = state.resources[def.consumes] / ratio;
      output = Math.min(maxOutput, available);
      state.resources[def.consumes] -= output * ratio;
    }
    if (def.produces === 'money') {
      const price = def.price * (isEventActive(state, 'sale') ? state.activeEvent.multiplier : 1);
      const earned = output * price;
      state.resources.money += earned;
      state.lifetimeMoney += earned;
      state.moneyThisRun += earned;
    } else {
      state.resources[def.produces] += output;
    }
    return output;
  }

  function tick(state, dt) {
    state.lastEvents = [];
    state.elapsed += dt;
    maybeTriggerEvent(state);
    const mult = globalMult(state);
    for (const key of BUILDING_ORDER) runStage(state, key, dt, mult);
    applyMarketTrickle(state, dt);
    return state;
  }

  // מריץ `seconds` שניות בקפיצה אחת (למשל התקדמות אופליין), בצעדים קטנים
  // כדי לשמור על דיוק סביר של הצווארי-בקבוק בשרשרת.
  function fastForward(state, seconds, steps) {
    steps = steps || Math.min(240, Math.max(30, Math.round(seconds / 5)));
    const dt = seconds / steps;
    const before = { money: state.resources.money, paper: state.resources.paper };
    for (let i = 0; i < steps; i++) tick(state, dt);
    return { moneyGained: state.resources.money - before.money, paperGained: state.resources.paper - before.paper };
  }

  function formatNumber(n) {
    if (n < 1000) return Math.floor(n).toString();
    const units = ['K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp'];
    let u = -1;
    while (n >= 1000 && u < units.length - 1) { n /= 1000; u++; }
    return n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0) + units[u];
  }

  return {
    BUILDINGS, BUILDING_ORDER, AX, SEEDS_K, SEED_BONUS,
    createState, tick, fastForward, chopWood, buyBuilding, buyAx,
    currentBuildingCost, axCost, clickPower, globalMult, seedsAvailable, prestige,
    isEventActive, formatNumber, makeRng,
  };
}));
