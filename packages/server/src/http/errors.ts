/**
 * Structured API errors. Handlers throw these (or the domain ForbiddenError);
 * the app's error handler renders them as `{ error: { code, message } }`.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const unauthenticated = (): ApiError =>
  new ApiError(401, 'unauthenticated', 'authentication required')
export const invalidCredentials = (): ApiError =>
  new ApiError(401, 'invalid_credentials', 'invalid username or password')
export const forbidden = (message = 'forbidden'): ApiError =>
  new ApiError(403, 'forbidden', message)
export const notFound = (message = 'not found'): ApiError => new ApiError(404, 'not_found', message)
export const invalidResetToken = (): ApiError =>
  new ApiError(400, 'invalid_or_expired_token', 'invalid or expired reset token')
/**
 * One refusal for every unusable verification link — unknown, already used, or
 * expired. Same reasoning as the invitation refusal: distinguishing them turns
 * a dead link into a probe.
 */
export const invalidVerificationToken = (): ApiError =>
  new ApiError(400, 'invalid_or_expired_token', 'this verification link is no longer valid')
/**
 * Returned (not thrown) to @fastify/rate-limit's errorResponseBuilder, which
 * requires an Error carrying `statusCode` and throws it itself. Being an
 * ApiError is what keeps a 429 in the same `{error:{code,message}}` envelope as
 * every other refusal, instead of the plugin's own default shape.
 */
/**
 * Public self-serve registration is switched off. A 403 rather than a 404: the
 * route exists and is simply closed, and pretending otherwise would make a
 * misconfigured deployment look like a broken build.
 */
/**
 * One refusal for every way an invitation can be unusable — unknown, revoked,
 * expired, already redeemed, or aimed at someone else. Distinguishing them
 * would turn a dead link into a probe for which worlds and accounts exist.
 */
export const invalidInvitation = (): ApiError =>
  new ApiError(400, 'invalid_invitation', 'this invitation is no longer valid')
export const signupClosed = (): ApiError =>
  new ApiError(403, 'signup_closed', 'public registration is not open')
/**
 * A surface switched off by a feature flag. 403 rather than 404 for the same
 * reason as `signupClosed`: the route exists and is closed, and pretending
 * otherwise would make a misconfigured deployment look like a broken build.
 *
 * The SPA maps this code to the contact modal, which is why every gated surface
 * shares ONE code rather than inventing a per-surface one.
 */
export const surfaceDisabled = (surface: string): ApiError =>
  new ApiError(403, 'surface_disabled', `${surface} is not available on this deployment`)
export const rateLimited = (): ApiError =>
  new ApiError(429, 'rate_limited', 'too many requests, slow down')
