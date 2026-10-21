/**
 * Quota headers as each subscription sent them on 2026-10-21 (#69): a live probe of the
 * maintainer's Claude subscription and ChatGPT Plus login, one call each (PLAN "Quota (#69)"). The
 * names and value formats are the real ones. The identifying headers that came with them are
 * kept, with fake values, so a test can show they are dropped.
 *
 * @packageDocumentation
 */

/** What an Anthropic Claude-subscription response carried. */
export const ANTHROPIC_QUOTA_HEADERS: Readonly<Record<string, string>> = {
  'anthropic-organization-id': 'notarealsecret-org-0000',
  'anthropic-workspace-id': 'notarealsecret-workspace-0000',
  'request-id': 'req_notarealsecret',
  'anthropic-ratelimit-unified-5h-reset': '1792639800',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.0',
  'anthropic-ratelimit-unified-7d-reset': '1792893600',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.47',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': '1792639800',
  'anthropic-ratelimit-unified-status': 'allowed'
}

/** What a Codex (ChatGPT Plus) response carried over SSE. */
export const CODEX_QUOTA_HEADERS: Readonly<Record<string, string>> = {
  'set-cookie': 'notarealsecret=1',
  'x-oai-request-id': 'notarealsecret-request',
  'x-codex-turn-state': 'gAAAAABnotarealsecretturnstate',
  'x-codex-active-limit': 'premium',
  'x-codex-credits-balance': '0',
  'x-codex-plan-type': 'plus',
  'x-codex-primary-reset-after-seconds': '9519',
  'x-codex-primary-reset-at': '1792631639',
  'x-codex-primary-used-percent': '0',
  'x-codex-primary-window-minutes': '300',
  'x-codex-secondary-reset-after-seconds': '496384',
  'x-codex-secondary-reset-at': '1793118505',
  'x-codex-secondary-used-percent': '2',
  'x-codex-secondary-window-minutes': '10080'
}
