# Running T3 Code in the Background

On a Linux host, T3 Code can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest T3 Code release:

```sh
npx t3@latest service install
```

Check whether it is installed:

```sh
npx t3@latest service status
```

Update or repair it:

```sh
npx t3@latest service update
```

Stop it and remove it from startup:

```sh
npx t3@latest service uninstall
```

Updating restarts T3 Code briefly. Let active agent work and terminal commands finish first.

## Set the PATH for Provider Sessions

Provider sessions inherit the background service's `PATH`. Make sure it includes the directories
that contain `bd`, `git`, and your provider CLIs. Add a systemd override:

```sh
systemctl --user edit t3code.service
```

Enter an exact `Environment=` line under `[Service]`, using paths from your machine:

```ini
[Service]
Environment="PATH=/home/you/.local/bin:/home/you/.vite-plus/bin:/usr/local/bin:/usr/bin:/bin"
```

Then reload and restart the service:

```sh
systemctl --user daemon-reload
systemctl --user restart t3code.service
```

This writes a drop-in such as
`~/.config/systemd/user/t3code.service.d/override.conf`. Run
`systemctl --user show t3code.service --property=Environment` to check the value.

You can also override `PATH` for one provider instance in T3 Code's provider settings. Add an
environment variable named `PATH` with the full value that instance should use. The instance value
replaces the service `PATH`; it does not append to it.

## Using It with T3 Connect

T3 Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and T3 Connect are managed separately.

Signing out of T3 Connect does not remove the service. Use `t3 service uninstall` when you no longer
want T3 Code to start in the background.

The background service currently requires Linux with systemd.
