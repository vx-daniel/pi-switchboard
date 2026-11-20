import { currentRole, roleFor, type TeamCheck } from '@proxy/admin/roles'
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
    expect((await roleFor(LISTS, login, teamsOf(active).check))?.role).toBe(role)
  })

  // Catches sign-in not recording what admitted the operator, which each request re-checks
  // (#383): their login as `null`, or the listed team, lowercase.
  test.each([
    { login: 'alice', active: [], grant: { role: 'editor', team: null } },
    { login: 'carol', active: ['my-org/ops'], grant: { role: 'editor', team: 'my-org/ops' } },
    { login: 'bob', active: ['my-org/ops'], grant: { role: 'editor', team: 'my-org/ops' } },
    { login: 'dave', active: ['my-org/readers'], grant: { role: 'viewer', team: 'my-org/readers' } }
  ])('$login is admitted by $grant.team', async ({ login, active, grant }) => {
    expect(await roleFor(LISTS, login, teamsOf(active).check)).toEqual(grant)
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

    expect((await roleFor(LISTS, 'bob', teams.check))?.role).toBe('viewer')
    expect(teams.asked).toEqual(['my-org/ops'])
  })
})

describe('currentRole', () => {
  // Catches a session keeping a role the lists no longer give (#383): a login or team taken off
  // its list loses it at once, one moved to the viewers is a viewer, and a team still listed keeps
  // its members in, compared without case as sign-in compares them.
  test.each([
    { who: 'an editor by login, still listed', login: 'ALICE', team: null, role: 'editor' },
    { who: 'an editor by login, taken off', login: 'carol', team: null, role: undefined },
    { who: 'an editor by team, still listed', login: 'carol', team: 'my-org/ops', role: 'editor' },
    { who: 'an editor by a team taken off', login: 'carol', team: 'my-org/gone', role: undefined },
    { who: 'a viewer by login', login: 'bob', team: null, role: 'viewer' },
    { who: 'a login now only among the viewers', login: 'bob', team: 'my-org/gone', role: 'viewer' }
  ])('$who', ({ login, team, role }) => {
    expect(currentRole(LISTS, login, team)).toBe(role)
  })
})
