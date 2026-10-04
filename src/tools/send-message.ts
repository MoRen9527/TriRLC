// ── TriRLC SendMessageTool (P1 A级复制) ──
// A级直接复制 from CC: src/tools/SendMessageTool/SendMessageTool.ts
// 适配说明：
// - CC 依赖 mailbox/teammate 系统 → TriRLC 使用 localbus 进程内通信
// - CC 支持 shutdown/plan 协议 → TriRLC 单进程，简化为基础消息传递
// - CC 支持 bridge/uds 跨会话 → TriRLC 仅支持进程内消息

import { register as registerTool } from '@tricompany/agent-core';

// In-process message inbox (simplified - CC uses complex mailbox)
const messageInbox = new Map<string, Message[]>();

interface Message {
  from: string;
  to: string;
  text: string;
  summary?: string;
  timestamp: string;
  color?: string;
}

// ── SendMessageTool ──
// CC-equivalent message tool with TriRLC localbus adaptation
export function registerSendMessageTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'SendMessage',
        description: 'Send a message to another agent.\n\n```\n{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}\n```\n\n| `to` | |\n|---|---|\n| `"researcher"` | Agent by name |\n| `"*"` | Broadcast to all agents |\n\nYour plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don\'t check an inbox. Refer to agents by name.\n\n## Note for TriRLC\n\nThis is a simplified implementation of CC\'s SendMessageTool. TriRLC runs in single-daemon mode, so messages are delivered in-process via the localbus. Cross-daemon messaging and remote control features are not available.',
        parameters: {
          type: 'object',
          properties: {
            to: {
              type: 'string',
              description: 'Recipient: agent name, or "*" for broadcast to all agents',
            },
            summary: {
              type: 'string',
              description: 'A 5-10 word summary shown as a preview in the UI (required when message is a string)',
            },
            message: {
              type: 'string',
              description: 'Plain text message content',
            },
          },
          required: ['to', 'message'],
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const to = args.to as string;
      const message = args.message as string;
      const summary = args.summary as string | undefined;

      if (!to || !to.trim()) {
        return JSON.stringify({ error: 'to must not be empty' });
      }
      if (!message || !message.trim()) {
        return JSON.stringify({ error: 'message is required' });
      }
      if (to !== '*' && (!summary || !summary.trim())) {
        return JSON.stringify({ error: 'summary is required when message is a string' });
      }

      const timestamp = new Date().toISOString();
      const from = 'agent'; // TriRLC simplified - no complex teammate naming

      if (to === '*') {
        // Broadcast to all inboxes
        let recipientCount = 0;
        for (const [recipientName] of messageInbox) {
          const msg: Message = {
            from,
            to: recipientName,
            text: message,
            summary: summary || '',
            timestamp,
          };
          const inbox = messageInbox.get(recipientName) || [];
          inbox.push(msg);
          messageInbox.set(recipientName, inbox);
          recipientCount++;
        }

        return JSON.stringify({
          success: true,
          message: `Message broadcast to ${recipientCount} agent(s)`,
          recipients: Array.from(messageInbox.keys()),
        });
      }

      // Send to specific agent
      const msg: Message = {
        from,
        to,
        text: message,
        summary: summary || '',
        timestamp,
      };

      const inbox = messageInbox.get(to) || [];
      inbox.push(msg);
      messageInbox.set(to, inbox);

      return JSON.stringify({
        success: true,
        message: `Message sent to ${to}'s inbox`,
        routing: {
          sender: from,
          target: `@${to}`,
          summary,
          content: message,
        },
      });
    },
  );
}

// Export for use by agent core (receive message)
export { messageInbox, type Message };
