// src/server/broadcastManager.ts
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import chalk from 'chalk';

/**
 * Generic broadcast message type used across dev runtime and plugins.
 * The index signature allows plugins to attach arbitrary keys.
 */
export type BroadcastMessage = {
  type: string;
  [key: string]: unknown;
};

export interface HMRMessage extends BroadcastMessage {
  type: 'update' | 'error' | 'reload';
  path?: string;
  message?: string;
  stack?: string;
}

/**
 * BroadcastManager — shared WebSocket utility for dev/preview/ssr servers.
 * Uses `ws` WebSocket instances (Node) — not DOM WebSocket.
 */
export class BroadcastManager {
  public wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      console.log(chalk.gray('🔌 HMR client connected'));

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(chalk.gray('❎ HMR client disconnected'));
      });

      ws.on('error', (err) => {
        console.error(chalk.red('⚠️ WebSocket error:'), err?.message ?? err);
      });
    });
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcast(msg: BroadcastMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      // ws.OPEN === 1
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(data);
        } catch {
          // ignore send errors per-client
        }
      }
    }
  }

  /**
   * Send a message to a single client (ws instance from 'ws').
   */
  send(ws: WebSocket, msg: BroadcastMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Close all WebSocket connections and server.
   */
  close(): void {
    try {
      console.log(chalk.red('🛑 Closing WebSocket connections...'));
      this.wss.close();
    } catch {
      /* ignore */
    }
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore per-client close errors
      }
    }
    this.clients.clear();
  }
}
