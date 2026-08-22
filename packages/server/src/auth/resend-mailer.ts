import type { EmailVerificationMail, Mailer, PasswordResetMail } from './mailer'

/**
 * The real outbound-mail adapter, over Resend's HTTPS API.
 *
 * Written against `fetch` rather than the vendor SDK, and that is the point:
 * the whole integration is one POST to one URL, so an SDK would add a
 * dependency, a transitive tree, and a supply-chain surface to vet in exchange
 * for nothing. Node 24 has `fetch` built in. ZERO new dependencies.
 *
 * Swapping providers means writing another file this size and changing which
 * one main.ts constructs. The `Mailer` port is what makes that true, and it
 * already existed — this is the first thing plugged into it.
 */

/** Where Resend takes a send. Not configurable: it is the provider's address. */
const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export interface ResendConfig {
  /** Resend API key. Comes from the env file on the box, never the repo. */
  apiKey: string
  /**
   * `From` address. Must be on a domain verified with Resend, or the send is
   * refused — that verification is what SPF and DKIM are for.
   */
  from: string
  /**
   * Public origin of the app, used to build the links in the mail. No trailing
   * slash. Wrong here means every link in every email points at the wrong
   * host, which is the sort of mistake nobody notices until a user reports a
   * dead link, so it is validated on construction rather than trusted.
   */
  appOrigin: string
  /**
   * `fetch` seam. Injected so the adapter is testable with no network and no
   * provider account — the same reason `Mailer` is a port at all.
   */
  fetch?: typeof globalThis.fetch
}

/**
 * Raised when the provider refuses a send.
 *
 * Carries the status and the provider's message, because "mail did not send"
 * with no reason is the least actionable operational error there is — the
 * causes (unverified domain, revoked key, malformed From) each have a different
 * fix and the provider names which one it is.
 */
export class MailSendError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`the mail provider refused the send (HTTP ${status}): ${detail}`)
    this.name = 'MailSendError'
  }
}

/** One outbound message, in Resend's shape. */
interface Payload {
  from: string
  to: string
  subject: string
  text: string
}

/**
 * The mail bodies.
 *
 * PLAIN TEXT ONLY, deliberately. These are two links and a sentence each; an
 * HTML part would double the thing that can render wrong across clients and
 * would buy nothing a link cannot do. Plain text also keeps the message
 * legible in a client that blocks remote content, which is the sort of client
 * a security-conscious recipient is using.
 *
 * Each says what to do if the recipient did not ask for it, because an
 * unexpected password-reset email is exactly when someone needs to be told
 * whether to worry. Neither says anything an interceptor could not already
 * infer from holding the link.
 */
function passwordResetBody(link: string): string {
  return [
    'Someone asked to reset the password on your CampaignSettings account.',
    '',
    'To choose a new one, open this link. It works once and expires in an hour:',
    link,
    '',
    'If that was not you, you can ignore this. Your password has not changed,',
    'and nobody can use this link without the address it was sent to.',
  ].join('\n')
}

function verificationBody(link: string): string {
  return [
    'Confirm your email address for CampaignSettings by opening this link.',
    'It works once and expires in 24 hours:',
    link,
    '',
    'If you did not create an account, you can ignore this — an unconfirmed',
    'address is never used for anything.',
  ].join('\n')
}

/**
 * Normalise the app origin, and refuse an unusable one at construction time
 * rather than at 3am when the first reset goes out.
 */
function normaliseOrigin(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`APP_ORIGIN must be an absolute URL (got ${JSON.stringify(raw)})`)
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error(`APP_ORIGIN must be https (got ${JSON.stringify(raw)})`)
  }
  return url.origin
}

export function createResendMailer(config: ResendConfig): Mailer {
  const origin = normaliseOrigin(config.appOrigin)
  const doFetch = config.fetch ?? globalThis.fetch

  async function send(payload: Payload): Promise<void> {
    const res = await doFetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      // The body is the provider's own explanation and is the useful half.
      // Reading it must not itself throw, or a provider outage becomes an
      // unhandled parse error instead of a legible refusal.
      const detail = await res.text().catch(() => '<no body>')
      throw new MailSendError(res.status, detail.slice(0, 500))
    }
  }

  return {
    async sendPasswordReset(mail: PasswordResetMail): Promise<void> {
      const link = `${origin}/reset-password?token=${encodeURIComponent(mail.token)}`
      await send({
        from: config.from,
        to: mail.to,
        subject: 'Reset your CampaignSettings password',
        text: passwordResetBody(link),
      })
    },
    async sendEmailVerification(mail: EmailVerificationMail): Promise<void> {
      const link = `${origin}/verify-email?token=${encodeURIComponent(mail.token)}`
      await send({
        from: config.from,
        to: mail.to,
        subject: 'Confirm your email for CampaignSettings',
        text: verificationBody(link),
      })
    },
  }
}

/**
 * Build the real mailer if the environment carries a provider, otherwise
 * `null` so the caller falls back to the logging one.
 *
 * All three variables are required together: a key with no `MAIL_FROM` cannot
 * send, and a `MAIL_FROM` with no origin sends links to nowhere. Half a
 * configuration is a misconfiguration, and it fails loudly at boot rather than
 * silently at the first reset — the one flow where a silent failure means a
 * locked-out user with no way to tell anyone.
 */
export function resendMailerFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof globalThis.fetch,
): Mailer | null {
  const apiKey = env.RESEND_API_KEY?.trim()
  if (!apiKey) return null
  const from = env.MAIL_FROM?.trim()
  const appOrigin = env.APP_ORIGIN?.trim()
  if (!from || !appOrigin) {
    throw new Error(
      'RESEND_API_KEY is set, so MAIL_FROM and APP_ORIGIN must be set too — otherwise mail either cannot send or sends links to nowhere',
    )
  }
  return createResendMailer({ apiKey, from, appOrigin, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
}
