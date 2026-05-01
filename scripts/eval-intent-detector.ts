import { IntentDetector } from '../core/intent-detector';

const detector = new IntentDetector();

const cases: Array<{
  message: string;
  expected: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}> = [
  { message: 'Search who is the current vice president of India', expected: 'WEB_SEARCH' },
  { message: 'Who is the current vice president of India?', expected: 'WEB_SEARCH' },
  { message: 'Explain who the vice president of India is and what the role does', expected: 'EXPLANATION' },
  { message: 'Generate an image of a tiger in the rain', expected: 'IMAGE_GENERATION' },
  { message: 'Can you show me an image of Mars at sunset', expected: 'IMAGE_GENERATION' },
  { message: 'Write a Python function to reverse a linked list', expected: 'CODE_GENERATION' },
  { message: 'Build a React component for a pricing card', expected: 'CODE_GENERATION' },
  { message: 'Translate hello to Spanish', expected: 'TRANSLATION' },
  { message: 'Analyze the sentiment of this review: the product is decent but overpriced', expected: 'SENTIMENT_ANALYSIS' },
  { message: 'Fix the grammar in this sentence: he go to school yesterday', expected: 'GRAMMAR_CHECK' },
  { message: 'Create a quiz on world war 2', expected: 'QUIZ_GENERATION' },
  { message: 'Give me a recipe with paneer and rice', expected: 'RECIPE' },
  { message: 'Tell me a joke about programmers', expected: 'JOKE' },
  { message: 'Define serendipity', expected: 'DICTIONARY' },
  { message: 'Fact-check this claim: humans use only 10% of their brains', expected: 'FACT_CHECK' },
  { message: 'Hi there', expected: 'CHAT' },
  {
    message: 'What about his role?',
    expected: 'EXPLANATION',
    history: [
      { role: 'user', content: 'Who is the current vice president of India?' },
      { role: 'assistant', content: 'The vice president of India is Jagdeep Dhankhar.' },
    ],
  },
  { message: 'What is the latest Nvidia stock price?', expected: 'WEB_SEARCH' },
  { message: 'Explain how stock prices are calculated', expected: 'EXPLANATION' },
  { message: 'Is it true that coffee stunts growth?', expected: 'FACT_CHECK' },
];

let correct = 0;

for (const testCase of cases) {
  const result = detector.detect(testCase.message, testCase.history);
  const ok = result.intent === testCase.expected;
  if (ok) {
    correct++;
  }

  console.log(
    JSON.stringify({
      message: testCase.message,
      expected: testCase.expected,
      actual: result.intent,
      confidence: result.confidence,
      reasoning: result.reasoning,
      ok,
    })
  );
}

console.log(
  JSON.stringify({
    summary: {
      correct,
      total: cases.length,
      accuracy: correct / cases.length,
    },
  })
);
