# Production release-image retention

The operator-installed `deploy/prune-release-images.py` implements **current + two distinct deployed predecessor revisions**, with additional protected recovery references. It never expires backups, logs, data, volumes, or build cache.

`cascade:certified-REV` identifies that revision's image. `cascade:rollback-REV` identifies the image serving **before** REV was attempted; its suffix does not identify its contents. The helper follows those rollback edges using revision labels, not tag-list position or creation-time sorting. An incomplete/self-referential lineage refuses cleanup. Newer staged images, all container image references, unknown/pointer tags, certification/waiver image references and snapshot metadata remain protected. Legacy revision-only recovery metadata conservatively protects both the certified image and its rollback target. Protected references may keep more than three images; the JSON plan reports these exceptions rather than breaking recovery to hit a count.

Default execution is read-only:

```bash
python3 /usr/local/lib/fizzer/prune-release-images.py
```

An explicitly authorized operator may add `--apply`. The helper takes the existing production-directory flock nonblocking, requires a clean checkout matching the healthy running revision/certified/latest image, scans metadata, rechecks the entire inventory, and removes only exact obsolete `cascade:certified-*` / `cascade:rollback-*` tags without force. Every tag on a retained image stays untouched. It verifies both health endpoints, image availability, unchanged container ID/start/restart count and recovery metadata afterward. Missing pre-existing historical references are reported, not reconstructed.

## Installation and deployment integration

This is operator host configuration, not an application cutover. Install the reviewed helper root-owned, mode 0644 at `/usr/local/lib/fizzer/prune-release-images.py`, and the reviewed `deploy/github-actions-host.sh` at the existing root-owned forced-command location, retaining a pre-edit copy. Perform installation under the same nonblocking directory flock and compare exact pre-edit bytes before replacing the host command. Read back installed hashes and execute the inherited-lock path before declaring installation complete.

The host command calls retention **after** successful `remote-update.sh` and exact live verification, including a healthy same-revision retry. It passes its actual inherited lock descriptor (inode-checked and flocked again); an environment flag alone does not bypass locking. The standalone `verify` action exits before retention. Failed application cutovers do not trigger retention. A retention failure after a successful cutover remains a visible Actions failure; it does not roll back the live application.

The installed helper is outside the checkout so `git reset --hard` to a triggering revision cannot erase it. The source files must be kept together when provisioning/updating the operator host command; installing the new command without the helper will fail after deploy verification. No timer or broad Docker prune is needed. The helper's independent dry run is an idempotence/recovery-reference check, not a full restore test.

Focused checks:

```bash
python3 deploy/prune-release-images.test.py
node --test deploy/remote-update.test.mjs
bash -n deploy/github-actions-host.sh
```

The pre-existing two-point retention helper applies to **full cutover snapshots**, not Docker releases. Its deployment caller was removed when routine deployments switched to rolling schema-only preflight; tagged release images were never bounded by that helper. Ordinary `docker image prune -f` only removes dangling images and cannot enforce this tagged-image policy.
