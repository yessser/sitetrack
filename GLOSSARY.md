# SiteTrack

Tracks a construction company's projects, the work planned on each site, and the materials stored at and moved between those sites.

## Materials

**Material catalogue**:
The single, curated list of every material the company deals in. A store can only hold a material that is in the catalogue.
_Avoid_: Inventory, item list

**Material**:
One catalogue entry, such as "Cement, OPC 50 kg bag", with its name, category and unit. The unit belongs to the material, not to any store.
_Avoid_: Item, product, SKU

**Category**:
A reusable grouping of materials, such as "Binders". A category can sit inside another category as a subcategory.
_Avoid_: Type, group, tag

**Unit**:
How a material's quantity is counted, such as "bag" or "m³", chosen from a shared list. Units are labels only; nothing converts between them.
_Avoid_: UOM, measure
