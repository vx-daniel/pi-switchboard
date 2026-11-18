import { roleFor, type TeamCheck } from '@proxy/admin/roles'
import { describe, expect, test } from 'vite-plus/test'

const LISTS = { editors: ['Alice', 'my-org/Ops'], viewers: ['bob', 'my-org/readers'] }

/**
 * Makes a team check that admits the given teams and records each team it is asked about.
 *
 * @param active - the teams, lowercase `org/slug`, the operator is an active member of
 * @returns the check, and the teams it was asked about
 */
function teamsOf(active: readonly string[]): { check: TeamCheck; asked: string[] } {
  const asked: string[] = []
  const check: TeamCheck = async (team) => {
    asked.push(team)
    return active.includes(team)
  }
  return { check, asked }
}

describe('roleFor', () => {
  // Catches a role given by the wrong list, by a case GitHub ignores, or to someone neither lists.
  test.each([
    { who: 'an editor by login, in another case', login: 'alice', active: [], role: 'editor' },
    {
      who: 'an editor by team, in another case',
      login: 'carol',
      active: ['my-org/ops'],
      role: 'editor'
    },
    { who: 'a viewer by login', login: 'bob', active: [], role: 'viewer' },
    { who: 'a viewer by team', login: 'dave', active: ['my-org/readers'], role: 'viewer' },
    {
      who: 'a viewer by login in an editor team',
      login: 'bob',
      active: ['my-org/ops'],
      role: 'editor'
    },
    {
      who: 'a team of the same slug in another org',
      login: 'erin',
      active: ['other-org/ops'],
      role: undefined
    },
    {
      who: 'nobody either list names',
      login: 'mallory',
      active: ['my-org/everyone'],
      role: undefined
    }
  ])('$who', async ({ login, active, role }) => {
    expect(await roleFor(LISTS, login, teamsOf(active).check)).toBe(role)
  })

  // Catches GitHub asked about teams when a login already decides: an editor by login must sign in
  // even when every team check would fail.
  test('asks about no team for an editor by login', async () => {
    const teams = teamsOf([])

    await roleFor(LISTS, 'alice', teams.check)

    expect(teams.asked).toEqual([])
  })

  // Catches a viewer by login never checked for an editor team (no upgrade), or the viewer teams
  // asked about once their login already admits them.
  test('asks a viewer by login about the editor teams only', async () => {
    const teams = teamsOf([])

    expect(await roleFor(LISTS, 'bob', teams.check)).toBe('viewer')
    expect(teams.asked).toEqual(['my-org/ops'])
  })
})
