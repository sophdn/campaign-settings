/**
 * Send one real email through the configured provider, to prove the provider
 * half of the deploy works before anybody's password depends on it.
 *
 *   # on the box, in the app directory
 *   set -a; . /etc/campaign-settings.env; set +a
 *   node --import tsx packages/server/scripts/send-test-email.mts you@example.com
 *
 * Reads exactly what the server reads — RESEND_API_KEY, MAIL_FROM, APP_ORIGIN —
 * so a success here means the server will send, and a failure names which of the
 * three is wrong. It sends a PASSWORD-RESET-shaped message with an obviously
 * fake token, because the thing worth testing is the path that matters and the
 * one whose link must arrive intact.
 *
 * It touches no database and creates no token: the link in the mail is dead on
 * arrival by construction. Nothing here can reset anybody's password.
 */
import { resendMailerFromEnv } from '../src/auth/resend-mailer'

const to = process.argv[2]
if (!to || !to.includes('@')) {
  console.error('usage: send-test-email.mts <recipient@example.com>')
  process.exit(2)
}

const mailer = resendMailerFromEnv(process.env)
if (!mailer) {
  console.error(
    'RESEND_API_KEY is not set in this environment, so there is no provider to test.\n' +
      'Did you source the env file?  set -a; . /etc/campaign-settings.env; set +a',
  )
  process.exit(2)
}

// Obviously not a real token, and deliberately so — anyone reading the mail or
// the logs should be able to see at a glance that this grants nothing.
await mailer.sendPasswordReset({ to, token: 'THIS-IS-A-TEST-TOKEN-AND-DOES-NOTHING' })

console.log(`sent a test password-reset email to ${to}`)
console.log(`  from:       ${process.env.MAIL_FROM}`)
console.log(`  link host:  ${process.env.APP_ORIGIN}`)
console.log('')
console.log('Check that it ARRIVED and did not land in spam. If it is in spam, the')
console.log('SPF/DKIM records are missing or wrong — see DEPLOY.md §"Outbound email".')
