/**
 * What a signed-in operator may do in the admin UI (#367): `editor` (change settings) or `viewer`
 * (read only), from the `adminUi.editors` and `adminUi.viewers` lists.
 *
 * @remarks
 * A list entry is a GitHub login (`alice`) or a team as `org/slug` (`my-org/ops`), compared without
 * case, as GitHub compares them. Someone both lists admit is an editor. Someone neither admits gets
 * no role and no session. Sign-in records which team admitted the operator, if a team did, so
 * each request can check the role again against the lists the proxy runs with (#383) without
 * asking GitHub: a login or team taken off a list loses its role at once.
 *
 * @packageDocumentation
 */

/** An operator's role. */
export type AdminRole = 'editor' | 'viewer'

/** The editors and viewers, as `adminUi` lists them. */
export interface RoleLists {
  /** Who may change settings. */
  readonly editors: readonly string[]
  /** Who may only read. */
  readonly viewers: readonly string[]
}

/** A role sign-in gave, and the team that admitted the operator; `null` when their login did. */
export interface RoleGrant {
  readonly role: AdminRole
  /** The listed team, lowercase `org/slug`, that admitted them; `null` when their login did. */
  readonly team: string | null
}

/** Says whether the operator is an active member of a team (`org/slug`, lowercase). */
export type TeamCheck = (team: string) => Promise<boolean>

/**
 * Finds what in a list admits an operator: their login first, then each team it names, in
 * order, asking GitHub only until one admits them.
 *
 * @param principals - the logins and teams
 * @param login - the operator's GitHub login
 * @param memberOf - asks GitHub about one team
 * @returns `null` for their login, the team that admits them, or `undefined` for none
 */
async function admittedBy(
  principals: readonly string[],
  login: string,
  memberOf: TeamCheck
): Promise<string | null | undefined> {
  const listed = principals.map((principal) => principal.toLowerCase())
  if (listed.includes(login.toLowerCase())) return null
  for (const team of listed.filter((principal) => principal.includes('/'))) {
    if (await memberOf(team)) return team
  }
  return undefined
}

/**
 * Gives an operator their role at sign-in, asking GitHub about a team only when a login alone
 * does not decide: an editor by login needs no team at all.
 *
 * @param lists - the editors and viewers
 * @param login - the operator's GitHub login
 * @param memberOf - asks GitHub about one team; its caller decides what a failed check counts as
 * @returns the role and the team that gave it, or `undefined` when neither list admits them
 */
export async function roleFor(
  lists: RoleLists,
  login: string,
  memberOf: TeamCheck
): Promise<RoleGrant | undefined> {
  const editor = await admittedBy(lists.editors, login, memberOf)
  if (editor !== undefined) return { role: 'editor', team: editor }
  const viewer = await admittedBy(lists.viewers, login, memberOf)
  if (viewer !== undefined) return { role: 'viewer', team: viewer }
  return undefined
}

/**
 * Checks a session's role again against the lists the proxy runs with (#383): by the login, and
 * by the team that admitted the operator at sign-in. No GitHub call: a change in a team's members
 * shows at the next sign-in, a change in the lists at once.
 *
 * @param lists - the editors and viewers now
 * @param login - the operator's GitHub login
 * @param team - the team that admitted them at sign-in, or `null`
 * @returns their role now, or `undefined` when neither list still admits them
 */
export function currentRole(
  lists: RoleLists,
  login: string,
  team: string | null
): AdminRole | undefined {
  const admits = (principals: readonly string[]): boolean => {
    const listed = principals.map((principal) => principal.toLowerCase())
    return listed.includes(login.toLowerCase()) || (team !== null && listed.includes(team))
  }
  if (admits(lists.editors)) return 'editor'
  if (admits(lists.viewers)) return 'viewer'
  return undefined
}
