import type { Capability, CaseType } from './types'

export const CAPABILITIES: { id: Capability; label: string; icon: string }[] = [
  { id: 'emergency', label: 'Emergency department', icon: '🏥' },
  { id: 'trauma', label: 'Trauma care', icon: '🩹' },
  { id: 'cardiac', label: 'Cardiac care', icon: '🫀' },
  { id: 'stroke', label: 'Stroke care', icon: '🧠' },
  { id: 'antivenom', label: 'Antivenom', icon: '🐍' },
  { id: 'paediatrics', label: 'Paediatrics', icon: '🧒' },
  { id: 'burns', label: 'Burns', icon: '🔥' },
  { id: 'icu', label: 'ICU', icon: '🛏️' },
  { id: 'obstetric', label: 'Obstetrics', icon: '🤰' },
]

export const CAPABILITY_LABEL = Object.fromEntries(CAPABILITIES.map((c) => [c.id, c.label])) as Record<Capability, string>

export interface CaseTypeMeta {
  label: string
  icon: string
  /** Capability the hospital's permanent profile must list before it is even asked. */
  base: Capability
  /** Question shown to the hospital, which must be answered live for every case. */
  prompt: string
}

export const CASE_TYPES: Record<CaseType, CaseTypeMeta> = {
  cardiac: { label: 'Cardiac', icon: '🫀', base: 'cardiac', prompt: 'Cardiac team and cath-lab / monitoring can receive this patient now' },
  stroke: { label: 'Stroke', icon: '🧠', base: 'stroke', prompt: 'Stroke team and CT / thrombolysis pathway can receive this patient now' },
  trauma: { label: 'Trauma', icon: '🩹', base: 'trauma', prompt: 'Trauma team and resuscitation bay are available now' },
  snakebite: { label: 'Snakebite', icon: '🐍', base: 'antivenom', prompt: 'Antivenom is physically in stock right now (not just on the hospital profile)' },
  burns: { label: 'Burns', icon: '🔥', base: 'burns', prompt: 'Burns unit can receive this patient now' },
  obstetric: { label: 'Childbirth', icon: '🤰', base: 'obstetric', prompt: 'Obstetric team and delivery room are available now' },
  paediatric: { label: 'Child emergency', icon: '🧒', base: 'paediatrics', prompt: 'Paediatric emergency team is available now' },
  other: { label: 'Other', icon: '🚨', base: 'emergency', prompt: 'Emergency department can receive this patient now' },
}

export function requiredCapabilities(type: CaseType, needsIcu: boolean): Capability[] {
  const base = CASE_TYPES[type].base
  return needsIcu && base !== 'icu' ? [base, 'icu'] : [base]
}

/** Live confirmation prompt for one required capability. */
export function confirmationPrompt(type: CaseType, cap: Capability): string {
  if (cap === 'icu') return 'An ICU bed is open right now'
  if (cap === CASE_TYPES[type].base) return CASE_TYPES[type].prompt
  return `${CAPABILITY_LABEL[cap]} is available now`
}

export const DECLINE_REASONS = ['No capacity right now', 'Required specialist unavailable', 'Required resource out of stock', 'Equipment down', 'On diversion', 'Other'] as const
