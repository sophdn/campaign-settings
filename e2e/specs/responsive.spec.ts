import { type Page, expect, test } from '@playwright/test'
import { login } from '../fixtures'

/**
 * The app shell at phone widths.
 *
 * One invariant carries almost all of this: **the document must never be wider
 * than the viewport.** A page that scrolls sideways is not merely awkward — the
 * header is sized to the viewport rather than to the scroll width, so scrolling
 * right walks off the end of it, which is how this was first noticed.
 *
 * It is worth asserting in a real browser rather than reasoning about, because
 * the causes are all intrinsic-sizing rules that jsdom does not implement: a
 * grid item's `min-width: auto`, a text input's default ~20-character width, a
 * long word's contribution to min-content. Every one of them is invisible until
 * something lays out for real.
 */

/** 320 is the narrowest phone still worth supporting; 393 is a current Pixel. */
const PHONE_WIDTHS = [320, 375, 393]

/** Content wide enough to break a layout that does not defend itself: a long
 *  unbreakable URL, a long unbroken word, and a name far wider than the column. */
const LONG_NAME = 'Archduchess Kassandrine-Valebrandt of the Thrice-Sundered Ashwaste Dominion'
const LONG_BODY = [
  'Correspondence: https://records.thrice-sundered-ashwaste.example/dominion/archive/1873/kassandrine-valebrandt-correspondence.html',
  '',
  'Her sworn epithet is Unbrokenwordthatgoesonandonandonforeverwithoutanyspaces at all.',
].join('\n')

/** Assert the page does not scroll sideways, naming what overflowed when it does. */
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const result = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const offenders: string[] = []
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      if (rect.right > vw + 0.5) {
        const node = el as HTMLElement
        const cls = node.className ? `.${String(node.className).split(' ').join('.')}` : ''
        offenders.push(`${node.tagName.toLowerCase()}${cls} (right=${Math.round(rect.right)})`)
      }
    }
    return { vw, scrollWidth: document.documentElement.scrollWidth, offenders }
  })
  expect(
    result.scrollWidth,
    `${where} scrolls sideways at ${result.vw}px. Overflowing: ${result.offenders.slice(0, 6).join(', ') || 'none measured'}`,
  ).toBeLessThanOrEqual(result.vw)
}

test.describe('the app shell at phone widths', () => {
  test('no world surface scrolls sideways, even with overlong user content', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 851 })
    await login(page, 'owner')
    await page.getByRole('link', { name: 'E2E World' }).click()
    const worldUrl = page.url().replace(/\/$/, '')

    // Author the hostile content once, then view it at each width.
    await page.goto(`${worldUrl}/npc`)
    await page.getByLabel('Name').fill(LONG_NAME)
    await page.getByRole('button', { name: 'Add' }).click()
    await page.getByRole('link', { name: LONG_NAME }).click()
    await page.getByLabel('Description').fill(LONG_BODY)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Saved')).toBeVisible()
    const entityUrl = page.url()

    const surfaces: [string, string][] = [
      ['wiki', worldUrl],
      ['entity list', `${worldUrl}/npc`],
      ['entity detail', entityUrl],
      ['maps', `${worldUrl}/maps`],
      ['notes', `${worldUrl}/notes`],
      ['members', `${worldUrl}/members`],
      ['suggestions', `${worldUrl}/suggestions`],
      ['world picker', '/'],
      ['account', '/account'],
    ]

    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 851 })
      for (const [name, url] of surfaces) {
        await page.goto(url)
        await page.waitForLoadState('networkidle')
        await expectNoSidewaysScroll(page, `${name} @${width}`)
      }
    }
  })

  test('the nav rail stays beside the screen it navigates to, and narrows to make room', async ({
    page,
  }) => {
    // The rail must not collapse into a stacked block on a phone: doing so puts
    // a full-height list of links above every screen, so tapping an entity kind
    // appears to do nothing until you scroll past the nav.
    await login(page, 'owner')
    await page.getByRole('link', { name: 'E2E World' }).click()
    const worldUrl = page.url().replace(/\/$/, '')
    await page.goto(`${worldUrl}/npc`)

    const rail = page.locator('.world-nav')
    const content = page.locator('.world-content')

    let previousRail = Number.POSITIVE_INFINITY
    for (const width of [1280, 768, 393, 320]) {
      await page.setViewportSize({ width, height: 851 })
      await expect(rail).toBeVisible()
      const railBox = (await rail.boundingBox())!
      const contentBox = (await content.boundingBox())!

      // Side by side: the content starts to the RIGHT of the rail, not below it.
      expect(contentBox.x, `content sits beside the rail at ${width}px`).toBeGreaterThanOrEqual(
        railBox.x + railBox.width,
      )
      expect(contentBox.y, `content is not pushed below the rail at ${width}px`).toBeLessThan(
        railBox.y + railBox.height,
      )

      // The rail gives up width as the viewport shrinks (never gains it).
      expect(railBox.width, `rail does not grow as the viewport narrows`).toBeLessThanOrEqual(
        previousRail,
      )
      previousRail = railBox.width

      // The rail costs the content column real width, so bound what it may take.
      // 320px is the one width where the rail's floor (8rem, set by its longest
      // label) is an outright majority of what is left; from a current phone
      // upward the content column must be the wider of the two.
      expect(contentBox.width, `content column is usable at ${width}px`).toBeGreaterThan(150)
      if (width >= 375) {
        expect(
          contentBox.width,
          `content gets more width than the rail at ${width}px`,
        ).toBeGreaterThan(railBox.width)
      }
    }
  })

  test('every nav label fits the narrowed rail without being clipped or broken mid-word', async ({
    page,
  }) => {
    // The rail narrows faster than its text does, so the longest single word in
    // the nav is what sets the floor for --rail-width and --rail-font. If either
    // is retuned, this is the test that notices the label has stopped fitting.
    await login(page, 'owner')
    await page.getByRole('link', { name: 'E2E World' }).click()

    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 851 })
      const labels = await page.locator('.world-nav').evaluate((nav) => {
        const rows = Array.from(nav.querySelectorAll('a'))
        const heights = rows.map((a) => a.getBoundingClientRect().height)
        const singleLine = Math.min(...heights)
        return rows
          .map((a, i) => ({
            text: (a.textContent ?? '').trim(),
            clipped: a.scrollWidth > a.clientWidth,
            // A label with no space in it can only have wrapped mid-word.
            brokenMidWord: heights[i]! > singleLine + 1 && !/\s/.test((a.textContent ?? '').trim()),
          }))
          .filter((r) => r.clipped || r.brokenMidWord)
      })
      expect(labels, `nav labels do not fit the rail at ${width}px`).toEqual([])
    }
  })
})
