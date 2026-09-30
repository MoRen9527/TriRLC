// ── TriRLC Sync Payload Builder ──
// Job: Assemble SessionRecord + SessionMessageRecord[] into SyncRequestPayload.
//
// Rules:
//   1. messages truncated to maxMessages (default 5000), exceeded → record warning
//   2. toolCalls field deserialized from session_messages.tool_calls (JSON string)
//   3. timestamp uses message's created_at field

import type { SessionRecord } from '../session-store/types.js';
import type { SyncRequestPayload, SyncMessagePayload } from './types.js';

/** 消息输入类型（结构子集，兼容 SessionMessageRecord 和 SyncEngineDeps 的 getMessages 返回） */
export interface SyncMessageInput {
  role: string;
  content: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  createdAt: string;
}

/**
 * 构建发送给 TriMMC 的同步 payload。
 *
 * @param session    会话记录
 * @param messages   消息列表
 * @param nodeId     本地节点 ID
 * @param maxMessages  消息截断上限
 * @returns payload + truncated 标记
 */
export function buildSyncPayload(
  session: SessionRecord,
  messages: SyncMessageInput[],
  nodeId: string,
  maxMessages: number,
): {
  payload: SyncRequestPayload;
  truncated: boolean;
} {
  const truncated = messages.length > maxMessages;
  const sliced = truncated ? messages.slice(0, maxMessages) : messages;

  const messagePayloads: SyncMessagePayload[] = sliced.map((msg) => {
    const payload: SyncMessagePayload = {
      role: msg.role as SyncMessagePayload['role'],
      content: msg.content,
      timestamp: msg.createdAt,
    };

    if (msg.toolCalls) {
      try {
        const raw = JSON.parse(msg.toolCalls) as Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
        payload.toolCalls = raw.map((tc) => ({
          toolName: tc.function.name,
          input: (() => {
            try {
              return JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              return { raw: tc.function.arguments };
            }
          })(),
        }));
      } catch {
        // 解析失败，跳过 toolCalls
      }
    }

    if (msg.toolCallId) {
      payload.toolCallId = msg.toolCallId;
    }

    return payload;
  });

  return {
    payload: {
      nodeId,
      syncType: 'full',
      session: {
        localSessionId: session.id,
        title: session.title ?? '',
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: messagePayloads,
      },
      syncedAt: new Date().toISOString(),
    },
    truncated,
  };
}
