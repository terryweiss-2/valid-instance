/** A validation problem. Never contains property values. */
export interface ValidationIssue {
  property: string;
  schemaPath: string;
  keyword: string;
  expected: string;
  received: string;
}

export type ValidationResult = { valid: true } | { valid: false; errors: ValidationIssue[] };

export interface RemoteRefsOptions {
  enabled?: boolean;
  allowList?: string[] | ((url: URL) => boolean);
  protocols?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  maxRefs?: number;
  maxDepth?: number;
  allowPrivateHosts?: string[];
  resolver?: (uri: string) => Promise<object | string>;
  schemas?: { [uri: string]: object };
  integrity?: { [uri: string]: string };
}

export interface ValidInstanceOptions {
  validateOnInit?: boolean;
  liveValidate?: boolean;
  onlyWarn?: boolean;
  logErrorToConsole?: boolean;
  remoteRefs?: RemoteRefsOptions;
}

export type TypedObject<T extends object = Record<string, any>> = T & {
  validate(): ValidationResult;
  replaceWith(obj: T, validateNow?: boolean): void;
};

export function validInstance<T extends object = Record<string, any>>(
  schema: object | string,
  initial?: T,
  options?: ValidInstanceOptions
): Promise<TypedObject<T>>;

export function clearSchemaCache(): void;

export class ValidInstanceError extends Error {
  code?: string;
  property?: string;
  schemaPath?: string;
  expected?: string;
  received?: string;
  value?: unknown;
  issues?: ValidationIssue[];
  cause?: unknown;
}
export class InitializationError extends ValidInstanceError {}
export class InvalidValueError extends ValidInstanceError {}
export class InvalidJsonSchemaError extends ValidInstanceError {}
export class JsonSchemaCommError extends ValidInstanceError {}
