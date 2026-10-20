# Releasing `@mesub/node`

A release is a version tag on main. `.github/workflows/publish.yml` checks the
tag, runs every check, waits for a reviewer of the `npm` environment, then
stages the version on npm with provenance. It reaches npm once an owner of the
package approves it with their two-factor code. Nobody runs `npm publish` from
a laptop.

## Once, before the first release

Done by an owner of the npm scope and an admin of Mesub-io (kurosaki-sol).
None of it lives in this repository, so a branch cannot undo it.

### npm

1. **The `@mesub` scope.** `npm view @mesub/node` answers 404 today, which
   does not prove the scope is ours. Sign in on npmjs.com, open
   `https://www.npmjs.com/org/mesub`: create the `mesub` organization if it
   is free (free plan, public packages), or find out who holds it if not.
   Both co-founders as owners, two-factor authentication on both accounts.
2. **The first publish.** npm lets a trusted publisher be set only on a
   package that exists. Done for 0.1.0 with a short-lived token, which the
   workflow no longer reads: delete it on npmjs.com, and the `NPM_TOKEN`
   secret of the `npm` environment. A new package's first version is staged
   by an owner from their machine (`npm stage publish --access public`),
   approved with their two-factor code, then step 3.

3. **The trusted publisher.** On npmjs.com, `@mesub/node`, Settings, Trusted
   Publisher, GitHub Actions: organization `Mesub-io`, repository `node-sdk`,
   workflow `publish.yml`, environment `npm`.
   Allowed actions: leave "publish directly" unticked. The workflow only
   stages, and an owner approves; to a run that tries `npm publish`, npm
   answers `403 OIDC permission denied for this action`. Every release
   after that goes through OIDC, with no token anywhere.
4. **No tokens from then on.** Same page, Publishing access: "Require
   two-factor authentication and disallow tokens".

### GitHub, in Mesub-io/node-sdk settings

5. **The `npm` environment.** Settings, Environments, New environment, `npm`:
    - Required reviewers: kurosaki-sol (and whoever else may release). Leave
      "Prevent self-review" off while the team is two people, or a release
      tagged by the only reviewer could never be approved;
    - Deployment branches and tags: selected, tag pattern `v*`.
6. **Who may tag.** Settings, Rules, Rulesets, New tag ruleset: target
   `v*`, restrict creations, updates and deletions, bypass list
   Repository admin only. A tag is what starts a release; this keeps the
   approval from being the only gate.
7. **The contract test.** The `BACKEND_DEPLOY_KEY` secret, as "Contract test"
   in the README says. Without it the Contract workflow is skipped.

## Each release

1. **Changelog.** In `CHANGELOG.md`, title the section with the version and
   the date, `## 0.2.0 (2026-11-03)`. Under 1.0, a minor version may break the
   API, a patch never does.
2. **Version.** Set it in `package.json` and in `src/version.ts`;
   `test/version.spec.ts` fails if they differ. Move `API_VERSION` there
   only when the release follows a newer API. The first release ships
   0.1.0, already set: nothing to bump.
3. **Merge.** Through a pull request, CI and Contract green.
4. **Tag** main at the merge, once the release is agreed:

    ```sh
    git fetch origin
    git tag -a v0.2.0 origin/main -m v0.2.0
    git push origin v0.2.0
    ```

    The tag must be `v` and the exact version: the workflow refuses anything
    else, and a tag on a commit that is not on main. `v0.2.0-rc.1` publishes
    under the `next` dist-tag, never `latest`.

5. **Approve, twice.** Actions, the Publish run, Review deployments, `npm`:
   the reviewer reads what the run is about to stage, then approves. The run
   stages the version. Then an owner of the package approves it on npm,
   on the package page on npmjs.com or from a terminal:

    ```sh
    npm stage list @mesub/node
    npm stage view <stage-id>      # or npm stage download <stage-id>
    npm stage approve <stage-id>   # asks for the two-factor code
    ```

6. **Check** what reached npm:

    ```sh
    npm view @mesub/node version dist-tags
    npm audit signatures   # in a project that installed it: provenance verified
    ```

    The package page on npmjs.com shows the provenance, linking this commit
    and run.

7. **GitHub release.** From the tag, the changelog section as its notes.

## When it goes wrong

- **The run stopped before staging** (a check failed, the tag was wrong):
  delete the tag (`git push origin :v0.2.0`), fix on main, tag again.
- **A staged version is wrong.** `npm stage reject <stage-id>` (two-factor
  code): nothing reached npm, and the version is free again. Then as above:
  delete the tag, fix on main, tag again.
- **A bad version reached npm.** Never unpublish: publish a fixed patch, then
  `npm deprecate @mesub/node@0.2.0 "Use 0.2.1: <why>"`.
