/*
 * בדיקות Node למנוע חבילת משחקי המילים. בלי DOM, בלי תלות בדפדפן.
 * מריצים: node word-games/test-balance.js
 */
'use strict';
var assert = require('assert');
var dict = require('./dict.js');
var E = require('./engine.js');

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
    process.exitCode = 1;
  }
}

console.log('בונה מנוע מהמילון...');
var engine = E.buildEngine(dict);
console.log('מילות אימות:', engine.validationWords.length);

// ---------------- Trie ----------------
test('Trie מזהה מילה קיימת עם אות סופית', function () {
  assert.strictEqual(engine.trie.has('שולחן'), true);
  assert.strictEqual(engine.trie.has('שולחנ'), false); // non-final נ at the end is wrong
});
test('Trie דוחה מילה לא קיימת', function () {
  assert.strictEqual(engine.trie.has('קשגכגכ'), false);
});
test('Trie hasPrefix עובד על תחילית אמיתית', function () {
  assert.strictEqual(engine.trie.hasPrefix('שול'), true);
  assert.strictEqual(engine.trie.hasPrefix('קגכ'), false);
});

// ---------------- וורדעברי ----------------
test('pickDailyWord דטרמיניסטי לאותו תאריך', function () {
  var w1 = E.pickDailyWord(engine, 5, '2026-09-03');
  var w2 = E.pickDailyWord(engine, 5, '2026-09-03');
  assert.strictEqual(w1, w2);
  assert.strictEqual(w1.length, 5);
});
test('pickDailyWord משתנה בין תאריכים (סבירות גבוהה)', function () {
  var seen = new Set();
  for (var d = 1; d <= 30; d++) {
    var ds = '2026-01-' + String(d).padStart(2, '0');
    seen.add(E.pickDailyWord(engine, 5, ds));
  }
  assert.ok(seen.size >= 20, 'מצפים למגוון גבוה על פני 30 ימים, קיבלנו ' + seen.size);
});
test('evaluateGuess: התאמה מלאה', function () {
  var res = E.evaluateGuess('שולחן', 'שולחן');
  assert.deepStrictEqual(res, ['correct', 'correct', 'correct', 'correct', 'correct']);
});
test('evaluateGuess: אותיות כפולות בניחוש, בודדת בתשובה', function () {
  // תשובה עם אות אחת מסוג X, ניחוש עם שתיים — רק אחת צריכה present/correct, השנייה absent.
  var res = E.evaluateGuess('בבקשה', 'קשקשת'); // ב,ב,ק,ש,ה vs ק,ש,ק,ש,ת
  // מוודאים שאין יותר "present"/"correct" למכתב מסוים ממספר המופעים שלו בתשובה.
  var answerCounts = {};
  'קשקשת'.split('').forEach(function (c) { answerCounts[c] = (answerCounts[c] || 0) + 1; });
  var guessLetters = 'בבקשה'.split('');
  var matchedCounts = {};
  res.forEach(function (status, i) {
    if (status !== 'absent') {
      var c = guessLetters[i];
      matchedCounts[c] = (matchedCounts[c] || 0) + 1;
    }
  });
  Object.keys(matchedCounts).forEach(function (c) {
    assert.ok(matchedCounts[c] <= (answerCounts[c] || 0), 'לא ניתן לסמן ' + c + ' יותר פעמים ממספר המופעים שלו בתשובה');
  });
});
test('isValidWordleGuess מקבל מילה אמיתית ודוחה חסרת משמעות', function () {
  assert.strictEqual(E.isValidWordleGuess(engine, 'שולחן'), true);
  assert.strictEqual(E.isValidWordleGuess(engine, 'קגכטז'), false);
});
test('כל מילות המאגר היומי (5,6,7) קיימות במילון האימות', function () {
  [5, 6, 7].forEach(function (len) {
    engine.answerPools[len].forEach(function (w) {
      assert.ok(engine.trie.has(w), w + ' (אורך ' + len + ') לא נמצאה במילון האימות');
    });
  });
});

// ---------------- שרשרת מילים ----------------
test('neighborsOf מוצא שכנים אמיתיים באורך זהה', function () {
  var neighbors = E.neighborsOf(engine, 'חתול');
  neighbors.forEach(function (n) {
    assert.strictEqual(n.length, 'חתול'.length);
    assert.strictEqual(E.isOneLetterDiff(n, 'חתול'), true);
    assert.strictEqual(engine.trie.has(n), true);
  });
});
test('solveLadder פותר שרשרת פשוטה (מילה לעצמה)', function () {
  var path = E.solveLadder(engine, 'חתול', 'חתול');
  assert.deepStrictEqual(path, ['חתול']);
});
test('validateLadderStep מזהה שינוי לא-חוקי', function () {
  assert.strictEqual(E.validateLadderStep(engine, 'חתול', 'חתולים').ok, false); // אורך שונה
  assert.strictEqual(E.validateLadderStep(engine, 'חתול', 'קגכט').ok, false); // לא מילה
});
test('generateLadderPuzzle מייצר חידות פתירות לכמה אורכים וזרעים', function () {
  var successes = 0, attempts = 0;
  [4, 5].forEach(function (len) {
    for (var seed = 0; seed < 15; seed++) {
      attempts++;
      var puzzle = E.generateLadderPuzzle(engine, len, seed, 2, 6);
      if (puzzle) {
        successes++;
        assert.strictEqual(puzzle.solution[0], puzzle.start);
        assert.strictEqual(puzzle.solution[puzzle.solution.length - 1], puzzle.end);
        for (var i = 1; i < puzzle.solution.length; i++) {
          assert.strictEqual(E.isOneLetterDiff(puzzle.solution[i - 1], puzzle.solution[i]), true);
          assert.strictEqual(engine.trie.has(puzzle.solution[i]), true);
        }
      }
    }
  });
  assert.ok(successes / attempts > 0.5, 'רוב הזרעים צריכים להצליח, הצלחה: ' + successes + '/' + attempts);
});

// ---------------- פיצוח אותיות ----------------
test('generateBoggleBoard מייצר לוח עם מספיק מילים', function () {
  for (var seed = 0; seed < 5; seed++) {
    var board = E.generateBoggleBoard(engine, 4, seed * 1000 + 1, 15);
    assert.ok(board.found.size >= 10, 'לוח ' + seed + ' מצא רק ' + board.found.size + ' מילים');
  }
});
test('מילים שנמצאו בלוח תקינות (טרי + נתיב שכנים חוקי)', function () {
  var board = E.generateBoggleBoard(engine, 4, 42, 15);
  var checked = 0;
  board.found.forEach(function (path, word) {
    checked++;
    assert.ok(engine.trie.has(word) || engine.trie.has(word), 'המילה ' + word + ' לא במילון');
    // path cells must be adjacent consecutively and unique
    var seen = new Set();
    for (var i = 0; i < path.length; i++) {
      assert.strictEqual(seen.has(path[i]), false, 'תא ' + path[i] + ' נעשה בו שימוש כפול');
      seen.add(path[i]);
      if (i > 0) {
        var neighbors = E.neighborCells(path[i - 1], 4);
        assert.ok(neighbors.indexOf(path[i]) !== -1, 'תא ' + path[i] + ' לא שכן של ' + path[i - 1]);
      }
    }
  });
  assert.ok(checked > 10);
});
test('scoreWord נותן ניקוד עולה עם האורך', function () {
  assert.ok(E.scoreWord('אבג') <= E.scoreWord('אבגדה'));
  assert.ok(E.scoreWord('אבגדה') <= E.scoreWord('אבגדהו'));
  assert.ok(E.scoreWord('אבגדהו') <= E.scoreWord('אבגדהוז'));
});

// ---------------- אנגרם בזק ----------------
test('shuffleLetters תמיד מערבב בפועל (למילים של יותר מאות אחת)', function () {
  for (var seed = 0; seed < 25; seed++) {
    var shuffled = E.shuffleLetters('שולחן', seed);
    assert.strictEqual(E.anagramKey(shuffled), E.anagramKey('שולחן'));
    assert.notStrictEqual(shuffled, 'שולחן');
  }
});
test('checkAnagramAnswer מקבל את המילה המקורית', function () {
  var word = E.pickAnagramWord(engine, 5, 7);
  var scrambled = E.shuffleLetters(word, 7);
  assert.strictEqual(E.checkAnagramAnswer(engine, scrambled, word), true);
});
test('checkAnagramAnswer דוחה מילה עם אותיות לא תואמות', function () {
  var scrambled = E.shuffleLetters('שולחן', 3);
  assert.strictEqual(E.checkAnagramAnswer(engine, scrambled, 'מנעול'), false);
});
test('allAnagramsOf מוצא לפחות את המילה המקורית', function () {
  var word = E.pickAnagramWord(engine, 4, 11);
  var scrambled = E.shuffleLetters(word, 11);
  var options = E.allAnagramsOf(engine, scrambled);
  assert.ok(options.indexOf(word) !== -1);
});
test('pickAnagramWord דטרמיניסטי ותקין לכל האורכים הזמינים', function () {
  Object.keys(engine.answerPools).forEach(function (len) {
    len = Number(len);
    if (len < 3) return; // קצר מדי בשביל אנגרם משמעותי
    var w1 = E.pickAnagramWord(engine, len, 99);
    var w2 = E.pickAnagramWord(engine, len, 99);
    assert.strictEqual(w1, w2);
    assert.strictEqual(w1.length, len);
  });
});

console.log('');
console.log(passed + ' בדיקות עברו.');
if (process.exitCode) {
  console.log('יש כשלים למעלה.');
} else {
  console.log('הכול תקין.');
}
