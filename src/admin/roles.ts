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

/** Says whether the operator is an active member of a team (`org/slug`, lowercase). */
export type TeamCheck = (team: string) => Promise<boolean>

/**
 * Says whether a list admits an operator: by their login first, then by each team it names, in
 * order, asking GitHub only until one admits them.
 *
 * @param principals - the logins and teams
 * @param login - the operator's GitHub login
 * @param memberOf - asks GitHub about one team
 * @returns whether the list names their login or a team they are in
 */
async function admits(
  principals: readonly string[],
  login: string,
  memberOf: TeamCheck
): Promise<boolean> {
  const listed = principals.map((principal) => principal.toLowerCase())
  if (listed.includes(login.toLowerCase())) return true
  for (const team of listed.filter((principal) => principal.includes('/'))) {
    if (await memberOf(team)) return true
  }
  return false
}

/**
 * Gives an operator their role, asking GitHub about a team only when a login alone does not
 * decide: an editor by login needs no team at all.
 *
 * @param lists - the editors and viewers
 * @param lists.editors - who may change settings
 * @param lists.viewers - who may only read
 * @param login - the operator's GitHub login
 * @param memberOf - asks GitHub about one team; its caller decides what a failed check counts as
 * @returns `editor`, `viewer`, or `undefined` when neither list admits them
 */
export async function roleFor(
  lists: { readonly editors: readonly string[]; readonly viewers: readonly string[] },
  login: string,
  memberOf: TeamCheck
): Promise<AdminRole | undefined> {
  if (await admits(lists.editors, login, memberOf)) return 'editor'
  if (await admits(lists.viewers, login, memberOf)) return 'viewer'
  return undefined
}
