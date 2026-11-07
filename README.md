# dsh-closet — 匣

**English** | [简体中文](README.zh.md)

Organize third-party entries in the DeepSeek Harness sidebar into collapsible groups.

**Latest release: 0.1.4.** [Download and release notes](https://github.com/SamLeRiddle/dsh-closet/releases/tag/v0.1.4).

![Expand or collapse groups while keeping access to the original plugin panels](docs/images/sidebar-overview.png)

![Create groups, rename and reorder them, and assign entries through dropdowns](docs/images/settings-assignment.png)

These feature illustrations use Chinese UI labels. The example groups are 常用 (Everyday), 开发 (Development), and 工具 (Tools).

## Features

- Create multiple groups and expand or collapse each one independently. Group headers show the number of currently available entries.
- Open the original plugin panel from a grouped entry. The active entry is highlighted, with an activity indicator when its group is collapsed.
- Keep grouped entries from appearing twice in the sidebar. The underlying plugins continue to work.
- Follow sidebar changes when a third-party plugin is disabled or enabled. Entries return to their saved groups when they become available again.
- Exclude official sidebar entries from the assignment list. Version 0.1.4 fixes their incorrect detection in the English host interface.

## Installation and upgrades

Download a ZIP or TGZ from the [release page](https://github.com/SamLeRiddle/dsh-closet/releases/tag/v0.1.4). The download links are in the release description.

- **ZIP:** extract the archive and install its `dsh-closet` directory as a local DSH bundle.
- **TGZ:** install the archive through the plugin manager for your DSH environment.

For Windows Desktop, use its bundled CLI or the plugin manager available in your installed version, and select the `desktop` profile. Executable paths depend on your installation. Fully restart DSH when required by the host.

Back up `<DSH_HOME>/config/dsh-closet.json` before upgrading. The configuration format remains version 1, so existing valid configurations need no migration. If an older version assigned official entries to a group, move them outside the group before upgrading. This release does not automatically remove existing records.

## Configuration

Open DSH settings and select **匣**. The plugin settings interface is currently in Chinese.

- Create, rename, reorder, or delete groups. Deleting a group returns its members to the ungrouped sidebar.
- Use the dropdown beside each entry to assign it to a group or return it to the ungrouped sidebar.
- Newly discovered entries start outside all groups.

Changes appear immediately and are saved locally to `<DSH_HOME>/config/dsh-closet.json`, defaulting to `~/.dsh/config/dsh-closet.json`. Saves run in sequence, and pending edits are combined into the latest configuration. Failed saves keep your current edits and offer a retry. Refreshing the page reloads the configuration from disk.

A default configuration is created only when the file is missing. Temporary read failures, including permission or file-access errors, are reported without moving or overwriting the original file. Invalid JSON is backed up before rebuilding the configuration. Existing `.broken` backups are kept, with later backups named `.broken.1` and so on. If the backup fails, the original file is preserved and the error is reported.

## API route prefix

The default prefix is `/closet`. Override it in your profile’s `cordis.patch.yml`:

```yaml
- id: closet
  config:
    routePrefix: /custom
```

Restart DSH and refresh the page. Both the host and the client then use the same endpoint: `/custom/api/config` in this example. Nested paths such as `/tools/closet` are supported, as is `/`, which maps to `/api/config`.

## Compatibility and limitations

The plugin registers its own sidebar rows, hides the original rows for grouped entries, and redirects clicks to the original panels. It depends on the host’s current sidebar DOM, icons, and labels.

- **The plugin UI is still in Chinese.** Excluding official English sidebar entries was verified in the Windows environment listed below; this does not mean full English or multilingual localization.
- Entries are identified by their displayed labels. Entries with identical labels cannot be reliably distinguished. Renaming an entry or changing the host language may require reassigning it. Groups themselves use separate IDs and can share the same name.
- Menu entries and entries identified as official rows, including some third-party entries using the host’s default icon, are excluded from grouping.
- Changes to the host sidebar may require a compatibility update.

## Validation

- All 23 Node regression tests passed. Run `npm test`. The full check used in the release environment was `node --test --test-isolation=none tests/*.test.mjs`.
- The runtime code matches the Windows-tested 0.1.3 build r2; version 0.1.4 updates the release version and documentation. The reported environment was Windows 11 Pro 10.0.26300 x64 with DSH Desktop 0.2.2-rc.1.
- The Windows report covers official-entry exclusion in Chinese and English, an English cold start, multiple groups, plugin enable/disable behavior, configuration saving, retries, and recovery.

See the [Windows validation notes](WINDOWS-VALIDATION.md) (Chinese) for the tested scope and file fingerprints.

## Files

- `lib/index.js`: host-side configuration storage and the same-origin JSON endpoint.
- `lib/ui.js`: sidebar entries and settings UI.
- `lib/client.js`: empty implementation.
- `tests/`: regression tests for configuration, save ordering, route prefixes, dynamic entries, Esc cancellation, and official-entry detection.

## License

[MIT](LICENSE)
