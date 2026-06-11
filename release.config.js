const isMain = process.env.GITHUB_REF_NAME === 'main';

export default {
  branches: [
    'main',
    { name: 'beta', prerelease: true },
    { name: 'alpha', prerelease: true },
  ],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',

    // Changelog and git commit-back only on main — pre-release branches skip
    // these to avoid version-bump commits that diverge from each other and
    // block future fast-forward promotions (alpha → beta → main).
    ...(isMain ? [
      ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    ] : []),

    ['@semantic-release/npm', { npmPublish: false }],

    ['@semantic-release/exec', {
      prepareCmd: 'npm version ${nextRelease.version} --no-git-tag-version --prefix frontend && npm run build:frontend && bash scripts/build-deb.sh ${nextRelease.version}',
    }],

    ...(isMain ? [
      ['@semantic-release/git', {
        assets: ['CHANGELOG.md', 'package.json', 'frontend/package.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      }],
    ] : []),

    ['@semantic-release/github', {
      assets: [{ path: 'dist/*.deb', label: 'Debian Package (ARM64)' }],
    }],
  ],
};
