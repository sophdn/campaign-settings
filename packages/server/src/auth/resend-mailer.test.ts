import { describe, expect, it, vi } from 'vitest'
import { MailSendError, createResendMailer, resendMailerFromEnv } from './resend-mailer'

/** A `fetch` stand-in that records the call and answers with the given status. */
function fakeFetch(
  status = 200,
  body = '{}',
): {
  fetch: typeof globalThis.fetch
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return Promise.resolve(
      new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    )
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const CONFIG = {
  apiKey: 'test-key',
  from: 'CampaignSettings <no-reply@example.com>',
  appOrigin: 'https://example.com',
}

/** The JSON body of the nth recorded call. */
const bodyOf = (calls: { init: RequestInit }[], n = 0): Record<string, string> =>
  JSON.parse(String(calls[n]?.init.body)) as Record<string, string>

describe('resend mailer', () => {
  it('posts a password reset with a working link to this deployment', async () => {
    const { fetch, calls } = fakeFetch()

    await createResendMailer({ ...CONFIG, fetch }).sendPasswordReset({
      to: 'player@example.net',
      token: 'tok-123',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.resend.com/emails')
    expect(calls[0]?.init.method).toBe('POST')
    const body = bodyOf(calls)
    expect(body.to).toBe('player@example.net')
    expect(body.from).toBe(CONFIG.from)
    expect(body.text).toContain('https://example.com/reset-password?token=tok-123')
  })

  it('posts a verification with the verify route, not the reset one', async () => {
    const { fetch, calls } = fakeFetch()

    await createResendMailer({ ...CONFIG, fetch }).sendEmailVerification({
      to: 'player@example.net',
      token: 'tok-456',
    })

    expect(bodyOf(calls).text).toContain('https://example.com/verify-email?token=tok-456')
  })

  it('carries the key as a bearer token and nothing else', async () => {
    const { fetch, calls } = fakeFetch()
    await createResendMailer({ ...CONFIG, fetch }).sendPasswordReset({ to: 'a@b.co', token: 't' })
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key')
    expect(headers['content-type']).toBe('application/json')
  })

  /**
   * A token goes into a query string, so anything URL-special in it has to be
   * escaped or the link silently truncates and the recipient gets a dead one.
   * The generator produces base64url today, which has nothing to escape — this
   * pins the encoding so a future token alphabet cannot quietly break links.
   */
  it('escapes the token rather than trusting its alphabet', async () => {
    const { fetch, calls } = fakeFetch()
    await createResendMailer({ ...CONFIG, fetch }).sendPasswordReset({
      to: 'a@b.co',
      token: 'a+b/c=d&e',
    })
    expect(bodyOf(calls).text).toContain('token=a%2Bb%2Fc%3Dd%26e')
  })

  it('never puts the token anywhere but the link', async () => {
    const { fetch, calls } = fakeFetch()
    await createResendMailer({ ...CONFIG, fetch }).sendPasswordReset({
      to: 'a@b.co',
      token: 'secret-token',
    })
    const body = bodyOf(calls)
    expect(body.subject).not.toContain('secret-token')
    expect(body.text?.match(/secret-token/g)).toHaveLength(1)
  })

  it('tells the operator WHY the provider refused, not merely that it did', async () => {
    const { fetch } = fakeFetch(403, '{"message":"domain is not verified"}')
    const mailer = createResendMailer({ ...CONFIG, fetch })

    await expect(mailer.sendPasswordReset({ to: 'a@b.co', token: 't' })).rejects.toThrow(
      /HTTP 403.*domain is not verified/,
    )
    await expect(mailer.sendPasswordReset({ to: 'a@b.co', token: 't' })).rejects.toBeInstanceOf(
      MailSendError,
    )
  })

  it('still refuses legibly when the provider sends no readable body', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error('connection reset')),
      } as unknown as Response),
    ) as unknown as typeof globalThis.fetch

    await expect(
      createResendMailer({ ...CONFIG, fetch }).sendPasswordReset({ to: 'a@b.co', token: 't' }),
    ).rejects.toThrow(/HTTP 502.*<no body>/)
  })
})

describe('appOrigin validation', () => {
  it('refuses a non-absolute or non-https origin at construction, not at send time', () => {
    for (const bad of ['example.com', '/app', 'http://example.com', '']) {
      expect(() => createResendMailer({ ...CONFIG, appOrigin: bad }), bad).toThrow(/APP_ORIGIN/)
    }
  })

  it('allows http on localhost, so a real send can be rehearsed in dev', () => {
    expect(() =>
      createResendMailer({ ...CONFIG, appOrigin: 'http://localhost:8787' }),
    ).not.toThrow()
  })

  it('trims a trailing path or slash down to the origin', async () => {
    const { fetch, calls } = fakeFetch()
    await createResendMailer({
      ...CONFIG,
      appOrigin: 'https://example.com/',
      fetch,
    }).sendPasswordReset({ to: 'a@b.co', token: 't' })
    expect(bodyOf(calls).text).toContain('https://example.com/reset-password')
  })
})

describe('resendMailerFromEnv', () => {
  it('is absent when no provider is configured, so the caller keeps the logging mailer', () => {
    expect(resendMailerFromEnv({})).toBeNull()
    expect(resendMailerFromEnv({ RESEND_API_KEY: '   ' })).toBeNull()
  })

  it('builds the real mailer when the environment carries all three parts', async () => {
    const { fetch, calls } = fakeFetch()
    const mailer = resendMailerFromEnv(
      {
        RESEND_API_KEY: 'k',
        MAIL_FROM: 'no-reply@example.com',
        APP_ORIGIN: 'https://example.com',
      },
      fetch,
    )
    expect(mailer).not.toBeNull()
    await mailer?.sendPasswordReset({ to: 'a@b.co', token: 't' })
    expect(bodyOf(calls).from).toBe('no-reply@example.com')
  })

  /**
   * Half a configuration is a misconfiguration. It fails at BOOT rather than at
   * the first password reset — the one flow where a silent failure leaves a
   * locked-out user with no way to tell anybody.
   */
  it('refuses a half-configured provider rather than sending links to nowhere', () => {
    expect(() => resendMailerFromEnv({ RESEND_API_KEY: 'k' })).toThrow(/MAIL_FROM and APP_ORIGIN/)
    expect(() => resendMailerFromEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.co' })).toThrow(
      /MAIL_FROM and APP_ORIGIN/,
    )
    expect(() =>
      resendMailerFromEnv({ RESEND_API_KEY: 'k', APP_ORIGIN: 'https://example.com' }),
    ).toThrow(/MAIL_FROM and APP_ORIGIN/)
  })
})
