import { Link } from 'react-router-dom'
import { PageHeader } from '../components/page-header'
import { Panel } from '../components/panel'

/**
 * The privacy page.
 *
 * Every factual claim here is checkable against the code, and several were
 * written by reading it rather than by describing what a privacy page usually
 * says. If you change what is collected or how long it is kept, change this
 * page in the same commit — a page that overstates what deletion does is worse
 * than no page at all.
 *
 * Anchors for the claims below:
 *   session rows + device label   auth/user-agent.ts, migration 0008
 *   session TTL + reaping         auth/config.ts (30 days), auth/service.ts
 *   last-seen throttle            auth/service.ts LAST_SEEN_REFRESH_MS (5 min)
 *   reset tokens                  auth/reset-tokens.ts, migration 0007 (1 hour)
 *   verification tokens           auth/verification.ts, migration 0013 (24 hours)
 *   invitations                   tenancy/invitations.ts, migration 0010 (7 days)
 *   deletion + cascade            auth/deletion.ts, migration 0012
 */
export function PrivacyPage(): React.JSX.Element {
  return (
    <div className="login-screen">
      <div className="login-form">
        <PageHeader title="Privacy" />

        <Panel>
          <p>
            This is a small site run by one person. It stores what it needs to run your account and
            your campaigns, and nothing else. There is no analytics, no advertising, and no
            third-party tracking of any kind.
          </p>
        </Panel>

        <Panel ariaLabel="What is collected">
          <h2>What is stored about you</h2>
          <ul>
            <li>
              <strong>Your username.</strong> Other members of a world you join can see it, in the
              member list and on suggestions you send. Nothing else about you is shown to them.
            </li>
            <li>
              <strong>Your email address</strong>, if you registered through the site. It is used to
              verify the address and to send password-reset links. It is never shown to other users
              and never shared with anyone.
            </li>
            <li>
              <strong>A hash of your password</strong>, never the password. Passwords are hashed
              with scrypt, so the stored value cannot be turned back into what you typed.
            </li>
            <li>
              <strong>A record of each sign-in</strong>: an opaque session id, when it started, when
              it was last used, and a short device label such as &ldquo;Firefox on Linux&rdquo;. The
              raw User-Agent your browser sends is never stored. It is reduced to that coarse label
              before it reaches the part of the code that writes to the database.
            </li>
            <li>
              <strong>What you write</strong>: your worlds and their contents, your notes and
              characters, and any suggestions you send a GM.
            </li>
          </ul>
          <p>
            The site does not store your IP address, and it sets no cookies other than the one that
            keeps you signed in.
          </p>
        </Panel>

        <Panel ariaLabel="How long it is kept">
          <h2>How long it is kept</h2>
          <ul>
            <li>
              <strong>Sessions</strong> expire 30 days after they start, unless this deployment is
              configured otherwise. Expired rows are deleted the next time you sign in and whenever
              you view your session list, so a dormant account can hold expired rows a while longer
              than their expiry. There is no background job sweeping them.
            </li>
            <li>
              <strong>The last-used time</strong> on a session is refreshed at most once every five
              minutes, so it shows roughly when you were last active rather than every request.
            </li>
            <li>
              <strong>Password-reset links</strong> expire after one hour and work once. Only a
              SHA-256 hash of the link is stored, so someone reading the database cannot use one.
            </li>
            <li>
              <strong>Email verification links</strong> expire after 24 hours and work once, stored
              the same way.
            </li>
            <li>
              <strong>Invitation links</strong> expire after seven days and work once, stored the
              same way.
            </li>
            <li>
              <strong>Everything else</strong> is kept until you delete it or delete your account.
            </li>
          </ul>
        </Panel>

        <Panel ariaLabel="Deletion">
          <h2>Deleting things</h2>
          <p>
            You can end all your other sessions at any time from your account page, and change your
            password or username there.
          </p>
          <p>
            <strong>Leaving a world</strong> deletes your notes and characters in that world, along
            with access to any pages the GM shared with you. The page offers you a download of that
            data first. The world itself is unaffected.
          </p>
          <p>
            <strong>Deleting your account</strong> removes the account and, with it: every session,
            any outstanding reset or verification link, invitations you sent and ones aimed at you,
            every membership, your notes and characters in every world, the per-page access you had
            been granted, and every suggestion you sent. This is a real delete. Nothing is retained
            in a hidden state, and the username becomes available again.
          </p>
          <p>
            Two things survive on purpose. Worlds you belong to are not deleted, because they hold
            other people&rsquo;s work. And a suggestion a GM already accepted stays part of that
            world&rsquo;s content, because accepting it merged the text into the page. The record of
            who proposed it goes with your account; the text stays.
          </p>
          <p>
            If you own a world, deletion is refused until you hand it to another member or delete it
            yourself. Your account page lists which worlds those are. This is deliberate: an account
            deletion should not destroy someone else&rsquo;s campaign as a side effect.
          </p>
          <p>
            Your account page also offers a download of everything you have written across every
            world, before you delete anything.
          </p>
        </Panel>

        <Panel ariaLabel="Contact and changes">
          <h2>Questions</h2>
          <p>
            If you want something removed, or want to know what is stored about you, use the contact
            address on the site and ask.
          </p>
          <p>
            If what this page describes ever changes, the page changes with it. It is written from
            the code, not from a template.
          </p>
        </Panel>

        <p>
          <Link to="/terms">Terms of use</Link> · <Link to="/login">Back to log in</Link>
        </p>
      </div>
    </div>
  )
}
