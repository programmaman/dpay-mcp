/**
 * Demo Event Types & EventEmitter
 *
 * Shared event bus for the two-agent demo UI.
 * The agent orchestration emits typed events here; the WebSocket server
 * picks them up and broadcasts them to the browser.
 */

import { EventEmitter } from 'node:events';

export const demoEvents = new EventEmitter();

// ─── Event types ────────────────────────────────────────────────────────────

export interface AgentMessageEvent {
  type: 'agent_message';
  agent: 'pm' | 'developer';
  content: string;
  timestamp: number;
}

export interface AgentThinkingEvent {
  type: 'agent_thinking';
  agent: string;
  timestamp: number;
}

export interface ToolCalledEvent {
  type: 'tool_called';
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface ToolResultEvent {
  type: 'tool_result';
  tool: string;
  success: boolean;
  result: unknown;
  timestamp: number;
}

export interface BlockchainEvent {
  type: 'blockchain_event';
  event: 'payment_created' | 'payment_settled' | 'dispute_raised' | 'payment_verified';
  payload: unknown;
  timestamp: number;
}

export type DemoEvent =
  | AgentMessageEvent
  | AgentThinkingEvent
  | ToolCalledEvent
  | ToolResultEvent
  | BlockchainEvent;
