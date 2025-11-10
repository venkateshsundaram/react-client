// src/types/plugin.d.ts
import type { ConnectServer } from 'connect';
import type { WebSocketServer } from 'ws';
import type { Server } from 'http';
import type { BroadcastMessage } from '../server/broadcastManager';

export interface DevServerContext {
  root: string;
  outDir: string;
  app: ConnectServer;
  wss: WebSocketServer;
  httpServer: Server;
  /**
   * Broadcast a message to connected clients.
   * Accepts BroadcastMessage (has index signature).
   */
  broadcast: (msg: BroadcastMessage) => void;
}

/**
 * Context passed to plugin onHotUpdate hook.
 */
export interface PluginHotUpdateContext {
  broadcast: (msg: BroadcastMessage) => void;
}

/**
 * Plugin interface.
 */
export interface ReactClientPlugin {
  name: string;
  version?: string;

  /**
   * Transform source before it is served. Return transformed code or the original.
   */
  onTransform?: (code: string, id: string) => Promise<string | undefined> | string | undefined;

  /**
   * Called when a file changes. Plugins can trigger broadcasts via ctx.broadcast
   */
  onHotUpdate?: (file: string, ctx: PluginHotUpdateContext) => void | Promise<void>;

  /**
   * Called to register middleware or routes.
   */
  onServe?: (ctx: DevServerContext) => void | Promise<void>;

  /**
   * Called after server has started.
   */
  onServerStart?: (ctx: DevServerContext) => void | Promise<void>;
}

/**
 * User config shape for react-client.config.*
 */
export interface ReactClientUserConfig {
  root?: string;
  server?: {
    port?: number;
    open?: boolean;
  };
  build?: {
    outDir?: string;
  };
  plugins?: ReactClientPlugin[];
}
