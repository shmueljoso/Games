/*
 * מנוע חבילת משחקי המילים: לוגיקה טהורה, בלי DOM, ניתנת ל-require מ-Node
 * (לבדיקות, ראו test-balance.js) ומ-index.html בדפדפן. כל הפונקציות כאן
 * דטרמיניסטיות ביחס לזרע (seed) שמקבלות, כדי שהאתגר היומי יהיה זהה לכל
 * השחקנים וניתן לבדיקה חוזרת.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WordGamesEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FINAL_MAP = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
  var UNFINAL_MAP = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
  var BASE_LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת'.split('');

  function toFinal(ch) { return FINAL_MAP[ch] || ch; }
  function toBase(ch) { return UNFINAL_MAP[ch] || ch; }

  function finalizeWord(word) {
    if (!word) return word;
    var chars = word.split('');
    var last = chars.length - 1;
    chars[last] = toFinal(chars[last]);
    return chars.join('');
  }

  function baseWord(word) {
    if (!word) return word;
    var chars = word.split('');
    for (var i = 0; i < chars.length; i++) chars[i] = toBase(chars[i]);
    return chars.join('');
  }

  // ---- Seeded PRNG (mulberry32) — deterministic, fast, good enough for game use. ----
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStringToSeed(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function dateSeedString(date) {
    // date: Date object (uses UTC to keep the puzzle identical worldwide).
    var y = date.getUTCFullYear();
    var m = String(date.getUTCMonth() + 1).padStart(2, '0');
    var d = String(date.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function dailyIndex(dateStr, poolSize, salt) {
    if (poolSize <= 0) return 0;
    var seed = hashStringToSeed(dateStr + '|' + (salt || ''));
    var rnd = mulberry32(seed);
    return Math.floor(rnd() * poolSize);
  }

  // ---- Trie ----
  function createTrie(words) {
    var root = Object.create(null);
    for (var i = 0; i < words.length; i++) {
      var node = root;
      var w = words[i];
      for (var j = 0; j < w.length; j++) {
        var ch = w[j];
        node = node[ch] || (node[ch] = Object.create(null));
      }
      node.$ = true;
    }
    return {
      has: function (word) {
        var node = root;
        for (var i = 0; i < word.length; i++) {
          node = node[word[i]];
          if (!node) return false;
        }
        return node.$ === true;
      },
      hasPrefix: function (prefix) {
        var node = root;
        for (var i = 0; i < prefix.length; i++) {
          node = node[prefix[i]];
          if (!node) return false;
        }
        return true;
      },
      root: root
    };
  }

  // ---- Engine bundle: build once from dict.js data ----
  function buildEngine(dict) {
    var validationWords = dict.validationWords;
    var trie = createTrie(validationWords);

    var byLength = new Map();
    for (var i = 0; i < validationWords.length; i++) {
      var w = validationWords[i];
      var arr = byLength.get(w.length);
      if (!arr) byLength.set(w.length, arr = []);
      arr.push(w);
    }
    var setByLength = new Map();
    byLength.forEach(function (arr, len) { setByLength.set(len, new Set(arr)); });

    // Anagram index (sorted-letters key -> list of real words with that multiset)
    // is the slowest piece to build (sorts every word) and only Anagram mode
    // needs it, so it is built lazily on first access.
    var anagramIndexCache = null;
    function getAnagramIndex() {
      if (anagramIndexCache) return anagramIndexCache;
      anagramIndexCache = new Map();
      for (var i2 = 0; i2 < validationWords.length; i2++) {
        var w2 = validationWords[i2];
        var key = w2.split('').sort().join('');
        var list = anagramIndexCache.get(key);
        if (!list) anagramIndexCache.set(key, list = []);
        list.push(w2);
      }
      return anagramIndexCache;
    }

    // Letter frequency (base letters only, for Boggle board generation), from
    // short-to-medium words so the distribution favors playable boards.
    var freq = Object.create(null);
    BASE_LETTERS.forEach(function (ch) { freq[ch] = 1; }); // smoothing so every letter can appear
    (byLength.get(3) || []).concat(byLength.get(4) || [], byLength.get(5) || []).forEach(function (w) {
      for (var k = 0; k < w.length; k++) {
        var ch = toBase(w[k]);
        freq[ch] = (freq[ch] || 0) + 1;
      }
    });
    var freqTotal = 0;
    var freqTable = BASE_LETTERS.map(function (ch) { freqTotal += freq[ch]; return [ch, freq[ch]]; });

    var answerPools = dict.answerPools;

    return {
      trie: trie,
      validationWords: validationWords,
      byLength: byLength,
      setByLength: setByLength,
      getAnagramIndex: getAnagramIndex,
      answerPools: answerPools,
      letterFreqTable: freqTable,
      letterFreqTotal: freqTotal
    };
  }

  // ================= וורדעברי (Wordle) =================

  function pickDailyWord(engine, length, dateStr) {
    var pool = engine.answerPools[length];
    if (!pool || pool.length === 0) throw new Error('No answer pool for length ' + length);
    var idx = dailyIndex(dateStr, pool.length, 'wordle-' + length);
    return pool[idx];
  }

  // Classic two-pass Wordle evaluation, correct with duplicate letters.
  function evaluateGuess(guess, answer) {
    var n = answer.length;
    var result = new Array(n).fill('absent');
    var answerChars = answer.split('');
    var guessChars = guess.split('');
    var used = new Array(n).fill(false);

    for (var i = 0; i < n; i++) {
      if (guessChars[i] === answerChars[i]) {
        result[i] = 'correct';
        used[i] = true;
        answerChars[i] = null;
      }
    }
    for (var j = 0; j < n; j++) {
      if (result[j] === 'correct') continue;
      var g = guessChars[j];
      var foundAt = -1;
      for (var k = 0; k < n; k++) {
        if (!used[k] && answerChars[k] === g) { foundAt = k; break; }
      }
      if (foundAt !== -1) {
        result[j] = 'present';
        used[foundAt] = true;
        answerChars[foundAt] = null;
      }
    }
    return result;
  }

  function isValidWordleGuess(engine, guess) {
    return guess.length > 0 && (engine.setByLength.get(guess.length) || new Set()).has(guess);
  }

  // ================= שרשרת מילים (Word Ladder) =================

  function neighborsOf(engine, word) {
    var set = engine.setByLength.get(word.length);
    if (!set) return [];
    var out = [];
    var chars = word.split('');
    for (var i = 0; i < chars.length; i++) {
      var original = chars[i];
      var candidates = i === chars.length - 1
        ? BASE_LETTERS.concat(Object.values(FINAL_MAP))
        : BASE_LETTERS;
      for (var c = 0; c < candidates.length; c++) {
        var ch = candidates[c];
        if (ch === original) continue;
        chars[i] = ch;
        var candidate = chars.join('');
        if (set.has(candidate)) out.push(candidate);
      }
      chars[i] = original;
    }
    return out;
  }

  function solveLadder(engine, start, end, maxDepth) {
    if (start === end) return [start];
    maxDepth = maxDepth || 10;
    var visited = new Set([start]);
    var queue = [[start]];
    var head = 0;
    while (head < queue.length) {
      var path = queue[head++];
      if (path.length > maxDepth) continue;
      var last = path[path.length - 1];
      var neighbors = neighborsOf(engine, last);
      for (var i = 0; i < neighbors.length; i++) {
        var next = neighbors[i];
        if (visited.has(next)) continue;
        var newPath = path.concat([next]);
        if (next === end) return newPath;
        visited.add(next);
        queue.push(newPath);
      }
    }
    return null;
  }

  // Deterministic puzzle generator: try common-word pairs of the given length
  // (from the answer pool) until one has a solvable ladder within
  // [minSteps, maxSteps] moves, walking the RNG forward on each miss.
  function generateLadderPuzzle(engine, length, seed, minSteps, maxSteps) {
    minSteps = minSteps || 2;
    maxSteps = maxSteps || 5;
    var pool = (engine.answerPools[length] || []).filter(function (w) {
      return (engine.setByLength.get(length) || new Set()).has(w);
    });
    if (pool.length < 2) return null;
    var rnd = mulberry32(seed);
    for (var attempt = 0; attempt < 200; attempt++) {
      var a = pool[Math.floor(rnd() * pool.length)];
      var b = pool[Math.floor(rnd() * pool.length)];
      if (a === b) continue;
      var path = solveLadder(engine, a, b, maxSteps);
      if (path && path.length - 1 >= minSteps && path.length - 1 <= maxSteps) {
        return { start: a, end: b, solution: path, steps: path.length - 1 };
      }
    }
    return null;
  }

  function isOneLetterDiff(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff === 1;
  }

  function validateLadderStep(engine, prevWord, nextWord, usedSet) {
    if (!isOneLetterDiff(prevWord, nextWord)) return { ok: false, reason: 'not-one-letter' };
    if (!engine.trie.has(nextWord)) return { ok: false, reason: 'not-a-word' };
    if (usedSet && usedSet.has(nextWord)) return { ok: false, reason: 'already-used' };
    return { ok: true };
  }

  // ================= פיצוח אותיות (Boggle) =================

  function weightedPick(rnd, table, total) {
    var r = rnd() * total;
    for (var i = 0; i < table.length; i++) {
      r -= table[i][1];
      if (r <= 0) return table[i][0];
    }
    return table[table.length - 1][0];
  }

  function generateBoardLetters(engine, size, seed) {
    var rnd = mulberry32(seed);
    var letters = [];
    for (var i = 0; i < size * size; i++) {
      letters.push(weightedPick(rnd, engine.letterFreqTable, engine.letterFreqTotal));
    }
    return letters;
  }

  function neighborCells(idx, size) {
    var r = Math.floor(idx / size), c = idx % size;
    var out = [];
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        var nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < size && nc >= 0 && nc < size) out.push(nr * size + nc);
      }
    }
    return out;
  }

  function solveBoard(engine, letters, size, minLen) {
    minLen = minLen || 3;
    var found = new Map(); // word -> one path (array of indices)
    var n = letters.length;
    var adjacency = [];
    for (var i = 0; i < n; i++) adjacency.push(neighborCells(i, size));

    function dfs(idx, visited, pathStr, pathIdx) {
      var baseStr = pathStr + letters[idx];
      if (!engine.trie.hasPrefix(baseStr) && !engine.trie.hasPrefix(finalizeWord(baseStr))) {
        // Neither the raw form nor a final-letter-ending form can lead anywhere further;
        // still fall through to a final-word check below in case this exact cell IS the end.
      }
      var candidatePlain = baseStr;
      var candidateFinal = finalizeWord(baseStr);
      var newPathIdx = pathIdx.concat([idx]);

      if (candidatePlain.length >= minLen && engine.trie.has(candidatePlain) && !found.has(candidatePlain)) {
        found.set(candidatePlain, newPathIdx);
      }
      if (candidateFinal !== candidatePlain && candidateFinal.length >= minLen && engine.trie.has(candidateFinal) && !found.has(candidateFinal)) {
        found.set(candidateFinal, newPathIdx);
      }

      if (baseStr.length >= 9) return; // sane cap, matches dictionary's max useful length
      var canExtendPlain = engine.trie.hasPrefix(baseStr);
      if (!canExtendPlain) return;

      var neighbors = adjacency[idx];
      var newVisited = visited | (1 << idx);
      for (var k = 0; k < neighbors.length; k++) {
        var nb = neighbors[k];
        if (newVisited & (1 << nb)) continue;
        dfs(nb, newVisited, baseStr, newPathIdx);
      }
    }

    for (var start = 0; start < n; start++) {
      dfs(start, 0, '', []);
    }
    return found;
  }

  function scoreWord(word) {
    var len = word.length;
    if (len <= 4) return 1;
    if (len === 5) return 2;
    if (len === 6) return 3;
    if (len === 7) return 5;
    return 11;
  }

  function generateBoggleBoard(engine, size, seed, minWords) {
    minWords = minWords || 20;
    var best = null;
    for (var attempt = 0; attempt < 12; attempt++) {
      var letters = generateBoardLetters(engine, size, seed + attempt * 7919);
      var found = solveBoard(engine, letters, size, 3);
      if (!best || found.size > best.found.size) best = { letters: letters, found: found, seed: seed + attempt * 7919 };
      if (found.size >= minWords) break;
    }
    return best;
  }

  // ================= אנגרם בזק (Anagram Blitz) =================

  function shuffleLetters(word, seed) {
    var rnd = mulberry32(seed);
    var arr = word.split('');
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    var shuffled = arr.join('');
    if (shuffled === word && word.length > 1) {
      // guarantee a visibly scrambled puzzle
      return arr[1] + arr[0] + arr.slice(2).join('');
    }
    return shuffled;
  }

  function pickAnagramWord(engine, length, seed) {
    var pool = engine.answerPools[length];
    if (!pool || pool.length === 0) return null;
    var idx = Math.floor(mulberry32(seed)() * pool.length);
    return pool[idx];
  }

  function anagramKey(word) {
    return word.split('').sort().join('');
  }

  function checkAnagramAnswer(engine, scrambledLetters, guess) {
    if (guess.length !== scrambledLetters.length) return false;
    if (anagramKey(guess) !== anagramKey(scrambledLetters)) return false;
    return engine.trie.has(guess);
  }

  function allAnagramsOf(engine, scrambledLetters) {
    return engine.getAnagramIndex().get(anagramKey(scrambledLetters)) || [];
  }

  return {
    // constants / letter helpers
    BASE_LETTERS: BASE_LETTERS,
    toFinal: toFinal,
    toBase: toBase,
    finalizeWord: finalizeWord,
    baseWord: baseWord,
    // rng
    mulberry32: mulberry32,
    hashStringToSeed: hashStringToSeed,
    dateSeedString: dateSeedString,
    dailyIndex: dailyIndex,
    // trie / engine
    createTrie: createTrie,
    buildEngine: buildEngine,
    // wordle
    pickDailyWord: pickDailyWord,
    evaluateGuess: evaluateGuess,
    isValidWordleGuess: isValidWordleGuess,
    // ladder
    neighborsOf: neighborsOf,
    solveLadder: solveLadder,
    generateLadderPuzzle: generateLadderPuzzle,
    isOneLetterDiff: isOneLetterDiff,
    validateLadderStep: validateLadderStep,
    // boggle
    generateBoardLetters: generateBoardLetters,
    solveBoard: solveBoard,
    scoreWord: scoreWord,
    generateBoggleBoard: generateBoggleBoard,
    neighborCells: neighborCells,
    // anagram
    shuffleLetters: shuffleLetters,
    pickAnagramWord: pickAnagramWord,
    checkAnagramAnswer: checkAnagramAnswer,
    allAnagramsOf: allAnagramsOf,
    anagramKey: anagramKey
  };
}));
