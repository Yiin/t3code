# Repository-managed skills

The copies in this directory are canonical. Edit them here, then run:

```bash
./skills/install.sh
```

The installer links
`~/.agents/skills/{plan-epic,cook-epic,cook-it,ralph,deploy}` to this checkout.
Plain Claude, Codex, and Kimi sessions then use the same files. Existing real
files or directories are backed up before linking.

The links are absolute, so moving this checkout breaks them. Run the installer
again from the new checkout location to repair the links.
