import type { ProfileBilling, ProfileLogin } from '../../../shared/types'

/** A Claude profile's login state (ProfileLogin) in a few words. */
export const LOGIN_TEXT: Record<ProfileLogin, string> = {
  signedIn: 'Signed in',
  keyOrGateway: 'Uses a key or gateway',
  notSignedIn: 'Not signed in',
  unknown: 'Unknown (macOS Keychain)',
  folderMissing: 'Folder not found',
}

/** Who pays for a profile, as its select says it. */
export const BILLING_LABEL: Record<ProfileBilling, string> = {
  own: 'Billing: my account',
  company: 'Billing: my company',
}
