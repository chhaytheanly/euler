import type { DisplayMessage } from "../cli/useChat";
import type { ChatMessage } from "./type";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  providerId?: string;
  model?: string;
}

export interface StoredSession {
  version: number;
  meta: SessionMeta;
  messages: DisplayMessage[];
  conversation: ChatMessage[];
  usage?: { input: number; output: number };
}
