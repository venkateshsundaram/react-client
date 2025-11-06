export interface InitOptions {
  template?: string;
  withConfig?: boolean;
}

export interface GenerateOptions {
  path?: string;
  ts?: boolean; // true when --no-ts is not used
  force?: boolean;
}

export default {} as const;
