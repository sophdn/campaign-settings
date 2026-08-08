import { describe, expect, it, vi } from 'vitest'
import { createLoggingMailer } from './mailer'

describe('logging mailer', () => {
  it('resolves and logs the recipient but never the token', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await createLoggingMailer().sendPasswordReset({ to: 'a@b.com', token: 'secret-token' })
      expect(log).toHaveBeenCalledWith(expect.stringContaining('a@b.com'))
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('secret-token'))
    } finally {
      log.mockRestore()
    }
  })
})
