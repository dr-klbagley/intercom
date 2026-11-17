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

const ASKS = /\?|\b(what|what's|whats|when|where|who|whose|how|which|any|anything|is there|are there|do i|did|does|tell me|check|read|give me|show me|look up|find|the rest|more)\b/i;
const REPLY_START = /^\s*(thanks|thank you|thx|no|nope|nah|okay|ok|got it|great|perfect|sounds good|good|cool|alright|all right|yes|yeah|yep|sure|fine|never ?mind|that's (all|it|everything|fine|good)|let's|lets|go with|we'll|i'll|i will|i've got|bye|goodbye|cheers)\b/i;

/**
 * Replies and sign-offs ("thanks", "no thanks", "let's have the demo take priority"). These need no
 * lookup: Jarvis answers from the conversation, which already holds what was gathered.
 */
export function isReply(question: string): boolean {
  return REPLY_START.test(question) && !ASKS.test(question);
}

/** A question-shaped follow-up ("and Thursday?", "what about after lunch?") that can reuse the last topic. */
export function isQuestion(question: string): boolean {
  return ASKS.test(question);
}
