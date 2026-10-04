# systemd units

Unit files under `systemd/` reach user systemd only through `scripts/install-units.sh`, which relinks, reloads, and restarts every timer because one left running across a unit rename stalls on its next tick with no next elapse; `scripts/setup-mail-watch.test.mjs` enforces this.
The live session launches with `--setting-sources project`, so anything it needs from user settings, auto mode, the deny rules, and effort and thinking, belongs in `systemd/assistant-settings.json`; without auto mode headless writes are denied, without the deny rules credential reads and mail sends are open, and user settings carry the operator's coding rules and hooks, which cost Glissa about 8.7k tokens a session.
