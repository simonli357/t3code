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

## Storage

Two more views sit beside the overview: **Disks** and **Workspaces & Archives**. Switch between them
at the top of the page, or use **Open disks** and **Open workspaces and archives** in the command
palette. Both work for every connected computer; one whose T3 server is too old says so.

**Disks** lists each computer's physical disks and the volumes on them. Memory, kernel views,
mounted images and other names for the same filesystem are not disks: they, and boot, swap and
recovery partitions, are under **Advanced details**, which starts closed. Storage that another
computer serves is listed apart as **Remote storage**, with that computer and the folder behind it.
For each volume the page shows what the filesystem reports used, what you may still write, the
reserve configured for that computer, and the agent-work headroom that is left of it. Select a
volume to see its folders by size. A figure that could not be measured says so; it is never zero.

**Workspaces & Archives** has three groups, all closed until you open them: **Workspaces** (whole
session jobs: source, temporary files, builds, caches, outputs and evidence), **Archives** (kept
results) and **Other retained project data** (permanent source, original data and installed
runtimes). A header counts its entries and the disk space they take, and says what the
number leaves out: entries not fully measured (the total is then "at least"), files with several
hard links that another entry may also count, and RAM-backed folders, which are listed with their
job and their limit but are not disk space. An entry stored on another computer is listed with that
computer and never counted against this one's disks. Sizes are measured in the background, one
folder at a time, after you open the view, and each shows when it was measured. Open an entry to see
its owner, location, state, expiry and the reason it is retained; a workspace also shows what it is
made of. A group asks the computers for its entries when you open it, newest first; **Load more
entries** asks for more of a long list.

State, expiry, retention reasons and kept results come from the lifecycle tool installed on
the computer (Workenv). Without it a group says what is not reported instead of guessing.

## Find a file

Search covers project folders, Workenv work folders and the kept archive on every connected
computer. It skips caches and system files. Filter by project, computer, and file extension. Each result
shows its computer, path, size and last modified time.

- Search needs the computer online. Results load one page at a time; choose **Show more** to fetch
  the next page.
- A very large project can exceed what the index scans in one pass, and the first time a computer
  reads the kept archive it can take a few minutes; until then the results say they may be
  incomplete.

## Keep, restore, and retry

Open a result to **Keep** it in the kept archive with a one-line reason, or to **Restore** a kept
file into a folder you choose. Restore writes into an empty folder on a computer that can restore
that file; the page says why when none can.

**Activity** lists Workenv jobs, transfers and restores together. A request the page
sends is accepted first and finishes later, so follow its result there. A failed transfer can be
retried when its computer is connected. A job marked
**Active** has a workspace; it counts as running only when Workenv recorded a live process for it.

Keep and restore need Workenv on the computer that performs them. Workenv works without
T3, and Computers only reads its records and starts its commands.

## Choosing a computer for agent work

When you give an agent work and name no computer, it reads every connected computer's numbers
before starting a worker (`t3_recommend_computer`): idle and total CPU threads, free and total
memory, free space on the disk that holds new agent work, running agent sessions, and the
project's ID on that computer (the same repository, by Git remote or `projectKey`). A computer
that does not answer is listed as unreachable with empty numbers, never as idle.

Nothing is ranked and no computer is recommended: the agent chooses from these numbers, what the
task needs and where its data is. Heavy jobs still need the workstation's own capacity check on
the chosen computer.
