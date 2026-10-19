---
name: release-backend
description: Release a region's bikesy-backend deployment — a new routing data image, new server code, or a rollback — then verify and promote it. Use when asked to deploy or release backend code changes for a region ("deploy the latest backend code to Tahoe", "release the merged adapter fix"), to roll back a region's backend, or when the update-map-data skill hands off a newly published data image.
---

# Release backend

Ship a change to one region's deployed backend, verify it, and promote it. There are three
kinds of release:

- **Data release:** a new routing data image (a digest handed off by the update-map-data
  skill), with the same server code.
- **Code release:** new server code against the region's current data image.
- **Rollback:** go back to a previous deployment.

The repo docs are the source of truth for the mechanics: [README.md § Deploy to
Vercel](../../../README.md#deploy-to-vercel) and [docs/REGIONS.md § Prepare the application
image](../../../docs/REGIONS.md#prepare-the-application-image). This skill picks the
right path for the region and lists the checks and approvals around it.

## 1. Region and deployment settings

Take the region slug from the request, and always pass `--region <slug>` to the scripts.
Read the region's entry in the gitignored `.claude/regions.local.json`. Its deployment keys
are:

```json
{
  "regions": {
    "<slug>": {
      "deploy_method": "cli | git",
      "vercel_account": "<Vercel username the CLI must be logged in as>",
      "vercel_scope": "<team slug>",
      "vercel_project": "<project>",
      "vercel_region": "sfo1",
      "domain": "<public hostname>",
      "deploy_root": "<git method only: the repo directory the Vercel project builds, e.g. .>"
    }
  }
}
```

If the entry or `deploy_method` is missing, ask the user how this region is deployed, then
save the answers. Don't guess from someone else's setup.
- **`cli`:** releases are made with `vercel deploy` from a generated deploy directory, and the
  project isn't driven by Git.
- **`git`:** the Vercel project is connected to this repository and deploys what's merged.

**Check the Vercel account before every Vercel CLI session** (deploy, promote, `vcr
login`, domains, `ls`, `curl`). The CLI keeps one login at a time, and a machine may be used
with several accounts.
- Run `vercel whoami`. It must print the region's `vercel_account`.
- Run `vercel teams ls`. It must list `vercel_scope`.
- If either check fails, **stop**. Ask the user to run `vercel logout` and then `vercel login`
  with the right account; logging in is interactive, so the user has to do it. Then check
  again.
- If `vercel_account` isn't set yet, show the user the current account and ask whether it's
  the right one before saving it.
- Recheck after any pause in which the user may have switched accounts, and before a
  promote or rollback.
- Always pass `--scope <vercel_scope>` explicitly rather than relying on the CLI's current
  team. Rerun `vercel vcr login` after switching accounts, because registry credentials
  belong to the account that created them.

Releases are recorded in `<data_dir>/RUNS.md` (`data_dir` is in the same file): for each,
the region, image digest, `$WORK`, deploy directory or commit, deployment URL, and outcome.
Read it to find the region's current release.

## 2. Make the release

### CLI method

Generate a fresh deploy directory, then deploy it without moving the domain:

```sh
IMG=vcr.vercel.com/<scope>/<project>/routing-data
.venv/bin/python scripts/prepare-release.py --region <slug> --runtime "$WORK/runtime" \
  --image $IMG@sha256:<digest> --vercel-region <vercel_region> --output "$WORK/deploy-v<N>"
vercel link --yes --cwd "$WORK/deploy-v<N>" --scope <scope> --project <project>
vercel deploy --cwd "$WORK/deploy-v<N>" --scope <scope> --prod --skip-domain
```

- **Data release:** use the new digest and the new build's `$WORK`.
- **Code release:** first update the checkout (`git checkout main && git pull`) and run
  `npm test`. Then use the **current** release's digest and `$WORK` from `RUNS.md`.
  `prepare-release.py` checks the local runtime package against the image, so the current
  release's `$WORK/runtime/` must still be on disk. If it rejects the runtime because code
  and data have drifted (for example, an engine patch or a config change that alters the
  data lock), the release needs a data rebuild: use the update-map-data skill.
- The deploy directory is a source snapshot, so generate a new one for every release
  (`deploy-v<N+1>`); never redeploy an old one with new code.

### Git method

Releases go through the repository, so changes reach production by being merged.
- **Code release:** make sure the region's release locks are current (`node
  scripts/lock-source.mjs`, then `npm test` and `npm run verify:release`). Commit them on a
  branch and open a PR for the user. Merging is the release. Never push to the default
  branch yourself.
- **Data release:** the release files under `deploy_root` (the Dockerfile pin and data
  locks) must be regenerated for the new digest, as described in REGIONS.md § Prepare the
  application image. Open that as a PR too. If the docs don't describe how to regenerate this
  region's checked-in release files, stop and ask the user rather than hand-editing digests.
- **After the merge:** find the deployment Vercel built (`vercel ls <project> --scope <scope>`)
  and verify it as below. Whether it's promoted automatically depends on the project's
  settings, so check whether the domain already moved before verifying.

## 3. Verify, then promote

Check the deployment URL before the public domain moves. If the domain already moved (git
method with automatic promotion), check the domain instead, right away.

- `/health` returns `{"status":"ok"}`, and `/bounds` gives the region's service area.
- Every smoke trip in `test/fixtures/smoke-regions.json` routes in every scenario, with an
  elevation profile. Distances should match the last validated build's `smoke-region.json`;
  for a code release, explain any change.
- A request outside the service area returns the out-of-bounds error.

Deployment URLs are usually behind Vercel Deployment Protection, so use `vercel curl <path>
--deployment <url>`. Run it from inside the linked directory; it passes `--cwd` through to
curl, which rejects it.

**Ask before promoting.** Then run `vercel promote <url> --scope <scope>`. After promoting,
check `/health` and one smoke trip on the public domain.

**New projects only:** attach the domain with `vercel domains add <domain> <project>`, then
have the user add the DNS record that `vercel domains verify <domain>` shows. Don't run the
verify before the record exists. If the parent domain has a wildcard record, resolvers
(Vercel's included) can cache the wildcard answer and delay the certificate for the
record's TTL.

## 4. Rollback

1. Find the previous production deployment, in `RUNS.md` or with `vercel ls <project>
   --scope <scope>`.
2. With the user's approval, run `vercel promote <previous deployment URL> --scope <scope>`.
   The domain moves immediately, with no rebuild.
3. Verify the public domain (`/health` and a smoke trip).
4. **Git method:** also open a revert PR for the bad change, or the next merge will redeploy
   it.

Old deployments pull their data image by digest, so never delete an image a rollback target
depends on. Keep at least the current and previous release's images and `$WORK/runtime/`.

## 5. Record

Append the release to `RUNS.md`: date, region, kind (data, code or rollback), method,
digest, `$WORK`, deploy directory or merged commit, deployment URL, verification results,
promotion time, and the rollback target. Note anything that went wrong.

## Approval gates

Stop and ask before each of these:
- deploying, promoting, rolling back, or changing domains;
- opening a release PR;
- deleting images, deployments or workspaces.
