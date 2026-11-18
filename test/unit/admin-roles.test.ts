import { listsTeams, roleFor } from '@proxy/admin/roles'
import { describe, expect, test } from 'vite-plus/test'

const LISTS = { editors: ['Alice', 'my-org/Ops'], viewers: ['bob', 'my-org/readers'] }

describe('roleFor', () => {
  // Catches a role given by the wrong list, by a case GitHub ignores, or to someone neither lists.
  test.each([
    ['an editor by login, in another case', 'alice', [], 'editor'],
    ['an editor by team, in another case', 'carol', ['my-org/ops'], 'editor'],
    ['a viewer by login', 'bob', [], 'viewer'],
    ['a viewer by team', 'dave', ['my-org/readers'], 'viewer'],
    ['in both lists: the editor role wins', 'bob', ['my-org/ops'], 'editor'],
    ['a team of the same slug in another org', 'erin', ['other-org/ops'], undefined],
    ['nobody either list names', 'mallory', ['my-org/everyone'], undefined]
  ])('%s', (_case, login, teams, expected) => {
    expect(roleFor(LISTS, login, teams)).toBe(expected)
  })
})

describe('listsTeams', () => {
  // Catches sign-in asking GitHub for teams when only logins are listed (an App not installed on
  // any org would then fail), or not asking when a team is listed.
  test.each([
    [['alice', 'bob'], false],
    [['alice', 'my-org/ops'], true],
    [[], false]
  ])('%j lists a team: %s', (principals, expected) => {
    expect(listsTeams(principals)).toBe(expected)
  })
})
