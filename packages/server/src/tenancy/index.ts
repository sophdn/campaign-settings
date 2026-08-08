/** Public surface of the tenancy seam. */
export { createTenancy } from './service'
export { NotAMemberError, OwnerCannotLeaveError } from './lifecycle'
export {
  ForbiddenError,
  type MemberView,
  type PendingTransfer,
  type TenancyService,
  type WorldView,
} from './types'
