import type { ChatMessage } from '../api/types';

export const MESSAGE_WINDOW_COUNT = 200;
export const MESSAGE_WINDOW_CHARS = 2 * 1024 * 1024;
export interface MessagePage { messages: ChatMessage[]; hasMoreBefore: boolean; beforeCursor?: string }
export interface MessageWindow { history: boolean; loading: boolean; tail: MessagePage }

export const activeMessage = (message: ChatMessage) => message.status === 'streaming' || message.parts.some(part => part.kind === 'tool' && ['pending', 'awaiting_approval', 'reviewing', 'running'].includes(part.call.status));
const sizes = new WeakMap<ChatMessage, number>();
const size = (message: ChatMessage) => {
  let length = sizes.get(message);
  if (length === undefined) { length = JSON.stringify(message).length + 1; sizes.set(message, length); }
  return length;
};

/** Keep a continuous tail. The latest whole message and live in-flight messages are explicit exceptions. */
export function boundMessages(page: MessagePage, live = false): MessagePage {
  let start = page.messages.length, chars = 2;
  while (start > 0) {
    const length = size(page.messages[start - 1]!);
    if (start < page.messages.length && (page.messages.length - start >= MESSAGE_WINDOW_COUNT || chars + length > MESSAGE_WINDOW_CHARS)) break;
    chars += length; start--;
  }
  if (!start) return page;
  const tail = page.messages.slice(start);
  const messages = live ? [...page.messages.slice(0, start).filter(activeMessage), ...tail] : tail;
  // Pinned live rows can precede a gap; the continuous tail is the history anchor.
  // Persisted rows are projected as done; stream/error/cancel projections need not be stored.
  const anchor = live ? tail.find(message => message.status === 'done') : tail[0];
  return { messages, hasMoreBefore: true, beforeCursor: anchor ? `message:${anchor.id}` : undefined };
}

export function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex(row => row.id === message.id);
  return index < 0 ? [...messages, message] : messages.map((row, i) => i === index ? message : row);
}
