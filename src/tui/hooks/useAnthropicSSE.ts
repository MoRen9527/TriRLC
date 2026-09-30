// Anthropic SSE client for TriRLC daemon /v1/messages
// REGR-005: added onContentBlockStart / onContentBlockDelta for tool-call streaming.
export interface AnthropicSSECallbacks {
  onContentDelta: (text: string) => void;
  onToolUse: (id: string, name: string, input: string) => void;
  onContentBlockStart?: (blockType: 'text' | 'tool_use' | 'tool_result', index: number) => void;
  onContentBlockDelta?: (index: number, delta: { type: string; text?: string; partial_json?: string }) => void;
  onTokens?: (inputTokens: number, outputTokens: number) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export interface AnthropicSSEOptions extends AnthropicSSECallbacks {
  endpoint: string;
  body: Record<string, unknown>;
}

export function connectAnthropicSSE(opts: AnthropicSSEOptions): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(opts.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'trilc-local',
        },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        opts.onError(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`));
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Track which content block indices are tool_result (skip their deltas)
      const toolResultBlocks = new Set<number>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            switch (event.type) {
              case 'message_start':
                if (event.message?.usage?.input_tokens !== undefined) {
                  opts.onTokens?.(event.message.usage.input_tokens, 0);
                }
                break;
              case 'content_block_start': {
                const blockType = event.content_block?.type as 'text' | 'tool_use' | 'tool_result' | undefined;
                // REGR-005: notify caller that a new content block is starting
                if (blockType) {
                  opts.onContentBlockStart?.(blockType, event.index ?? 0);
                }

                if (event.content_block?.type === 'tool_use') {
                  opts.onToolUse(
                    event.content_block.id || '',
                    event.content_block.name || '',
                    ''
                  );
                } else if (event.content_block?.type === 'tool_result') {
                  // Mark this block index as tool_result — skip its deltas
                  if (event.index !== undefined) toolResultBlocks.add(event.index);
                }
                break;
              }
              case 'content_block_delta': {
                // Skip deltas from tool_result blocks (they're tool output, not model text)
                if (event.index !== undefined && toolResultBlocks.has(event.index)) break;

                const delta = event.delta as { type: string; text?: string; partial_json?: string } | undefined;
                if (!delta) break;

                // REGR-005: block-level delta callback (handles both text and input_json)
                opts.onContentBlockDelta?.(event.index ?? 0, delta);

                // Backward compat: text_delta still forwarded to onContentDelta
                if (delta.type === 'text_delta' && delta.text) {
                  opts.onContentDelta(delta.text);
                }
                break;
              }
              case 'content_block_stop':
                break;
              case 'message_delta':
                if (event.usage?.output_tokens !== undefined) {
                  opts.onTokens?.(0, event.usage.output_tokens);
                }
                if (event.delta?.stop_reason) {
                  opts.onDone();
                }
                break;
              case 'message_stop':
                opts.onDone();
                break;
            }
          } catch { /* skip malformed SSE */ }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        opts.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return () => controller.abort();
}
