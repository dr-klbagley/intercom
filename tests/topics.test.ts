import { describe, expect, it } from 'vitest';
import { classify, isQuestion, isReply } from '../src/topics.js';

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

describe('replies and follow-ups', () => {
  it('treats replies and sign-offs as needing no lookup', () => {
    for (const q of ["Let's have the demo take priority. Thanks, Jarvis.", 'No, thanks.', 'Okay, that\'s everything for today.', 'Perfect.', 'Yes please.']) {
      expect(isReply(q), q).toBe(true);
    }
  });
  it('still treats questions as questions', () => {
    for (const q of ['Okay, what about Thursday?', 'No, is there anything from Brent?', 'And tomorrow?', 'What does tomorrow look like?']) {
      expect(isReply(q), q).toBe(false);
    }
    expect(isQuestion('And Thursday?')).toBe(true);
    expect(isQuestion("Let's go with the demo.")).toBe(false);
  });
});
