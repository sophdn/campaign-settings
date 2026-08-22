import type { FastifyReply, FastifyRequest } from 'fastify'

/** Name of the signed session cookie (shared by the auth routes and guards). */
export const SESSION_COOKIE = 'cs_session'

/** The verified session id from the signed cookie, or null. */
export function sessionIdFromCookie(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE]
  if (!raw) return null
  const unsigned = request.unsignCookie(raw)
  return unsigned.valid ? unsigned.value : null
}

export function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: opts.secure,
    maxAge: opts.maxAgeSeconds,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}
