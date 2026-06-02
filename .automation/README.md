# Astrareach — fresh-start + 30-day auto-commit

This folder contains everything needed to wipe the old git history, push the
project to your own GitHub (`rashisuman76-ops/astrareach`), and have your Mac
auto-commit one small feature per day for 30 days.

## Files

| File | Purpose |
| --- | --- |
| `setup-fresh-repo.sh` | One-time: deletes `.git`, reinits, makes commit #1, sets your remote. |
| `features.json` | The 30 planned commits (id, message, type). Edit freely. |
| `daily-commit.sh` | Picks the next un-applied feature, writes the file(s), commits, pushes. |
| `com.rashi.astrareach.daily.plist` | LaunchAgent that runs `daily-commit.sh` every day at 3:00 PM. |
| `install-schedule.sh` | Installs / uninstalls the LaunchAgent. |
| `.state` *(auto-created)* | Tracks which feature number runs next. |
| `run.log`, `launchd.out.log`, `launchd.err.log` | Logs. |

---

## Step 1 — create the empty GitHub repo

1. Go to <https://github.com/new>
2. Owner: **rashisuman76-ops**, name: **astrareach**
3. **Do NOT** check "Add a README", "Add .gitignore", or "Choose a license" — leave it empty
4. Click **Create repository**

## Step 2 — wipe old history and push the first commit

Open Terminal:

```bash
cd ~/Desktop/PROJECTS/astrareach
bash .automation/setup-fresh-repo.sh
git push -u origin main
```

The push will prompt for auth. Easiest: a Personal Access Token.

- Go to <https://github.com/settings/tokens?type=beta>
- Generate a fine-grained token with **Contents: Read and write** scoped to
  `rashisuman76-ops/astrareach`
- When `git push` asks for a password, paste the token

(Or use the GitHub CLI: `brew install gh && gh auth login`.)

## Step 3 — install the daily schedule

```bash
bash .automation/install-schedule.sh
```

That's it. Every day at **3:00 PM** (whenever the Mac is awake), one feature
from `features.json` will be added, committed, and pushed. After 30 days the
script becomes a no-op.

### Test it once now, without waiting

```bash
launchctl start com.rashi.astrareach.daily
cat .automation/run.log
git log --oneline
```

### Change the time

Edit the `Hour` / `Minute` keys in `com.rashi.astrareach.daily.plist`, then:

```bash
bash .automation/install-schedule.sh        # reload
```

### Stop the schedule

```bash
bash .automation/install-schedule.sh uninstall
```

### Skip / redo a feature

Edit `.automation/.state` — it just contains the next step number (1–30).

---

## Notes

- **Mac must be powered on at the scheduled time.** If it's asleep, launchd
  fires the missed job as soon as it wakes. If it's off, that day is skipped
  (the script resumes on the next run — you don't lose features, just calendar
  days).
- **Auth.** Cache your token with `git config --global credential.helper osxkeychain`
  so push doesn't prompt every day.
- **Commit identity.** The setup script sets `user.name` / `user.email` for
  *this repo only*. Global git config is untouched.
