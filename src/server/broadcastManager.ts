import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';
import http from 'http';
import chalk from 'chalk';

/**
 * Base broadcast message that plugins may extend.
 * Includes an index signature so plugin-defined keys are allowed.
 */
export interface BroadcastMessage {
  /** At minimum every message must have a type string */
  type: string;
  [key: string]: unknown;
}

/**
 * Core HMR message shape — narrows `type` to known HMR events
 * and adds optional fields. It extends BroadcastMessage so it's
 * assignable to the generic constraint.
 */
export interface HMRMessage extends BroadcastMessage {
  type: 'update' | 'error' | 'reload';
  path?: string;
  message?: string;
  stack?: string;
}

/**
 * BroadcastManager — Shared WebSocket utility for dev, preview, and SSR servers.
 * Generic over message type T which defaults to HMRMessage.
 */
export class BroadcastManager<T extends BroadcastMessage = HMRMessage> {
  private wss: WebSocketServer;
  private clients: Set<NodeWebSocket> = new Set();

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: NodeWebSocket) => {
      this.clients.add(ws);
      console.log(chalk.gray('🔌 Client connected'));

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(chalk.gray('❎ Client disconnected'));
      });

      ws.on('error', (err) => {
        console.error(chalk.red('⚠️ WebSocket error:'), err.message);
      });
    });
  }

  broadcast(msg: T): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === NodeWebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  send(ws: NodeWebSocket, msg: T): void {
    if (ws.readyState === NodeWebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): void {
    console.log(chalk.red('🛑 Closing WebSocket connections...'));
    this.wss.close();
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}
