// Statista "Chart of the Day" topics [label, slug]. The slugs are identifiers
// the worker maps onto Statista's industry taxonomy (it classifies each recent
// chart from its own page and filters by topic); they are no longer Statista
// URL slugs, though each kept its old spelling so saved boards keep working.
// Mirrors CHART_TOPICS in the worker (worker/src/chart.js); keep the two in
// sync. Standalone data module so config.js / setup can validate the topic
// without pulling the chart widget's viewer deps.
export const CHART_TOPICS = [
  ['Artificial Intelligence', 'artificial intelligence'],
  ['Consumer Goods', 'consumer goods'],
  ['E-Commerce', 'e-commerce'],
  ['Economy', 'economy'],
  ['Energy & Environment', 'energy'],
  ['Entertainment', 'entertainment'],
  ['Finance', 'finance'],
  ['Health', 'health'],
  ['Internet', 'internet'],
  ['Media', 'media'],
  ['Retail', 'retail'],
  ['Society', 'society'],
  ['Sports', 'sports'],
  ['Technology', 'technology'],
  ['Transportation', 'transportation'],
  ['Travel', 'travel'],
];

export const CHART_TOPIC_SLUGS = new Set(CHART_TOPICS.map(([, slug]) => slug));

// Saved slugs that now mean another topic: Energy and Environment merged under
// energy.
export const CHART_TOPIC_ALIASES = { environment: 'energy' };

// Topics dropped in the November 2026 change. A saved pick of either falls
// away, and a board that had picked nothing else is left with no topic, the
// newest charts overall (which is how the worker reads these slugs too).
export const CHART_TOPICS_DROPPED = new Set(['business', 'science']);
