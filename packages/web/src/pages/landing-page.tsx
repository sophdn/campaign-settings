import { ENTITY_KINDS } from '@campaign-settings/shared'
import { Link } from 'react-router-dom'
import { useConfig } from '../app/config-context'
import { useContactModal } from '../app/contact/contact-modal'
import { Button } from '../components/button'
import { PageHeader } from '../components/page-header'
import { Panel } from '../components/panel'

/**
 * The public front door: what this is, how to get in, and how to use it once
 * you are.
 *
 * Readable with no session, because someone deciding whether to sign up cannot
 * be asked to sign in first. It is the only page that renders at `/` for a
 * signed-out visitor; a signed-in one gets the world picker instead.
 *
 * WHICH DOORS IT OFFERS IS DECIDED BY THE FLAGS, never hardcoded. The launch
 * posture is demo on and public signup off, but that is a deployment choice this
 * page must not bake in: the private instance runs the exact opposite, and a
 * landing page advertising a closed door is worse than one that stays quiet.
 * Every entry point below is conditional for that reason.
 *
 * The getting-started steps name the REAL controls, in the words the app uses
 * ("New world", "Create invitation", "Who can see this"). `e2e/specs/landing.spec.ts`
 * walks each step against the running UI, so a renamed button fails a test
 * rather than quietly turning this page into fiction.
 */
export function LandingPage(): React.JSX.Element {
  const { flags, contactEmail } = useConfig()
  const { openContact } = useContactModal()

  return (
    <div className="login-screen">
      <div className="login-form">
        <PageHeader title="CampaignSettings" />

        <Panel>
          <p>
            A campaign wiki where the game master decides who sees what. Your world holds NPCs,
            towns, factions, and a good deal the players are not supposed to know yet. Everything
            lives in one cross-linked wiki, and each player sees only the entries you have shared
            with them. That check runs in the API, so there is nothing to get around in the browser.
          </p>
        </Panel>

        <Panel ariaLabel="What it does">
          <h2>What it does</h2>
          <ul>
            <li>
              <strong>A wiki of {ENTITY_KINDS.length} kinds of entry</strong> — player characters,
              NPCs, settlements, organizations, locations, deities, languages and the rest. Write{' '}
              <code>[[double brackets]]</code> around another entry&rsquo;s name to link the two,
              and read the result as a page, a backlink list, or a graph.
            </li>
            <li>
              <strong>Per-player visibility.</strong> Every entry is visible to everyone in the
              world, to you alone, or to the specific players you name. Hidden entries are missing
              from the API&rsquo;s answer, so they cannot leak through a graph edge or a search
              result.
            </li>
            <li>
              <strong>Sessions.</strong> Record what happened at the table and which entries it
              touched, on a calendar you define yourself.
            </li>
            <li>
              <strong>Typed relationships.</strong> Record that an NPC belongs to an organization
              once, and both pages show it from their own side.
            </li>
            <li>
              <strong>Maps and images.</strong> Pins stay anchored to the same point of a map at
              every zoom level, and any entry can carry images.
            </li>
            <li>
              <strong>Player contributions.</strong> Players keep their own notes and can suggest
              edits, which you accept or reject. They never write your pages directly.
            </li>
          </ul>
        </Panel>

        <Panel ariaLabel="Getting in">
          <h2>Getting in</h2>
          {flags.demoModeEnabled ? (
            <p>
              <Link to="/demo">Look around the demo</Link> — it signs you in as a read-only guest in
              a small sample world. Nothing to fill in, and nothing you do there can change what the
              next visitor sees.
            </p>
          ) : null}
          {flags.publicSignupEnabled ? (
            <p>
              <Link to="/register">Create an account</Link> and start your own world.
            </p>
          ) : (
            <p>
              Accounts are invitation-only for now. If you want one,{' '}
              {contactEmail ? (
                <a href={`mailto:${contactEmail}`}>email {contactEmail}</a>
              ) : (
                <Button variant="secondary" onClick={openContact}>
                  get in touch
                </Button>
              )}
              .
            </p>
          )}
          {flags.loginEnabled ? (
            <p>
              Already have an account? <Link to="/login">Log in</Link>.
            </p>
          ) : null}
        </Panel>

        <Panel ariaLabel="Getting started">
          <h2>Getting started</h2>
          <p>Once you are in, four steps get a world running with a player in it.</p>
          <ol>
            <li>
              <strong>Create a world.</strong> On <em>Your worlds</em>, type a name under{' '}
              <em>New world</em> and press <em>Create</em>. You land in the new world&rsquo;s wiki.
            </li>
            <li>
              <strong>Add some entries.</strong> Pick a kind from the world&rsquo;s left-hand rail —{' '}
              <em>NPCs</em>, say — type a name, and press <em>Add</em>. In an entry&rsquo;s
              description, wrap another entry&rsquo;s name in <code>[[double brackets]]</code> to
              link them.
            </li>
            <li>
              <strong>Invite a player.</strong> Open <em>Members</em>, then <em>Invite</em>. Naming
              an account pins the invitation to it; leaving the field blank makes a link anyone can
              use once. Copy the link as soon as it appears, because it is shown exactly once.
            </li>
            <li>
              <strong>Decide who sees what.</strong> Every entry has a <em>Who can see this</em>{' '}
              control: <em>Everyone in the world</em>, <em>Only you (GM)</em>, or{' '}
              <em>Only the players you choose</em>. Pick the third and press <em>Grant</em> beside
              each player who should see it.
            </li>
          </ol>
        </Panel>

        <p className="empty-state">
          <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link>
        </p>
      </div>
    </div>
  )
}
