/**
 * What a signed-in operator may do in the admin UI (#367): `editor` (change settings) or `viewer`
 * (read only), from the `adminUi.editors` and `adminUi.viewers` lists.
 *
 * @remarks
 * A list entry is a GitHub login (`alice`) or a team as `org/slug` (`my-org/ops`), compared without
 * case, as GitHub compares them. Someone both lists admit is an editor. Someone neither admits gets
 * no role and no session.
 *
 * @packageDocumentation
 */

/** An operator's role. */
export type AdminRole = 'editor' | 'viewer'

/**
 * Says whether a list names a team, which needs `GET /user/teams` to check.
 *
 * @param principals - the logins and teams
 * @returns whether any entry is `org/slug`
 */
export function listsTeams(principals: readonly string[]): boolean {
  return principals.some((principal) => principal.includes('/'))
}

/**
 * Says whether a list admits an operator.
 *
 * @param principals - the logins and teams
 * @param login - the operator's GitHub login
 * @param teams - the operator's teams as lowercase `org/slug`
 * @returns whether the list names their login or one of their teams
 */
function admits(principals: readonly string[], login: string, teams: ReadonlySet<string>): boolean {
  const shownLogin = login.toLowerCase()
  return principals.some((principal) => {
    const entry = principal.toLowerCase()
    return entry.includes('/') ? teams.has(entry) : entry === shownLogin
  })
}

/**
 * Gives an operator their role.
 *
 * @param lists - the editors and viewers
 * @param lists.editors - who may change settings
 * @param lists.viewers - who may only read
 * @param login - the operator's GitHub login
 * @param teams - their teams as lowercase `org/slug`; empty when no list names a team
 * @returns `editor`, `viewer`, or `undefined` when neither list admits them
 */
export function roleFor(
  lists: { readonly editors: readonly string[]; readonly viewers: readonly string[] },
  login: string,
  teams: readonly string[]
): AdminRole | undefined {
  const teamSet = new Set(teams)
  if (admits(lists.editors, login, teamSet)) return 'editor'
  if (admits(lists.viewers, login, teamSet)) return 'viewer'
  return undefined
}
