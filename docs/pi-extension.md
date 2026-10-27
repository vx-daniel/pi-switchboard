# Pi Integration

Install as a pi package to get the `/proxy` command family. It needs the GitHub Packages setup in [Installation](install.md#installation) first:

```bash
pi install npm:@vx-daniel/pi-switchboard
```

## Command family

```
/proxy               Open the settings panel
/proxy start         Start the proxy server
/proxy stop          Stop the proxy started by /proxy (session or detached); one started elsewhere is left running
/proxy restart       Stop, then start the proxy
/proxy status        Show proxy status
/proxy verify        Check the exposure config against pi's models
/proxy models        List the exposed models
/proxy zed-sync      Sync exposed models to Zed's settings.json (--dry-run to preview)
/proxy config        Open the settings panel
/proxy show          Summarize current configuration (the auth token as a short preview)
/proxy token         Show the whole proxy auth token, to copy into a client
/proxy path          Show config file location
/proxy reset         Restore default settings
/proxy help          Show usage
```

`/proxy token` prints the whole secret into the pi session, where it stays in the scrollback; `/proxy show` and the settings panel only ever show a short preview.

## Settings panel

`/proxy` (or `/proxy config`) opens an interactive settings panel where you can configure proxy auth, the [host/origin guard](configuration.md#running-without-a-token), lifetime (detached or session), bind address, port, remote images, body size limit, upstream timeout, log level, model ID format, exposure mode, the `custom` model selection, and Zed sync. Changes are saved to `~/.pi/agent/proxy-config.json` immediately. Restart the proxy to apply changes. A `proxy-config.json` that can't be read or isn't valid JSON is never saved over: the panel doesn't open and says why, until the file is fixed or removed, or `/proxy reset` replaces it with the defaults. With proxy auth off, `/proxy show` says who can use the proxy without a token.
