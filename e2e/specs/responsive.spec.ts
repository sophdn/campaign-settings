import { type Page, expect, test } from '@playwright/test'
import { login, openEntityEditor } from '../fixtures'

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
    await openEntityEditor(page)
    await page.getByLabel('Description').fill(LONG_BODY)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    const entityUrl = page.url()

    const surfaces: [string, string][] = [
      ['dashboard', worldUrl],
      ['wiki', `${worldUrl}/wiki`],
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
    // The rail must not collapse into a stacked block: doing so puts a
    // full-height list of links above every screen, so tapping an entity kind
    // appears to do nothing until you scroll past the nav.
    //
    // Only ABOVE the breakpoint now. Below 30rem there is no rail at all — it
    // is a drawer, which the test below drives.
    await login(page, 'owner')
    await page.getByRole('link', { name: 'E2E World' }).click()
    const worldUrl = page.url().replace(/\/$/, '')
    await page.goto(`${worldUrl}/npc`)

    const rail = page.locator('.world-nav').first()
    const content = page.locator('.world-content')

    let previousRail = Number.POSITIVE_INFINITY
    for (const width of [1280, 768, 600, 481]) {
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
      expect(contentBox.width, `content column is usable at ${width}px`).toBeGreaterThan(150)
      expect(
        contentBox.width,
        `content gets more width than the rail at ${width}px`,
      ).toBeGreaterThan(railBox.width)
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

    // Above the breakpoint only — below it the labels sit in a drawer with the
    // whole screen to spend, and the rail is not rendered at all.
    for (const width of [1280, 768, 600, 481]) {
      await page.setViewportSize({ width, height: 851 })
      const labels = await page
        .locator('.world-nav')
        .first()
        .evaluate((nav) => {
          const rows = Array.from(nav.querySelectorAll('a'))
          const heights = rows.map((a) => a.getBoundingClientRect().height)
          const singleLine = Math.min(...heights)
          return rows
            .map((a, i) => ({
              text: (a.textContent ?? '').trim(),
              clipped: a.scrollWidth > a.clientWidth,
              // A label with no space in it can only have wrapped mid-word.
              brokenMidWord:
                heights[i]! > singleLine + 1 && !/\s/.test((a.textContent ?? '').trim()),
            }))
            .filter((r) => r.clipped || r.brokenMidWord)
        })
      expect(labels, `nav labels do not fit the rail at ${width}px`).toEqual([])
    }
  })

  /**
   * The nav below the breakpoint: a drawer, not a column.
   *
   * The rail used to be permanently visible and narrow on a phone, stealing
   * width from exactly the screens with least of it. Before THAT it stacked,
   * which put a full-height list of links above every screen. Neither happens
   * now — it is hidden, and a hamburger opens it over the page.
   */
  test('the rail becomes a hamburger-opened drawer on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 851 })
    await login(page, 'owner')
    await page.getByRole('link', { name: 'E2E World' }).click()
    const worldUrl = page.url().replace(/\/$/, '')
    await page.goto(`${worldUrl}/npc`)

    // No rail, and the content has the width the rail used to take.
    await expect(page.locator('.world-nav').first()).toBeHidden()
    const toggle = page.getByRole('button', { name: 'World sections' })
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const contentBox = (await page.locator('.world-content').boundingBox())!
    expect(contentBox.width, 'the content gets the width the rail used to take').toBeGreaterThan(
      300,
    )

    // Open it: a real dialog, over the page rather than above it.
    await toggle.click()
    const drawer = page.getByRole('dialog', { name: 'World sections' })
    await expect(drawer).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const drawerBox = (await drawer.boundingBox())!
    expect(drawerBox.x + drawerBox.width, 'the drawer is anchored to the right edge').toBeCloseTo(
      393,
      0,
    )

    // Escape closes it — the shared modal's mechanics, not a second copy.
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // …and so does navigating, so the drawer never covers the page it opened.
    await toggle.click()
    await drawer.getByRole('link', { name: 'Notes' }).click()
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(`${worldUrl}/notes`)
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible()

    await expectNoSidewaysScroll(page, 'notes with the drawer closed @393')
  })
})
