// Versions restart at 0.1.0 under the pi-switchboard name (#65). The original project's `v4.x`
// tags are still in the history, so the tag prefix changes: semantic-release ignores tags that do
// not match `tagFormat`. The baseline tag `pi-switchboard-v0.0.0` sits on `main` where the
// rename lands, so the first release is 0.1.0.
//
// semantic-release fills `tagFormat` in as a lodash template, so it needs the literal
// `${version}`; it is put together here so it does not read as a mistyped JavaScript template.
const VERSION_PLACEHOLDER = ['$', '{version}'].join('')

export default {
  branches: ['main'],
  tagFormat: `pi-switchboard-v${VERSION_PLACEHOLDER}`,
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        // While on 0.x a breaking change bumps the minor version, never straight to 1.0.0.
        // Removing this rule is how 1.0.0 gets released, deliberately.
        releaseRules: [{ breaking: true, release: 'minor' }]
      }
    ],
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/changelog',
      {
        changelogFile: 'CHANGELOG.md'
      }
    ],
    [
      '@semantic-release/npm',
      {
        // Off until npm trusted publishing is set up for @vx-daniel/pi-switchboard (#59); until
        // then a release is a git tag, a GitHub release and the changelog.
        npmPublish: false,
        pkgRoot: '.'
      }
    ],
    [
      '@semantic-release/github',
      {
        successComment: false,
        failComment: false,
        releasedLabels: false
      }
    ],
    [
      '@semantic-release/git',
      {
        assets: ['package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'],
        // A lodash template, filled in by semantic-release: `<%= %>` interpolates.
        message: 'chore(release): <%= nextRelease.version %> [skip ci]\n\n<%= nextRelease.notes %>'
      }
    ]
  ]
}
