import { describe, expect, it } from 'vitest';
import { cleanForSpeech, extractCards, SpeechStream, splitSentences } from '../src/voice.js';

describe('splitSentences', () => {
  it('splits complete sentences and keeps the remainder', () => {
    expect(splitSentences('You have two emails. One is from Brent. The oth')).toEqual({
      sentences: ['You have two emails.', 'One is from Brent.'],
      rest: ' The oth',
    });
  });
  it('does not split on common abbreviations', () => {
    const { sentences } = splitSentences('Dr. Allgood wrote at 9. Mr. Yates too. ');
    expect(sentences).toEqual(['Dr. Allgood wrote at 9.', 'Mr. Yates too.']);
  });
  it('waits for whitespace before treating a period as an end', () => {
    expect(splitSentences('Meeting at 10.30').sentences).toEqual([]);
  });
});

describe('cleanForSpeech', () => {
  it('removes markdown, links and emoji', () => {
    expect(cleanForSpeech('**Brent** sent [the deck](https://x.co/a) 🎉')).toBe('Brent sent the deck');
    expect(cleanForSpeech('See https://example.com/x now')).toBe('See a link now');
  });
  it('speaks email addresses and expands days and months', () => {
    expect(cleanForSpeech('Write blayton@twenty.co')).toBe('Write blayton at twenty dot co');
    expect(cleanForSpeech('Tue, Nov 17 at 10:30:00')).toBe('Tuesday, November 17 at 10:30');
  });
  it('turns & into and and drops list markers', () => {
    expect(cleanForSpeech('- Q&A at noon')).toBe('Q and A at noon');
  });
});

describe('extractCards', () => {
  it('pulls out cards and drops malformed ones', () => {
    const text = 'Two emails.\n```intercom-card\n{"kind":"emails","items":[{"title":"Brent"}]}\n```\n```intercom-card\n{oops\n```';
    const out = extractCards(text);
    expect(out.text).toBe('Two emails.');
    expect(out.cards).toEqual([{ kind: 'emails', items: [{ title: 'Brent' }] }]);
  });
});

describe('SpeechStream', () => {
  it('never speaks card JSON, even when it arrives in pieces', () => {
    const s = new SpeechStream();
    const spoken: string[] = [];
    for (const piece of ['You have ', 'one meeting. ', 'It is at ten.\n``', '`intercom-card\n{"kind":"agenda",', '"items":[{"title":"Board call"}]}\n``', '`\n']) {
      spoken.push(...s.push(piece));
    }
    const end = s.finish();
    spoken.push(...end.sentences);
    expect(spoken).toEqual(['You have one meeting.', 'It is at ten.']);
    expect(end.cards[0]?.items[0]?.title).toBe('Board call');
  });
  it('flushes an unfinished last sentence on finish', () => {
    const s = new SpeechStream();
    expect(s.push('Nothing from tier 1 today')).toEqual([]);
    expect(s.finish().sentences).toEqual(['Nothing from tier 1 today']);
  });
});
