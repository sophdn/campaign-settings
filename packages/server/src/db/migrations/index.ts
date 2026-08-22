import type { Migration } from 'kysely/migration'
import * as init from './0001_init'
import * as pcsDmOnly from './0002_pcs_dm_only'
import * as worldSlug from './0003_world_slug'
import * as entityVisibility from './0004_entity_visibility'
import * as classTableInheritance from './0005_class_table_inheritance'
import * as accountEmail from './0006_account_email'
import * as passwordResetTokens from './0007_password_reset_tokens'
import * as sessionMetadata from './0008_session_metadata'
import * as usernameCaseInsensitive from './0009_username_case_insensitive'
import * as worldInvitations from './0010_world_invitations'
import * as worldOwnershipTransfer from './0011_world_ownership_transfer'
import * as accountDeletionIntegrity from './0012_account_deletion_integrity'
import * as emailVerification from './0013_email_verification'
import * as entityRelationships from './0014_entity_relationships'
import * as entityPassages from './0015_entity_passages'
import * as mapVisibility from './0016_map_visibility'
import * as foldJunctions from './0017_fold_junctions_into_relationships'
import * as pcPlayerAccount from './0018_pc_player_account'
import * as onePcPerPlayer from './0019_one_pc_per_player'
import * as mediaPrimary from './0020_media_primary'
import * as relationshipProvenance from './0021_relationship_provenance'

/**
 * The append-only migration set — the SINGLE source of DDL. Keys sort
 * lexicographically and define run order; never edit a shipped migration,
 * only add a new one.
 */
export const MIGRATIONS: Record<string, Migration> = {
  '0001_init': { up: init.up, down: init.down },
  '0002_pcs_dm_only': { up: pcsDmOnly.up, down: pcsDmOnly.down },
  '0003_world_slug': { up: worldSlug.up, down: worldSlug.down },
  '0004_entity_visibility': { up: entityVisibility.up, down: entityVisibility.down },
  '0005_class_table_inheritance': {
    up: classTableInheritance.up,
    down: classTableInheritance.down,
  },
  '0006_account_email': { up: accountEmail.up, down: accountEmail.down },
  '0007_password_reset_tokens': {
    up: passwordResetTokens.up,
    down: passwordResetTokens.down,
  },
  '0008_session_metadata': { up: sessionMetadata.up, down: sessionMetadata.down },
  '0009_username_case_insensitive': {
    up: usernameCaseInsensitive.up,
    down: usernameCaseInsensitive.down,
  },
  '0010_world_invitations': { up: worldInvitations.up, down: worldInvitations.down },
  '0011_world_ownership_transfer': {
    up: worldOwnershipTransfer.up,
    down: worldOwnershipTransfer.down,
  },
  '0012_account_deletion_integrity': {
    up: accountDeletionIntegrity.up,
    down: accountDeletionIntegrity.down,
  },
  '0013_email_verification': { up: emailVerification.up, down: emailVerification.down },
  '0014_entity_relationships': {
    up: entityRelationships.up,
    down: entityRelationships.down,
  },
  '0015_entity_passages': { up: entityPassages.up, down: entityPassages.down },
  '0016_map_visibility': { up: mapVisibility.up, down: mapVisibility.down },
  '0017_fold_junctions_into_relationships': {
    up: foldJunctions.up,
    down: foldJunctions.down,
  },
  '0018_pc_player_account': { up: pcPlayerAccount.up, down: pcPlayerAccount.down },
  '0019_one_pc_per_player': { up: onePcPerPlayer.up, down: onePcPerPlayer.down },
  '0020_media_primary': { up: mediaPrimary.up, down: mediaPrimary.down },
  '0021_relationship_provenance': {
    up: relationshipProvenance.up,
    down: relationshipProvenance.down,
  },
}
