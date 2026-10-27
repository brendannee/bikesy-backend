# Review records

This branch keeps the history of every approved access review a deployer has used for a
routing data release. It never merges into `main`, and it doesn't share history with it.

Each commit replaces one region's directory with the review exactly as it was approved for a
build, so `git log -- graph/<slug>` is that region's review history and the newest commit is
the review to carry forward into the next build.

## Layout

```
graph/<slug>/   baseline-access-overrides.json, quality.json, inputs.lock.json,
                target-ways.json, baseline-graph-edges.jsonl
```

These are the same files `scripts/build-region.sh` writes to `$WORK/review`. See
[docs/REGIONS.md](https://github.com/brendannee/bikesy-backend/blob/main/docs/REGIONS.md) on
`main` for what each field means.

## Recording a review

Keep a worktree of this branch next to the main checkout:

```sh
git worktree add ../bikesy-backend-review-records review-records
```

1. Build with `--carry-forward <worktree>/graph/<slug>` so the candidate starts from the
   latest approval.
2. After sign-off, write the approval note into `review_status` in `$WORK/review`.
3. Copy `$WORK/review/*` into `graph/<slug>/` here, replacing the old files.
4. Commit one review per commit. Put the snapshot, data image tag and digest, the
   bikesy-backend commit it was built with, and who approved it in the message.
5. Push this branch.

Commit a record even when the content is unchanged from the last one (only the
`review_status` note differs). The commit is the record that the review was looked at again
for that build.
