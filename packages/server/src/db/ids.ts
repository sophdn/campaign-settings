import { randomUUID } from 'node:crypto'

/**
 * Generate a new text id for a server-created row. Imports keep dm-manager's
 * existing ids (passed explicitly), so id columns have no DB default.
 */
export function newId(): string {
  return randomUUID()
}
