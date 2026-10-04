// ── TriRLC Event Queue Types ──
// Defines the QueuedEvent model as specified in CTO-008-M §3.2.2.

export interface QueuedEvent {
  eventId: string;           // "tri-20260428-a1b2c3d4-e001"
  connectionId: string;
  type: 'agent_run' | 'task_complete' | 'tool_call' | 'state_change';
  timestamp: number;         // epoch ms
  sequenceNumber: number;    // monotonic within connection
  payload: unknown;
}

export type EventStatus = 'pending' | 'replaying' | 'replayed' | 'failed' | 'expired';

export interface QueuedEventRow {
  event_id: string;
  connection_id: string;
  type: QueuedEvent['type'];
  timestamp: number;
  seq_no: number;
  payload: string | unknown;
  status: EventStatus;
  retries: number;
  last_error: string | null;
  created_at: string;
}

export interface ReplayRequest {
  nodeId: string;
  connectionId: string;
  events: ReplayEventItem[];
}

export interface ReplayEventItem {
  eventId: string;
  type: QueuedEvent['type'];
  timestamp: number;
  seqNo: number;
  payload: unknown;
}

export interface ReplayResponse {
  ok: boolean;
  accepted: number;
  conflicts: ConflictItem[];
  lastSeqNo: number;
}

export interface ConflictItem {
  eventId: string;
  type: string;
  resolution: 'rejected_duplicate' | 'version_stale' | 'already_executed' | 'merged';
  reason: string;
  currentOwner?: string;
}
