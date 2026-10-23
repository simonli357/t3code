# Computers

Open **Computers** from the sidebar or the command palette. No key is assigned by default; bind
`computers.open` in **Settings → Keybindings** to open it from the keyboard.

**Computers** shows every connected environment side by side: CPU and memory with a short recent
history, disk space, and what is using it. Select CPU or memory for the busiest processes, with the
job that launched each one when Workenv recorded it, or a disk for its folders by size. Folder sizes
are measured within a time limit; a folder that reached it shows its size as at least that much. A
computer that is offline keeps its last known numbers under the time they were measured. Each
computer's T3 server must be recent enough to report this; an older one says so.

History fills while the page is open, so a computer nobody has looked at recently shows a short
line. A size or time shown as "Not measured" or "Not verified" was not checked; it is never zero.

## Find a file

Search covers project folders, Workenv work folders and the kept archive on every connected
computer. It skips caches and system files. Filter by project, computer, and file type. Each result
shows its computer, path, size, last modified time, and backup state.

- An offline computer is searched from the file list this browser last saved, and the results say
  when that was.
- A very large project can exceed what the index scans in one pass, and the first time a computer
  reads the kept archive it can take a few minutes; until then the results say they may be
  incomplete.
- **Published** means a copy reached the kept archive. Only a confirmed backup is shown as backed
  up; open the result to see when it was verified. Offline results retain that last-known check.

## Keep, restore, and retry

Open a result to **Keep** it in the kept archive with a one-line reason, or to **Restore** a kept
file into a folder you choose. Restore writes into an empty folder on a computer that can restore
that file; the page says why when none can.

**Activity** lists Workenv jobs, transfers, backups, and restores together. A request the page
sends is accepted first and finishes later, so follow its result there. A failed transfer can be
retried when its computer is connected. Retrying a backup first re-checks the library's backup
records and starts the library backup only for keeps that are still not covered. A job marked
**Active** has a workspace; it counts as running only when Workenv recorded a live process for it.

Keep, restore, and backups need Workenv on the computer that performs them. Workenv works without
T3, and Computers only reads its records and starts its commands.
