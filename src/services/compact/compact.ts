// ── Compact Service (CC compact.ts adapted for TriRLC) ──
// Core conversation compaction using Anthropic API.
// A-level core copy: prompt generation + API call + summary formatting.
// Shim dependencies: removed PTL retry, skill reinjection, hooks (TriRLC lacks these).

import type { TriRLCMessage } from './grouping.js';
import { getCompactPrompt, formatCompactSummary, getCompactUserSummaryMessage } from './prompt.js';
import { estimateMessageTokens } from './grouping.js';

const COMPACT_API = 'http://localhost:8711/v1/messages';
const COMPACT_MODEL = 'tmv-deepseek-v4-flash';
const MAX_COMPACT_TOKENS = 8192;

export interface CompactResult {
  summary: string;
  message: string;
  tokensRemoved: number;
}

const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES = 'Not enough messages to compact.';
const ERROR_MESSAGE_USER_ABORT = 'Compaction interrupted — please try again.';
const ERROR_MESSAGE_INCOMPLETE_RESPONSE = 'Compaction incomplete — network issue?';

/**
 * Core compact function: sends conversation to Anthropic API for summarization.
 * Adapted from CC compactConversation() with TriRLC message structure.
 */
export async function compactConversation(
  messages: TriRLCMessage[],
  customInstructions?: string,
): Promise<CompactResult> {
  if (messages.length < 3) {
    throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
  }

  const prompt = getCompactPrompt(customInstructions);

  // Build API messages: system prompt + conversation history
  const apiMessages: Array<{ role: string; content: string }> = [
    { role: 'user', content: prompt + '\n\n---\n\nConversation to summarize:\n\n' },
  ];

  // Append conversation messages
  for (const msg of messages) {
    apiMessages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  // Estimate input tokens before API call
  const estimatedInputTokens = estimateMessageTokens(messages);

  try {
    const response = await fetch(COMPACT_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: COMPACT_MODEL,
        max_tokens: MAX_COMPACT_TOKENS,
        messages: apiMessages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as { content?: Array<{ type: string; text: string }> };

    if (!data.content || data.content.length === 0) {
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE);
    }

    // Extract summary text from response
    const summaryText = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    if (!summaryText || summaryText.trim().length === 0) {
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE);
    }

    const formattedSummary = formatCompactSummary(summaryText);
    const userMessage = getCompactUserSummaryMessage(summaryText, true);

    return {
      summary: formattedSummary,
      message: userMessage,
      tokensRemoved: estimatedInputTokens,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError' || error.message.includes('abort')) {
        throw new Error(ERROR_MESSAGE_USER_ABORT);
      }
      throw error;
    }
    throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE);
  }
}

/**
 * C15 v2: Compact via direct ModelClient call (no HTTP → no circular dependency).
 * Uses the trimodel client directly instead of the local /v1/messages endpoint.
 * This is the version used by the auto-trigger wrapping layer in app.ts.
 */
export async function compactViaModelClient(
  messages: TriRLCMessage[],
  apiKey?: string,
  baseUrl?: string,
  customInstructions?: string,
): Promise<CompactResult> {
  if (messages.length < 3) {
    throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
  }

  const { createModelClient } = await import('trimodel');
  const client = createModelClient({
    deepseekApiKey: apiKey ?? process.env.DEEPSEEK_API_KEY ?? '',
    deepseekBaseUrl: baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
  });

  const prompt = getCompactPrompt(customInstructions);
  const estimatedInputTokens = estimateMessageTokens(messages);

  const compactMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: prompt + '\n\n---\n\nConversation to summarize:\n\n' },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  const response = await client.chat(COMPACT_MODEL, compactMessages, {
    max_tokens: MAX_COMPACT_TOKENS,
  });

  if (!response.content) {
    throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE);
  }

  const formattedSummary = formatCompactSummary(response.content);
  const userMessage = getCompactUserSummaryMessage(response.content, true);

  return {
    summary: formattedSummary,
    message: userMessage,
    tokensRemoved: estimatedInputTokens,
  };
}

/**
 * Prepare compacted message list for TriRLC.
 * Returns a new message list with the summary as a system message.
 */
export function createCompactedMessages(
  summaryMessage: string,
): TriRLCMessage[] {
  return [
    { role: 'assistant', content: summaryMessage },
  ];
}
