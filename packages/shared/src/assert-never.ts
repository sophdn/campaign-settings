/**
 * Exhaustiveness guard: call in the `default` branch of a switch over a union so
 * the compiler errors if a case is unhandled, and a runtime error fires if an
 * unexpected value slips through at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`)
}
