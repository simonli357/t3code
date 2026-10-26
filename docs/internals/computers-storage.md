# Computers storage views

The Disks and Workspaces & Archives views answer "where is the space, and why is it still there"
for every connected computer. The decisions below are the ones the code alone does not explain.

**A mount table is not a list of disks.** `StorageDisks.ts` sorts mounts before anything is shown:
one volume per block device (a bind mount or second mount is an alias in `mountPaths`), memory and
kernel views and loop-mounted images go to Advanced details, and network mounts become remote
storage with the host and backing path from the mount's source. Physical disks come from `lsblk`
(Linux) or CIM (Windows); a mount whose disk is not reported is kept under a disk that says so.

**Unknown is `null`, never zero.** Every byte count is nullable end to end. Reserves exist only
where the lifecycle tool's capacity configuration declares them, and headroom only where agent work
lives and both numbers are known.

**A request never scans.** Folder sizes come from a cache that one background worker fills, one
folder at a time within an entry and time budget (`StorageMeasure.ts`), and only after a client asked
for the holdings. Measurements are saved in `<state>/computers/storage-sizes.json`, so a restart
does not rescan, and each carries its time. Allocated bytes count a hard-linked file once per
entry; bytes in multiply-linked files are reported as `sharedBytes` because another entry may count
them too, so group totals say they are not exact sums. The lifecycle tool's own allocation estimate
is shown only until a measurement exists, labelled as an estimate.

**What is local is what is charged.** An entry on a network mount, a kept bundle in another
computer's library and a backup repository reached over ssh are listed with their host and `local:
false`. Their bytes are in no disk total. The page lists a bundle once, as the stored one, when two
computers report it. RAM-backed paths (tmpfs mounts inside a job, or links from it into tmpfs) are
attached to their job and excluded from disk totals.

**The lifecycle tool is optional and read, not run.** `StorageLifecycle.ts` reads the files Workenv
installs (job lifecycle records, capacity configuration, library interface, latest backup receipt)
with tolerant schemas; a missing or changed file makes that part unavailable, and the group says
why. T3's own session records and projects keep the Workspaces and Other groups useful without it.
Nothing here deletes, moves or changes anything. `repository_bytes` in a backup receipt is optional:
when the backup tool records it, it is shown; otherwise the repository's occupied bytes are unknown.
