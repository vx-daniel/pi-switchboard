/**
 * The console's colors: Tokyo Night Storm, from the pi theme `tokyonight-storm.json`.
 *
 * @remarks
 * Kept as data, with no import of pi's code, so the logging module can color the console's log view
 * from it without loading pi's UI. `theme.ts` builds pi's `Theme` from {@link STORM_FOREGROUNDS} and
 * {@link STORM_BACKGROUNDS}; pi's `Theme` constructor checks that every token it requires is
 * there. `''` is the terminal's own default color.
 *
 * @packageDocumentation
 */

import type { ThemeBg, ThemeColor } from '@earendil-works/pi-coding-agent'

/** The palette's named colors. */
export const STORM = {
  bg: '#24283b',
  bgDark: '#1f2335',
  bgPopup: '#1b1e2d',
  bgHighlight: '#292e42',
  bgCustom: '#2c324a',
  bgSuccess: '#164846',
  bgError: '#703438',
  fg: '#c0caf5',
  blue: '#7aa2f7',
  cyan: '#7dcfff',
  teal: '#1abc9c',
  green: '#9ece6a',
  red: '#f7768e',
  redStrong: '#db4b4b',
  yellow: '#e0af68',
  orange: '#ff9e64',
  purple: '#9d7cd8',
  magenta: '#bb9af7',
  comment: '#565f89',
  muted: '#a9b1d6',
  dim: '#8a94c0',
  border: '#3b4261',
  borderAccent: '#3d59a1'
} as const

/** The theme's foreground tokens: pi's own, and the console's (`accent`, `success`, `border`, …). */
export const STORM_FOREGROUNDS = {
  accent: STORM.blue,
  border: STORM.border,
  borderAccent: STORM.borderAccent,
  borderMuted: STORM.border,
  success: STORM.green,
  error: STORM.red,
  warning: STORM.yellow,
  muted: STORM.muted,
  dim: STORM.dim,
  text: '',
  thinkingText: STORM.dim,
  userMessageText: '',
  customMessageText: '',
  customMessageLabel: STORM.magenta,
  toolTitle: '',
  toolOutput: STORM.muted,
  mdHeading: STORM.yellow,
  mdLink: STORM.blue,
  mdLinkUrl: STORM.muted,
  mdCode: STORM.cyan,
  mdCodeBlock: STORM.green,
  mdCodeBlockBorder: STORM.border,
  mdQuote: STORM.muted,
  mdQuoteBorder: STORM.border,
  mdHr: STORM.border,
  mdListBullet: STORM.teal,
  toolDiffAdded: STORM.green,
  toolDiffRemoved: STORM.redStrong,
  toolDiffContext: STORM.muted,
  syntaxComment: STORM.comment,
  syntaxKeyword: STORM.magenta,
  syntaxFunction: STORM.blue,
  syntaxVariable: STORM.fg,
  syntaxString: STORM.green,
  syntaxNumber: STORM.orange,
  syntaxType: STORM.teal,
  syntaxOperator: STORM.cyan,
  syntaxPunctuation: STORM.muted,
  thinkingOff: STORM.border,
  thinkingMinimal: STORM.muted,
  thinkingLow: STORM.blue,
  thinkingMedium: STORM.cyan,
  thinkingHigh: STORM.magenta,
  thinkingXhigh: STORM.red,
  bashMode: STORM.green
} as const satisfies Partial<Record<ThemeColor, string>>

/** The theme's background tokens. */
export const STORM_BACKGROUNDS = {
  selectedBg: STORM.bgHighlight,
  userMessageBg: STORM.bgDark,
  customMessageBg: STORM.bgCustom,
  toolPendingBg: STORM.bgPopup,
  toolSuccessBg: STORM.bgSuccess,
  toolErrorBg: STORM.bgError
} as const satisfies Partial<Record<ThemeBg, string>>
