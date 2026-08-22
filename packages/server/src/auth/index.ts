/** Public surface of the auth seam — import from here, not the internals. */
export { loadAuthConfig, type AuthConfig } from './config'
export { createLoggingMailer, type Mailer, type PasswordResetMail } from './mailer'
export { createScryptAuth, type ScryptAuthOptions } from './service'
export { DuplicateEmailError, DuplicateUsernameError } from './types'
export type { AuthService, LoginResult, PublicAccount, SessionMeta, SessionSummary } from './types'
export { describeUserAgent } from './user-agent'
