// Caches a value on `global` so the custom server and Next route bundles share one instance. `init` runs once.
export function globalSingleton<T>(key: string, init: () => T): T {
  const g = global as typeof global & { __singletons?: Record<string, unknown> };
  g.__singletons ??= {};
  if (!(key in g.__singletons)) g.__singletons[key] = init();
  return g.__singletons[key] as T;
}
