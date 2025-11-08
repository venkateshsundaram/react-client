import type { ConnectServer } from 'connect';
import type { WebSocketServer } from 'ws';
import type { Server } from 'http';
import type { BroadcastMessage, HMRMessage } from '../server/broadcastManager';

export interface DevServerContext<T extends BroadcastMessage = HMRMessage> {
  root: string;
  outDir: string;
  app: ConnectServer;
  wss: WebSocketServer;
  httpServer: Server;
  broadcast: (msg: T) => void;
}

export interface PluginHotUpdateContext<T extends BroadcastMessage = HMRMessage> {
  broadcast: (msg: T) => void;
}

export interface ReactClientPlugin<T extends BroadcastMessage = HMRMessage> {
  name: string;
  version?: string;
  onTransform?(code: string, id: string): Promise<string> | string;
  onModuleResolve?(id: string, importer: string): Promise<string | null> | string | null;
  onServe?(ctx: DevServerContext<T>): void | Promise<void>;
  onHotUpdate?(file: string, ctx: PluginHotUpdateContext<T>): void | Promise<void>;
  onServerStart?(ctx: DevServerContext<T>): void | Promise<void>;
}

export interface ReactClientUserConfig<T extends BroadcastMessage = HMRMessage> {
  root?: string;
  server?: { port?: number; open?: boolean };
  build?: { outDir?: string };
  plugins?: ReactClientPlugin<T>[];
}
