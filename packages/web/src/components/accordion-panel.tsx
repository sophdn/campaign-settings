import type { ReactNode } from 'react'
import { Panel } from './panel'

/**
 * A {@link Panel} whose body is folded away behind its own heading.
 *
 * For a SECONDARY section — one that answers a question the reader has not
 * asked yet. An entity page carries several, and each one open by default is
 * how a page you came to read turns into a wall of controls.
 *
 * ## Why `<details>` inside a `<section>`, rather than either alone
 *
 * `<details>`/`<summary>` is the app's existing disclosure idiom — `.nav-tier`
 * in the rail and `.imported-metadata` on an entity page both use it — and a
 * third mechanism would be a third thing to keep in step. It also brings
 * keyboard operation and expanded-state reporting for free.
 *
 * But a bare `<details>` is not a landmark, and these sections are addressed by
 * name in the specs and by anyone navigating by region. So the `<section>`
 * stays, named as before, and the disclosure sits inside it. Nothing that could
 * find "Relationships" before stops finding it; it is simply closed until asked.
 */
export function AccordionPanel({
  title,
  children,
  open = false,
}: {
  /** Names the region AND labels the fold. One string, so they cannot disagree. */
  title: string
  children: ReactNode
  /** Open on first render. Default closed — that is the point of the component. */
  open?: boolean
}): React.JSX.Element {
  return (
    <Panel ariaLabel={title}>
      <details className="accordion" open={open}>
        <summary>
          <h3>{title}</h3>
        </summary>
        <div className="accordion-body">{children}</div>
      </details>
    </Panel>
  )
}
