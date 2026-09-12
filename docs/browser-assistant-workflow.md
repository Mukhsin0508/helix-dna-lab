# Use Helix through the browser

Open [Helix](https://helix-dna-lab.higgsfield.app/) and start working. There is no signup, integration key or AllMCP requirement. An assistant needs interactive browser controls and download access in its chosen client; web search alone cannot operate the lab.

1. Choose **DNM1 measurements** in the left controls. On mobile, use **Open figure controls** first.
2. Set **Maximum rows** to 12 and open **Data**. The table contains the 12 selected variants from the published Table S4. **Source** opens their assay, aggregation and provenance.
3. Choose `chr9:128226027:G>A` in **Variant**. Its printed measured value is `0.94`. It is a splice-site selection rate from the published assay, not a newly computed prediction.
4. Return to **All 12 variants**, choose **Measured**, and edit **Figure title**. Edits save automatically. Wait for **Saved in this browser** before reloading or closing.
5. **Export** offers **SVG figure**, **PNG figure**, **Selected data CSV** and **Export JSON**. JSON preserves all data, source metadata and figure settings, even when the figure is filtered.
6. Reopen an exported JSON through **Open data → Open dataset** to continue in another browser or share a reproducible copy.

Browser drafts stay on this device and browser profile. Clearing site data removes them. A browser-operated assistant running in a separate cloud browser has its own storage; download the JSON to retain its work. If browser storage is unavailable, the workspace remains usable and displays an export reminder instead of claiming a save.

Public analysis URLs open source copies without cookies. Editing removes the source parameter and saves a local draft; it does not modify the public record. Private server analyses cannot be opened by this anonymous workspace.

Example request:

> Open Helix's DNM1 measurements, inspect the source and all 12 values, then show chr9:128226027:G>A. Title the figure “DNM1 splicing measurements” and export the SVG and complete JSON.

See [release checks](no-signup-release.md) for actual browser verification. Live AlphaGenome inference and comparison against matching experimental endpoints remain unfinished scientific work.
