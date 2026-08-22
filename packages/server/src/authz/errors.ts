/** Raised when an actor attempts an operation their role/identity disallows. */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenError'
  }
}
