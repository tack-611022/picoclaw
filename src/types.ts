export interface Conversation {
  id: string;
  session_id?: string;
  last_assistant_uuid?: string;
  created_at: string;
  last_activity: string;
  message_count: number;
  status: 'idle' | 'running';
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  sender: string | null;
  sender_name: string | null;
  content: string;
  created_at: string;
}

export interface PromptMessage {
  id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

export interface OutboundMessage {
  id: number;
  conversation_id: string;
  text: string;
  sender: string | null;
  created_at: string;
}

export interface ScheduledTask {
  id: string;
  conversation_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  numTurns: number;
  durationApiMs: number;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error' | 'timeout';
  result: string | null;
  error: string | null;
}
