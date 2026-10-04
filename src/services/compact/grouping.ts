// ── Message Grouping (CC grouping.ts adapted for TriRLC) ──
// Groups messages at conversation-turn boundaries: one group per user-assistant exchange.
// Adapted from CC groupMessagesByApiRound for TriRLC's simpler Message structure.

export interface TriRLCMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function groupMessagesByTurn(messages: TriRLCMessage[]): TriRLCMessage[][] {
  const groups: TriRLCMessage[][] = [];
  let current: TriRLCMessage[] = [];

  for (const msg of messages) {
    // Start new group when hitting a user message after an assistant
    if (msg.role === 'user' && current.length > 0 && current.some(m => m.role === 'assistant')) {
      groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

// Rough token estimation (4 chars ≈ 1 token)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(messages: TriRLCMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}
