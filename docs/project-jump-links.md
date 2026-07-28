# Project jump links

T3 Code accepts project jump links in Desktop and on the web:

```text
t3code://open/project?project=scanner
t3code://open/project?project=macs-holding%2Fscanner&action=latest
t3code://open/project?project=configurator&action=new
https://<t3-code-host>/jump?project=t3code&action=new
```

The `project` value is matched case-insensitively against the project title, workspace directory
name, repository name, and `owner/repository` identity. If the repository is available in multiple
environments, T3 Code selects the environment with the most recently updated thread.

`action` is optional:

- omitted or `reveal`: reveal and expand the project in the original sidebar, or select its project
  scope in Sidebar V2;
- `latest`: open the project's most recently updated non-archived thread, falling back to a new
  thread when the project has no thread;
- `new`: open the new-thread composer. The normal composer defaults apply, including the last-used
  environment mode.

For launchers such as wlr-which-key, invoke the URI through the desktop URL opener:

```sh
xdg-open 't3code://open/project?project=scanner&action=latest'
```

Percent-encode repository slashes (`macs-holding%2Fscanner`) when assembling the URI manually.
