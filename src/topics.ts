// Which read-only context a question needs (spec §7, §8).

export type Topic = 'mail' | 'calendar' | 'headlines' | 'briefing' | 'todos' | 'research' | 'linkedin' | 'mindstone' | 'system' | 'web';

const RULES: [Topic, RegExp][] = [
  ['mail', /\b(e-?mails?|inbox|mail|messages?|reply to|respond to|write back|tier\s*(1|2|one|two)|vips?|wrote|written|sent me|replied|reply from|heard from|from (brent|zane|jared))\b/i],
  ['calendar', /\b(calendar|schedule|meetings?|agenda|appointments?|events?|busy|free|availability|today|tonight|tomorrow|this (morning|afternoon|evening|week)|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|what time|when (is|am|do)|conflicts?)\b/i],
  ['headlines', /\b(news|headlines?|stories|articles?|medicaid|health insurance|aca|marketplace|cms)\b/i],
  ['briefing', /\b(briefing|brief me|morning (summary|update)|catch me up|what('s| is) my day)\b/i],
  ['todos', /\b(to-?dos?|to do list|todo list|my list|task list|tasks?|slotherium|on my plate|remind me to|mark (it|that|.{1,40}) (as )?(done|complete))\b/i],
  ['research', /\b(research|fangorn|entmoot|reading list|briefs|research inbox)\b/i],
  ['linkedin', /\b(linked ?in|gandalf|rivendell|posts?|posting|weekly plan|thought leadership)\b/i],
  ['mindstone', /\b(mind ?stone|proposals?|corrections?|my preferences|waiting on me|pending approvals?)\b/i],
  ['system', /\b(mac mini|servers?|system status|dashboard|is everything (up|working|running|ok|okay)|ollama|services? (up|down|running))\b/i],
];

/** Words that really mean the calendar (a weekday or "today" alone may not). */
export const EXPLICIT_CALENDAR = /\b(calendar|schedule|meetings?|agenda|appointments?|events?|busy|free)\b/i;

/** Asking to go to the web ("look it up", "search for…", "online"). */
const WEB_ASK = /\b(search( the web| online| for)?|look (it|that|this)? ?up|google|online|on the (web|internet)|check the (web|internet|news))\b/i;
/** Small talk that needs no search even though no other topic matches. */
const SMALL_TALK = /\b(joke|how are you|who are you|what can you do|your name|good (morning|night|evening)|thank(s| you))\b/i;

/**
 * Whether to search the web: when Kevin asks to, or when a real question matches none of his own sources
 * ("did Maine have a gubernatorial election this month?").
 */
export function wantsWeb(question: string, otherTopics: Set<Topic>): boolean {
  if (WEB_ASK.test(question)) return true;
  return otherTopics.size === 0 && isQuestion(question) && !isReply(question) && !isAction(question) && !SMALL_TALK.test(question);
}

/** The search query: Kevin's own words, minus the wake word and "can you look up". */
export function webQuery(question: string): string {
  return question
    .replace(/^\s*(hey\s+)?(jarvis|j)\b[\s,.:;!-]*/i, '')
    .replace(/^\s*(can|could|would) you\s+/i, '')
    .replace(/^\s*(please\s+)?(search( the web| online)?( for)?|look up|google|find out|check)\s+/i, '')
    .replace(/\b(for me|online|on the web|on the internet)\b/gi, '')
    .replace(/[?.!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classify(question: string): Set<Topic> {
  const topics = new Set<Topic>();
  for (const [topic, re] of RULES) if (re.test(question)) topics.add(topic);
  // A time word alone ("emails today", "my list this week") is about that other topic, not the calendar.
  if (topics.has('calendar') && topics.size > 1 && !EXPLICIT_CALENDAR.test(question)) {
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
const ACTION_WORDS = /\b(add|reply|respond|write back|mark|complete|change|move|push|remind|send|accept|decline|update|rename)\b/i;

export function isReply(question: string): boolean {
  return REPLY_START.test(question) && !ASKS.test(question) && !ACTION_WORDS.test(question);
}

/** An instruction to do something ("push that one to Monday", "mark it done"). */
export function isAction(question: string): boolean {
  return ACTION_WORDS.test(question);
}

/** A question-shaped follow-up ("and Thursday?", "what about after lunch?") that can reuse the last topic. */
export function isQuestion(question: string): boolean {
  return ASKS.test(question);
}
