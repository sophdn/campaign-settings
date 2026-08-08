/** What the app hands a {@link Mailer} to send a reset link. */
export interface PasswordResetMail {
  to: string
  /** The raw reset token — goes into the link the recipient clicks. */
  token: string
}

/** What the app hands a {@link Mailer} to send a verification link. */
export interface EmailVerificationMail {
  to: string
  /** The raw verification token — goes into the link the recipient clicks. */
  token: string
}

/**
 * Outbound-mail port, shaped like {@link AuthService}: the app depends only on
 * this interface, and a real transactional provider is injected at the edge
 * (chain 436). Keeping it a port means tests use a fake and never send mail.
 */
export interface Mailer {
  sendPasswordReset(mail: PasswordResetMail): Promise<void>
  sendEmailVerification(mail: EmailVerificationMail): Promise<void>
}

/**
 * Default mailer: logs that a reset was requested instead of sending. Safe for
 * dev and tests; a production deploy MUST inject a real provider. It logs the
 * recipient but NOT the token, so a reset secret never lands in server logs.
 */
export function createLoggingMailer(): Mailer {
  return {
    sendPasswordReset(mail: PasswordResetMail): Promise<void> {
      console.log(`[mailer] password-reset requested for ${mail.to}`)
      return Promise.resolve()
    },
    sendEmailVerification(mail: EmailVerificationMail): Promise<void> {
      console.log(`[mailer] email-verification requested for ${mail.to}`)
      return Promise.resolve()
    },
  }
}
