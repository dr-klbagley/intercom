import { describe, expect, it } from 'vitest';
import { classify } from '../src/topics.js';

const t = (q: string) => [...classify(q)].sort();

describe('classify', () => {
  it('routes Kevin\'s example questions', () => {
    expect(t('Hey J, have I got any emails from tier 1 senders today?')).toEqual(['mail']);
    expect(t('Jarvis, what does my calendar look like tomorrow?')).toEqual(['calendar']);
    expect(t("What's in the headlines?")).toEqual(['headlines']);
    expect(t('Give me the briefing')).toEqual(['briefing']);
  });
  it('keeps both when the question really is about both', () => {
    expect(t('Did Brent email about the meeting on my calendar Thursday?')).toEqual(['calendar', 'mail']);
  });
  it('returns nothing for general questions', () => {
    expect(t('Tell me a joke')).toEqual([]);
  });
});
