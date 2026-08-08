import { describe, expect, it } from 'vitest'
import { describeUserAgent } from './user-agent'

describe('describeUserAgent', () => {
  it('reduces real User-Agent strings to a coarse browser-on-platform label', () => {
    expect(
      describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'),
    ).toBe('Firefox on Linux')
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on Windows')
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      ),
    ).toBe('Safari on macOS')
  })

  it('prefers the most specific family when a UA claims several', () => {
    // Edge and Opera both impersonate Chrome; iOS UAs also say "Mac OS X".
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      ),
    ).toBe('Edge on Windows')
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0',
      ),
    ).toBe('Opera on Windows')
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS')
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android')
  })

  it('falls back to whichever half it recognises', () => {
    expect(describeUserAgent('Firefox/127.0')).toBe('Firefox')
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux')
  })

  it('returns null when there is nothing recognisable to store', () => {
    expect(describeUserAgent(undefined)).toBeNull()
    expect(describeUserAgent('')).toBeNull()
    expect(describeUserAgent('curl/8.5.0')).toBeNull()
  })
})
