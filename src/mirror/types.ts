// ── TriRLC Mirror Types ──
// S7: TriRLC-side mirror types (compatible with TriMMC MirrorRequest).
// CPO Q6c + CTO §7.2 S7 §3.5.

/** TriRLC 侧 mirror 任务快照（不包含 TriMMC 服务端字段） */
export interface MirrorTaskSnapshot {
  taskId: string;
  title: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  summary: string;
  updatedAt: string;
}
