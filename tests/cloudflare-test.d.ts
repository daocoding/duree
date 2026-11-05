declare module "cloudflare:test" {
  export function runInDurableObject<R>(
    stub: DurableObjectStub,
    callback: (instance: unknown, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
  export function evictDurableObject(stub: DurableObjectStub): Promise<void>;
}
