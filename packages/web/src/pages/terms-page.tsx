import { Link } from 'react-router-dom'
import { PageHeader } from '../components/page-header'
import { Panel } from '../components/panel'

/**
 * The terms page.
 *
 * Not legal advice and it does not pretend to be. It is plain-language
 * disclosure of how the service is actually run, consistent with the MIT
 * licence the project ships under. Keep it honest about the fact that this is
 * one person's side project rather than dressing it up as a company.
 */
export function TermsPage(): React.JSX.Element {
  return (
    <div className="login-screen">
      <div className="login-form">
        <PageHeader title="Terms of use" />

        <Panel>
          <p>
            campaign-settings is a personal project, run and paid for by one person. These terms say
            plainly how it works. They are not legal advice and they are not trying to sound like a
            contract.
          </p>
        </Panel>

        <Panel ariaLabel="Using the site">
          <h2>Using the site</h2>
          <ul>
            <li>
              Keep your password to yourself. Anything done with your account is your account.
            </li>
            <li>
              Do not upload anything illegal, or anything you do not have the right to put here.
            </li>
            <li>
              Do not use the site to harass anyone. That includes people in your own campaigns.
            </li>
            <li>
              Do not try to break it, script it, or work around the limits on how many worlds and
              pages an account can create. Those limits exist because this runs on a small server
              that one person pays for. If you need more room, ask.
            </li>
          </ul>
          <p>
            Accounts that ignore this can be suspended or removed. There is no appeals process,
            because there is no support department. There is one person and an email address.
          </p>
        </Panel>

        <Panel ariaLabel="Your content">
          <h2>Your content</h2>
          <p>
            What you write stays yours. Putting it here does not give anyone a licence to it beyond
            what the site needs to show it to the people you have shared it with.
          </p>
          <p>
            Sharing works the way the app describes: a GM decides which pages each player can see,
            and the server enforces that on every read. Anything you mark visible to a player is
            visible to that player. Nothing else is.
          </p>
          <p>
            You can export your own data at any time from your account page, and take it with you.
          </p>
        </Panel>

        <Panel ariaLabel="No warranty">
          <h2>No warranty</h2>
          <p>
            The code is open source under the MIT licence, and the same position applies to the
            hosted site: it is provided as is, with no warranty of any kind. It might go down. A
            deploy might have a bug. The person running it has a day job.
          </p>
          <p>
            <strong>Keep your own backups of anything you would be upset to lose.</strong> Use the
            export on your account page. That is not boilerplate — it is the honest state of a
            service run by one person.
          </p>
        </Panel>

        <Panel ariaLabel="If the service stops">
          <h2>If the service stops</h2>
          <p>
            If this site is going to shut down, the plan is to say so on the site and by email to
            registered addresses, with enough notice to export your worlds, and to keep the export
            working until the last day.
          </p>
          <p>
            The application itself is open source. If the hosted site goes away, you can run your
            own copy from the same code and import what you exported.
          </p>
        </Panel>

        <Panel ariaLabel="Changes">
          <h2>Changes</h2>
          <p>
            If these terms change in a way that affects you, the change will be noted on the site
            rather than applied quietly.
          </p>
        </Panel>

        <p>
          <Link to="/privacy">Privacy</Link> · <Link to="/login">Back to log in</Link>
        </p>
      </div>
    </div>
  )
}
