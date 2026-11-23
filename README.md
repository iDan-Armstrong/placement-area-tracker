# SNND Manager

A web page for the Sabine-Neches Navigation District. Staff sign in with their ArcGIS
Online account and can:

* record material placed in each dredged material placement area,
* change a placement area's status,
* view the district's Operations and Real Estate web maps as one map with a layer list,
* view, add and remove the survey files attached to a placement area,
* view the title documents attached to a real estate tract.

Saving updates the capacity fields on a hosted feature layer and adds a row to a log
table. Status changes and file changes are logged the same way.

The repository holds code and logos only. All figures, maps and documents stay in the
ArcGIS Online organization and are read after sign-in.

Developed by Arceneaux Wilson & Cole. Author: Dan Armstrong.

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

Status choices and what they write to the layer:

| Choice | `Active` | `Status` | Material entries |
|---|---|---|---|
| Active | Active | A | allowed |
| In use | Active | IU | allowed |
| Inactive | Inactive | IA | blocked |
| Under construction | Offline | UC | blocked |
| Offline | Offline | empty | blocked |

Entry types: material placed, material removed, set the used total, set the total
capacity (for use after a new survey).

Before each save the page reads the area again from the layer, so two people saving at
the same time cannot overwrite each other's totals. If the layer update fails, the log
row is removed again, so the log never records something the layer did not receive.

## Map

The Map page loads the Operations web map and adds any layer that only the Real Estate
web map has. Two modes:

* Placement areas: placement areas can be selected. Real estate tracts are faded and
  cannot be selected.
* Real estate: tracts can be selected. Placement areas are drawn as a dashed gold
  outline on top and cannot be selected.

Selecting a feature in the active mode lists its attached files in the side panel.
`files` in `config.js` controls which of the two layers allow adding and removing files.
In test mode the placement area layer on the map is replaced by the test copy.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page and styles |
| `app.js` | Sign-in, reading and saving, calculations, screen |
| `config.js` | Organization address, app ID, layer, log and web map addresses, file permissions, color thresholds |
| `assets/` | Logos |

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
* One attached file can be at most 10 MB.
* Removing an attached file cannot be undone.
* The map needs the ArcGIS Maps SDK for JavaScript, loaded from js.arcgis.com.
