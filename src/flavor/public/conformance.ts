/**
 * Type-only: each public module must stand in for what shared code uses of the
 * module it replaces. A missing export fails the build; this also catches a
 * signature that drifts, in `tsc -b`. Nothing here reaches the bundle.
 */
import type * as RealAccount from '../../components/Account'
import type * as RealBrandGlyph from '../../components/BrandGlyph'
import type * as RealBrokerageRow from '../../components/BrokerageRow'
import type * as RealInstallBanner from '../../components/InstallBanner'
import type * as RealSeed from '../../db/seed'
import type * as RealSupabase from '../../db/supabase'
import type * as RealSlots from '../slots'
import type * as RealBackupPolicy from '../../lib/backupPolicy'
import type * as RealBankTransport from '../../lib/bankTransport'
import type * as RealBrand from '../../lib/brand'
import type * as RealBrokerage from '../../lib/brokerage'
import type * as RealMerchantLinks from '../../lib/merchantLinks'
import type * as RealNative from '../../lib/native'
import type * as RealPrefs from '../../lib/prefs'
import type * as RealRuleStore from '../../lib/ruleStore'
import type * as RealSwUpdate from '../../lib/swUpdate'
import type * as RealMerchantRules from '../../sync/merchantRules'
import type * as RealSync from '../../sync/sync'
import type * as PublicBackupPolicy from './backupPolicy'
import type * as PublicBankTransport from './bankTransport'
import type * as PublicBrand from './brand'
import type * as PublicBrandGlyph from './BrandGlyph'
import type * as PublicBrokerage from './brokerage'
import type * as PublicBrokerageRow from './BrokerageRow'
import type * as PublicInstallBanner from './InstallBanner'
import type * as PublicMerchantLinks from './merchantLinks'
import type * as PublicMerchantRules from './merchantRules'
import type * as PublicNative from './native'
import type * as PublicPrefs from './prefs'
import type * as PublicRuleStore from './ruleStore'
import type * as PublicSeed from './seed'
import type * as PublicSettings from './Settings'
import type * as PublicSlots from './slots'
import type * as PublicSupabase from './supabase'
import type * as PublicSwUpdate from './swUpdate'
import type * as PublicSync from './sync'

type Conforms<Public, Real> = [Public] extends [Real] ? true : false
type Expect<T extends true> = T

export type PublicModulesConform = [
  Expect<Conforms<typeof PublicSupabase, Pick<typeof RealSupabase, 'supabase'>>>,
  Expect<Conforms<typeof PublicSeed, Pick<typeof RealSeed, 'seedIfEmpty'>>>,
  Expect<Conforms<typeof PublicSync, Pick<typeof RealSync, 'subscribeSync' | 'initSync' | 'syncNow' | 'hasCloudSession' | 'currentLedgerGeneration'>>>,
  Expect<Conforms<PublicSync.SyncSnapshot, RealSync.SyncSnapshot>>,
  Expect<Conforms<PublicSync.SyncResult, RealSync.SyncResult>>,
  Expect<Conforms<typeof PublicMerchantRules, Pick<typeof RealMerchantRules, 'loadMerchantRules' | 'reloadMerchantRules'>>>,
  Expect<Conforms<typeof PublicRuleStore, Pick<typeof RealRuleStore, 'canSaveRules' | 'ruleUndo' | 'forgetRules' | 'saveRule'>>>,
  Expect<
    Conforms<
      typeof PublicBankTransport,
      Pick<typeof RealBankTransport, 'banksConfigured' | 'bankBlockedCopy' | 'bankClaimCopy' | 'bankErrorCopy' | 'bankInvoke' | 'bankReady' | 'bankRefreshable'>
    >
  >,
  Expect<Conforms<typeof PublicBrokerage, Pick<typeof RealBrokerage, 'brokerageEnabled' | 'syncBrokerages'>>>,
  Expect<Conforms<typeof PublicMerchantLinks, typeof RealMerchantLinks>>,
  Expect<Conforms<typeof PublicBrand, typeof RealBrand>>,
  Expect<Conforms<typeof PublicPrefs, typeof RealPrefs>>,
  Expect<Conforms<typeof PublicSwUpdate, Pick<typeof RealSwUpdate, 'reloadOnUpdate'>>>,
  Expect<Conforms<typeof PublicSettings, Pick<typeof RealAccount, 'Account'>>>,
  Expect<Conforms<typeof PublicInstallBanner, typeof RealInstallBanner>>,
  Expect<Conforms<typeof PublicBrokerageRow, Pick<typeof RealBrokerageRow, 'BrokerageRow'>>>,
  Expect<Conforms<typeof PublicBrandGlyph, typeof RealBrandGlyph>>,
  Expect<Conforms<typeof PublicSlots, typeof RealSlots>>,
  Expect<Conforms<typeof PublicNative, typeof RealNative>>,
  Expect<Conforms<typeof PublicBackupPolicy, typeof RealBackupPolicy>>,
]
