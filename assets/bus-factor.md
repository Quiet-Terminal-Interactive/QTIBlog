# We Gave Ourselves a Bus Factor (And Immediately Regretted It)

Here's a fun thought experiment: if you got hit by a bus tomorrow, could anyone else on your team log into your server and restart the thing that's on fire?

For us, the honest answer was no. Everything lived behind SSH keys only Kohan had, on a VPS only Kohan understood, running a topology that existed entirely in Kohan's head. Very efficient. Extremely bus-unsafe.

So we set out to fix that. What followed was two servers, one from-scratch control panel install, six services dragged kicking and screaming into Docker, and a genuine near-miss with a prodution database.

Here's how it went.

---

## The Plan Was Simple

Get a GUI on both VPSes so a non-technical teammate could see what's running, restart it, and check logs without needing to know what `iptables -L DOCKER -n` means or why it lies to you.

CyberPanel for anything web-facing (domains, SSL, reverse proxying). Portainer for anything running in Docker. Point, click, restart. That was the whole pitch.

We briefly considered Proxmox, because we're contractually obligated to consider Proxmox for everything. Then we remembered it's a hypervisor and this is a VPS, you can't virtualize inside someone else's virtualization without asking very nicely, and Fasthosts doesn't do nested virtualization. Moving on.

---

## Server 1: The Easy One

VPS 2 was fresh and empty, no opinions about anything. We hardened SSH (custom port, no root login, fail2ban, the works), installed CyberPanel, dropped Docker and Portainer on top, and called it done in an afternoon.

The only real speed bump: Portainer's admin container quietly punched its own hole through the firewall, bypassing every firewalld rule we'd written, because Docker manages its own iptables chains and does not care about your feelings on the matter.

```
sudo iptables -L DOCKER -n
```

Lesson filed away for later. We had no idea how much we'd need it.

---

## Server 2: The One With Feelings

VPS 1 had six live services, several of which we couldn't just switch off, one of which turned out to be squatting on the exact port CyberPanel's installer wanted.

The installer's own dependency, `nghttp2-proxy`, ships with a sample config that defaults to binding port 3000. Our `vault` service was already sitting there. CyberPanel's installer would fail, blame `dpkg`, retry, fail again, blame `dpkg` again, and repeat this forever. The fix, once we found it, was almost insultingly simple: stop vault, install, done.

We migrated services roughly easiest-to-hardest:

- A UDP game relay, Dockerized in about ten minutes, no drama
- Two portfolio sites, nearly identical, both hit the exact same bug: mounting a single JSON file as a Docker volume means you can't atomically overwrite it, because you're trying to replace a bind-mounted file, not a normal one. `Errno 16: Resource busy`, learned the hard way, fixed by mounting a directory instead
- `vault`, rebound to localhost, proxied behind CyberPane, life is good when the system you're tryig to DOckerize runs in a docker container already

And then there was Gitea.

---

## The Part Where We Nearly Lost Everything

CyberPanel's installer, in the process of setting up its own local MySQL, quietly reset the database user table. This deleted the `gitea` MySQL user. Also, as we discovered slightly too late, the entire `giteadb` database.

We had a backup in progress. It failed mid-dump, at exactly the moment the database access broke, producing an 11GB zip file that was, delightfully, corrupted beyond opening. Truly a backup in the theoretical sense only.

For those unaware of hwo git works, however, here's what saved us: git doesn't need a database to have your commit history. The actual repositories (every commit, every branch, one repo's entire fork lineage) were sitting untouched on disk the whole time, because Gitea stores git data as, well, git data, and only uses the database for the platform layer on top (issues, PRs, users, and critically, the "this repo is a fork of that repo" relationship).

So we did the only reasonable thing: stood up a brand new database, let Gitea build a fresh schema against it, used its built-in repository-adoption tool to re-link the untouched git data, and then went spelunking through its schema and hand-wrote the SQL to restore the fork relationships ourselves.

```sql
UPDATE repository SET is_fork = 1, fork_id = 3 WHERE id = 2;
UPDATE repository SET num_forks = num_forks + 1 WHERE id = 3;
```

Two lines. Absolutely not something Gitea wants you doing. Worked perfectly.

We then Dockerized the whole thing anyway, because apparently we hate ourselves, and immediately hit a second landmine: the container image we picked was two major versions behind what was actually installed, and Gitea (to its credit, correctly) refused to touch the database rather than risk downgrading a schema it didn't recognize.

> `Your database (migration version: 323) is for a newer Gitea, you can not use the newer database for this old Gitea release (299). Gitea will exit to keep your database safe and unchanged.`

If you're going to fail, fail like that. No data touched, no silent corruption, just a very clear "no" and a version number to go check. We matched the image tag, it migrated cleanly, and the fork badge showed up exactly where we'd surgically put it.

---

## The Sweep

Right as we were declaring victory, one more `ls` turned up three sites in `/srv` that had never been part of any conversation, any systemd list, any plan. One was dead weight, one's getting moved by hand later, and one, a tiny Flask survey backend nobody remembered writing down anywhere, was quietly sitting on the open internet with no auth, no HTTPS, and a webhook straight into Discord.

Which is the actual moral of this whole exercise: it's never the thing you planned for. It's the thing sitting in a directory nobody thought to `ls`.

---

## What We Actually Learned

- Docker's firewall rules and firewalld's firewall rules are two separate lies you're telling yourself simultaneously. Check both. Always.
- "It's just a config file" is exactly the sentence that precedes a three-hour detour into git bridge network permissions.
- Back up *before* you touch the thing you're worried about, not right as it's already failing. We got lucky. Luck is not a backup strategy.
- If your platform's database is separate from your actual data, that's not bureaucracy, that's the thing that saves you when the database dies and the data doesn't.
- Run `ls /srv` more than once a year.

Both servers are now fully containerized, documented, backed up, and set up so someone who isn't Kohan could plausibly keep the lights on without a frantic phone call. We now have a real bus factor. We would still prefer nobody test it.
