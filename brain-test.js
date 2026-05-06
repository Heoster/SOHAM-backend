const { getIntentDetector } = require('./dist/core/intent-detector.js');
const { detectToolIntent } = require('./dist/tools/agent-tools.js');
const d = getIntentDetector();

const tests = [
  // AMBIGUOUS / BORDERLINE
  { q: 'who is the PM', expect: 'WEB_SEARCH', cat: 'ambiguous' },
  { q: 'PM kya kar raha hai', expect: 'WEB_SEARCH', cat: 'ambiguous' },
  { q: 'tell me something interesting', expect: 'CHAT', cat: 'ambiguous' },
  { q: 'what is AI', expect: 'EXPLANATION', cat: 'ambiguous' },
  { q: 'what is the latest AI model', expect: 'WEB_SEARCH', cat: 'ambiguous' },
  { q: 'is python good', expect: 'EXPLANATION', cat: 'ambiguous' },
  { q: 'is python still popular', expect: 'WEB_SEARCH', cat: 'ambiguous' },

  // MULTI-INTENT
  { q: 'translate this to hindi and check grammar', expect: 'TRANSLATION', cat: 'multi' },
  { q: 'search for python tutorials and explain them', expect: 'WEB_SEARCH', cat: 'multi' },
  { q: 'write a joke about the latest news', expect: 'JOKE', cat: 'multi' },
  { q: 'what is the weather and news today', expect: 'WEB_SEARCH', cat: 'multi' },

  // TYPOS / BROKEN ENGLISH
  { q: 'waht happend in wrold today', expect: 'WEB_SEARCH', cat: 'typo' },
  { q: 'newss today plz', expect: 'WEB_SEARCH', cat: 'typo' },
  { q: 'wether in delhi', expect: 'WEB_SEARCH', cat: 'typo' },
  { q: 'btcoin prise', expect: 'WEB_SEARCH', cat: 'typo' },
  { q: 'tranlsate hello to spanish', expect: 'TRANSLATION', cat: 'typo' },

  // VERY SHORT / VAGUE
  { q: 'news', expect: 'WEB_SEARCH', cat: 'short' },
  { q: 'weather', expect: 'WEB_SEARCH', cat: 'short' },
  { q: 'bitcoin', expect: 'WEB_SEARCH', cat: 'short' },
  { q: 'hi', expect: 'CHAT', cat: 'short' },
  { q: 'ok', expect: 'CHAT', cat: 'short' },
  { q: 'why', expect: 'CHAT', cat: 'short' },
  { q: 'huh', expect: 'CHAT', cat: 'short' },

  // HINGLISH
  { q: 'aaj ka mausam kaisa hai', expect: 'WEB_SEARCH', cat: 'hinglish' },
  { q: 'bitcoin ka price kya hai', expect: 'WEB_SEARCH', cat: 'hinglish' },
  { q: 'mujhe ek joke sunao', expect: 'JOKE', cat: 'hinglish' },
  { q: 'python code likhna sikhao', expect: 'CODE_GENERATION', cat: 'hinglish' },
  { q: 'IPL ka score kya hai', expect: 'WEB_SEARCH', cat: 'hinglish' },
  { q: 'koi acchi recipe batao', expect: 'RECIPE', cat: 'hinglish' },

  // FOLLOW-UP (no history)
  { q: 'and what about yesterday', expect: 'WEB_SEARCH', cat: 'followup' },
  { q: 'more details please', expect: 'CHAT', cat: 'followup' },
  { q: 'why did that happen', expect: 'CHAT', cat: 'followup' },

  // SHOULD NOT trigger web search
  { q: 'explain quantum computing', expect: 'EXPLANATION', cat: 'no-search' },
  { q: 'write a python function to sort a list', expect: 'CODE_GENERATION', cat: 'no-search' },
  { q: 'check my grammar: i goes to school', expect: 'GRAMMAR_CHECK', cat: 'no-search' },
  { q: 'what is the meaning of ephemeral', expect: 'DICTIONARY', cat: 'no-search' },
  { q: 'is it true that the earth is flat', expect: 'FACT_CHECK', cat: 'no-search' },
  { q: 'make a quiz about world war 2', expect: 'QUIZ_GENERATION', cat: 'no-search' },
  { q: 'how to make biryani', expect: 'RECIPE', cat: 'no-search' },
];

let pass = 0, fail = 0;
const failures = [];

tests.forEach(function(t) {
  const r = d.detect(t.q);
  const tool = detectToolIntent(t.q);
  const ok = r.intent === t.expect;
  if (ok) pass++;
  else {
    fail++;
    failures.push({
      cat: t.cat,
      q: t.q,
      exp: t.expect,
      got: r.intent,
      conf: r.confidence.toFixed(2),
      tool: tool ? tool.tool : 'null'
    });
  }
});

console.log('PASS: ' + pass + ' / FAIL: ' + fail + ' / TOTAL: ' + tests.length);
console.log('');

if (failures.length) {
  console.log('FAILURES BY CATEGORY:');
  const cats = {};
  failures.forEach(function(f) {
    if (!cats[f.cat]) cats[f.cat] = [];
    cats[f.cat].push(f);
  });
  Object.keys(cats).forEach(function(cat) {
    console.log('\n  [' + cat + ']');
    cats[cat].forEach(function(f) {
      console.log('    FAIL: "' + f.q + '"');
      console.log('          expected=' + f.exp + '  got=' + f.got + '(' + f.conf + ')  tool=' + f.tool);
    });
  });
}
