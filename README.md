# Placement Area Tracker

A single web page for recording material placed in dredged material placement areas.
Staff sign in with their ArcGIS Online account, pick an area, type a volume, and save.
The page updates the area's capacity fields on a hosted feature layer and adds a row
to a log table.

The repository holds code only. All figures stay in the ArcGIS Online organization and
are read after sign-in.

## What it calculates

For each placement area:

* Available = Total capacity - Used
* Percent available = Available / Total capacity x 100
* Two dates per area: `Date_` is the survey date behind the capacity figure and only moves
  when the total capacity is set. `LastEntry` is the date of the last material entry.
* Entries into an area that is not marked Active are blocked, except setting its total
  capacity. Entries that exceed capacity are allowed with a warning, and the overage is
  written into the log note.
* Status color: green at or above 66 percent available, red below 33 percent, yellow
  between. Areas marked Offline or Inactive keep their own status.

Entry types: material placed, material removed, set the used total, set the total
capacity (for use after a new survey).

Before each save the page reads the area again from the layer, so two people saving at
the same time cannot overwrite each other's totals. If the layer update fails, the log
row is removed again, so the log never records something the layer did not receive.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page and styles |
| `app.js` | Sign-in, reading and saving, calculations, screen |
| `config.js` | Organization address, app ID, layer and log addresses, color thresholds |

## Setting up for an organization

1. Hosted feature layer of placement areas with these fields: `NAME`, `TotalCapac`,
   `UsedCapac`, `AvailCapac`, `PercCapac`, `Date_`, `Active`, `Status`, `SymbolStat`,
   `Acres`, `LastEntry` (date). Editing on, attribute updates allowed.
2. Hosted table for the log with: `AreaName`, `EntryType`, `Job`, `EnteredBy`, `Note`
   (text), `CubicYards` (double), `EntryDate` (date). Editing on, adds allowed.
3. Developer credentials of type OAuth 2.0 (user authentication) with the page address
   as the redirect URL. Copy the client ID into `config.js`. No client secret is used.
4. Share the layer and the table with the people who will make entries.
5. Put the two service addresses in `config.js`. Set `testMode` to `false` for production.

## Sign-in

OAuth 2.0 authorization code flow with PKCE. The token is kept in the browser tab's
session storage and is gone when the tab closes.

## Limits

* No undo button. To correct a mistake, save a new entry that reverses it.
* The map is a simple drawing of the area shapes, with no zoom.
