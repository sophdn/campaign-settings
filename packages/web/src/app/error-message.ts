/** A human-readable message from a caught value (api-client failures are Errors). */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  return err instanceof Error ? err.message : fallback
}
