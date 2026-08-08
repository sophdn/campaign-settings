import { Navigate, Route, Routes } from 'react-router-dom'
import { AccountPage } from '../pages/account-page'
import { EntityDetailPage } from '../pages/entity-detail-page'
import { DemoPage } from '../pages/demo-page'
import { EntityListPage } from '../pages/entity-list-page'
import { ForgotPasswordPage } from '../pages/forgot-password-page'
import { InvitePage } from '../pages/invite-page'
import { LoginPage } from '../pages/login-page'
import { MapDetailPage } from '../pages/map-detail-page'
import { MapsPage } from '../pages/maps-page'
import { MembersPage } from '../pages/members-page'
import { NotesPage } from '../pages/notes-page'
import { PrivacyPage } from '../pages/privacy-page'
import { RegisterPage } from '../pages/register-page'
import { ResetPasswordPage } from '../pages/reset-password-page'
import { SuggestionsPage } from '../pages/suggestions-page'
import { TermsPage } from '../pages/terms-page'
import { TrashPage } from '../pages/trash-page'
import { VerifyEmailPage } from '../pages/verify-email-page'
import { WikiPage } from '../pages/wiki-page'
import { WorldPickerPage } from '../pages/world-picker-page'
import { WorldSettingsPage } from '../pages/world-settings-page'
import { AppLayout } from './app-layout'
import { RequireAuth } from './require-auth'
import { WorldLayout } from './world-layout'

/** The route tree — split out from App so tests can mount it under a MemoryRouter. */
export function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* The portfolio's front door: signs the visitor in as the shared demo
          player and drops them into the app. Public, obviously. */}
      <Route path="/demo" element={<DemoPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/* Public: an invitee may have no account yet, so this cannot sit behind RequireAuth. */}
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      {/* Public: the link is opened from an email client, often with no session. */}
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      {/* Public and unauthenticated: someone deciding whether to register has
          to be able to read these BEFORE they have an account. */}
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<WorldPickerPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/worlds/:worldId" element={<WorldLayout />}>
            <Route index element={<WikiPage />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="members" element={<MembersPage />} />
            {/* Like /maps, this must precede the `:kind` catch-all, which would
                otherwise read it as an entity kind. */}
            <Route path="settings" element={<WorldSettingsPage />} />
            <Route path="trash" element={<TrashPage />} />
            <Route path="suggestions" element={<SuggestionsPage />} />
            {/* Maps are world-level, not a property of one entity, so they get
                their own index — and these must precede the `:kind` catch-all,
                which would otherwise swallow /maps as an entity kind. */}
            <Route path="maps" element={<MapsPage />} />
            <Route path="maps/:mapId" element={<MapDetailPage />} />
            <Route path=":kind" element={<EntityListPage />} />
            <Route path=":kind/:id" element={<EntityDetailPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
