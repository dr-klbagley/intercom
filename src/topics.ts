// Which read-only context a question needs (spec §7, §8).

export type Topic = 'mail' | 'calendar' | 'headlines' | 'briefing';

const RULES: [Topic, RegExp][] = [
  ['mail', /\b(e-?mails?|inbox|mail|messages?|tier\s*(1|2|one|two)|vips?|wrote|written|sent me|replied|reply from|heard from|from (brent|zane|jared))\b/i],
  ['calendar', /\b(calendar|schedule|meetings?|agenda|appointments?|events?|busy|free|availability|today|tonight|tomorrow|this (morning|afternoon|evening|week)|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|what time|when (is|am|do)|conflicts?)\b/i],
  ['headlines', /\b(news|headlines?|stories|articles?|medicaid|health insurance|aca|marketplace|cms)\b/i],
  ['briefing', /\b(briefing|brief me|morning (summary|update)|catch me up|what('s| is) my day)\b/i],
];

export function classify(question: string): Set<Topic> {
  const topics = new Set<Topic>();
  for (const [topic, re] of RULES) if (re.test(question)) topics.add(topic);
  // "Today/tomorrow" alone in a mail question ("emails today") is about the inbox, not the calendar.
  if (topics.has('mail') && topics.has('calendar') && !/\b(calendar|schedule|meetings?|agenda|appointments?|events?|busy|free)\b/i.test(question)) {
    topics.delete('calendar');
  }
  return topics;
}
